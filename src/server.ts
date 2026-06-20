import { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { Intent, runPortfolioCopilot } from "./copilot";
import { signPreview, verifyPreview } from "./orders";
import { riskSnapshot, simulateTrade } from "./risk";
import { createStore } from "./store";

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const store = createStore();
const previewSecret = process.env.PREVIEW_SECRET ?? "";
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function reconcileOrders() {
  const orders = await alpaca.trading.orders.getAllOrders({ status: "all", limit: 100 });
  for (const order of orders) if (order.id && order.status) store.reconcileOrder(order.id, order.status);
}

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/") return new Response(Bun.file("src/index.html"));
      if (url.pathname === "/health") return json({ status: "ok" });
      if (url.pathname === "/ready") {
        if (previewSecret.length < 32) return json({ status: "not_ready", error: "PREVIEW_SECRET is not configured" }, 503);
        await alpaca.trading.account.getAccount();
        return json({ status: "ready", paper: true });
      }
      if (url.pathname === "/api/account") {
        const [account, positions, orders] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "open", limit: 100 }),
        ]);
        return json({ account, positions, orders });
      }
      if (url.pathname === "/api/quote") {
        const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
        if (!symbol) return json({ error: "Symbol is required" }, 400);
        return json({ symbol, price: await alpaca.marketData.getLatestPrice(symbol) });
      }
      if (url.pathname === "/api/portfolio/risk") {
        const [account, positions] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
        ]);
        if (account.equity === undefined || account.cash === undefined) return json({ error: "Account risk data unavailable" }, 502);
        return json({ ...riskSnapshot(account.equity, account.cash, positions), asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/copilot" && request.method === "POST") {
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable the copilot" }, 503);
        return json(await runPortfolioCopilot(alpaca));
      }
      if (url.pathname === "/api/agent/plans" && request.method === "POST") {
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable the agent" }, 503);
        const parsed = Intent.safeParse((await request.json()).intent);
        if (!parsed.success) return json({ error: "Intent must be reduce_concentration, balanced_growth, or preserve_capital" }, 400);
        const planId = crypto.randomUUID();
        const output = await runPortfolioCopilot(alpaca, parsed.data);
        store.plan(planId, parsed.data, output);
        store.event("agent.plan.created", "demo-advisor", { planId, intent: parsed.data, ideas: output.ideas.length });
        return json({ planId, intent: parsed.data, ...output });
      }
      if (url.pathname.startsWith("/api/agent/plans/") && request.method === "GET") {
        const plan = store.getPlan(url.pathname.split("/").pop() ?? "");
        return plan ? json(plan) : json({ error: "Plan not found" }, 404);
      }
      if (url.pathname === "/api/orders/preview" && request.method === "POST") {
        const { symbol: rawSymbol, qty: rawQty, side, planId } = await request.json();
        const symbol = String(rawSymbol ?? "").trim().toUpperCase();
        const qty = Number(rawQty);
        if (!symbol || !Number.isFinite(qty) || qty <= 0 || !["buy", "sell"].includes(side)) {
          return json({ error: "Valid symbol, quantity, and side are required" }, 400);
        }
        if (planId !== undefined && (typeof planId !== "string" || !store.getPlan(planId))) return json({ error: "Valid stored plan id is required" }, 400);
        const [account, positions, asset, price] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol }),
          alpaca.marketData.getLatestPrice(symbol),
        ]);
        if (!asset.tradable || asset._class !== "us_equity") return json({ error: "Only tradable US stocks and ETFs are supported" }, 400);
        if (typeof price !== "number") return json({ error: "No valid current price" }, 400);
        if (account.equity === undefined || account.cash === undefined) return json({ error: "Account risk data unavailable" }, 502);
        const simulation = simulateTrade({ snapshot: riskSnapshot(account.equity, account.cash, positions), positions, symbol, side, qty, price });
        store.event("order.preview", "demo-advisor", { symbol, side, qty, simulation });
        if (!simulation.allowed) return json({ allowed: false, simulation }, 422);
        const expiresAt = Date.now() + 120_000;
        return json({ allowed: true, simulation, expiresAt, previewToken: signPreview({ symbol, side, qty, price, expiresAt, planId, simulation }, previewSecret) });
      }
      if (url.pathname === "/api/orders" && request.method === "POST") {
        const { previewToken, idempotencyKey } = await request.json();
        if (typeof previewToken !== "string" || typeof idempotencyKey !== "string" || !/^[\w-]{8,100}$/.test(idempotencyKey)) return json({ error: "Valid preview token and idempotency key are required" }, 400);
        const previous = store.submission(idempotencyKey);
        if (previous) return previous.pending ? json({ error: "Order submission is already processing" }, 409) : json(previous);
        const preview = verifyPreview(previewToken, previewSecret);
        if (!store.reserveSubmission(idempotencyKey)) return json({ error: "Order submission is already processing" }, 409);
        store.event("order.confirmed", "demo-advisor", { symbol: preview.symbol, side: preview.side, qty: preview.qty, idempotencyKey });
        const order = await alpaca.trading.orders.market({ symbol: preview.symbol, qty: preview.qty, side: preview.side });
        if (!order.id) throw new Error("Alpaca returned an order without an id");
        const receiptId = crypto.randomUUID();
        const response = { ...order, receiptId };
        store.completeSubmission(idempotencyKey, order.id, response);
        store.receipt(receiptId, { advisor: "demo-advisor", plan: preview.planId ? store.getPlan(preview.planId) : null, preview, idempotencyKey, orderId: order.id, status: order.status, createdAt: new Date().toISOString() });
        store.event("order.submitted", "demo-advisor", { orderId: order.id, receiptId, idempotencyKey });
        return json(response);
      }
      if (url.pathname.startsWith("/api/receipts/") && request.method === "GET") {
        const receipt = store.getReceipt(url.pathname.split("/").pop() ?? "");
        return receipt ? json(receipt) : json({ error: "Receipt not found" }, 404);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Alpaca request failed" }, 502);
    }
  },
});

console.log("AI Broker running at http://localhost:3000");
void reconcileOrders().catch(error => console.error("order reconciliation failed", error instanceof Error ? error.message : error));
setInterval(() => void reconcileOrders().catch(error => console.error("order reconciliation failed", error instanceof Error ? error.message : error)), 15_000);
