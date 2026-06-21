import { Alpaca, TimeFrame } from "@alpacahq/alpaca-ts-alpha";
import { diversificationScore, performancePoints, performanceSummary, stressTests, valueAtRisk95 } from "./analytics";
import { Intent, runPortfolioCopilot } from "./copilot";
import { ledgerSummary, normalizeActivity, type LedgerCategory } from "./ledger";
import { signPreview, verifyPreviewFresh, type Preview } from "./orders";
import { historicalRisk, portfolioHistory, riskSnapshot, rollingTurnover, simulateTrade } from "./risk";
import { runCompanyResearch } from "./research";
import { actorFor, rateLimiter, securityReady, validMutationOrigin } from "./security";
import { searchAssets, type SearchableAsset } from "./search";
import { createStore } from "./store";

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const store = createStore();
const previewSecret = process.env.PREVIEW_SECRET ?? "";
const securityHeaders = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...securityHeaders, "cache-control": "no-store" } });
const MAX_JSON_BYTES = 16_384;

async function requestJson(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new ClientError("Request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new ClientError("Request body is too large", 413);
  try { return JSON.parse(text); }
  catch { throw new ClientError("Request body must be valid JSON", 400); }
}

class ClientError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const accountDto = (account: any) => ({ equity: account.equity, cash: account.cash, buyingPower: account.buyingPower, currency: account.currency, status: account.status });
const positionDto = (position: any) => ({ symbol: position.symbol, qty: position.qty, avgEntryPrice: position.avgEntryPrice, currentPrice: position.currentPrice, marketValue: position.marketValue, unrealizedPl: position.unrealizedPl, unrealizedPlpc: position.unrealizedPlpc });
const orderDto = (order: any) => ({ id: order.id, clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, qty: order.qty, filledQty: order.filledQty, type: order.type, timeInForce: order.timeInForce, status: order.status, submittedAt: order.submittedAt, filledAt: order.filledAt });
const allow = rateLimiter();
let assetCatalog: { expiresAt: number; assets: SearchableAsset[] } | null = null;
let assetCatalogRequest: Promise<SearchableAsset[]> | null = null;
let activitySync: { expiresAt: number; imported: number; truncated: boolean } | null = null;
let activitySyncRequest: Promise<{ imported: number; truncated: boolean }> | null = null;

async function getAssetCatalog() {
  if (assetCatalog && assetCatalog.expiresAt > Date.now()) return assetCatalog.assets;
  assetCatalogRequest ??= alpaca.trading.assets.getV2Assets().then(assets => assets
    .filter(asset => asset._class === "us_equity" && asset.status === "active" && asset.tradable && asset.symbol && asset.name)
    .map(asset => ({ symbol: asset.symbol, name: asset.name!, exchange: asset.exchange })))
    .finally(() => { assetCatalogRequest = null; });
  const assets = await assetCatalogRequest;
  assetCatalog = { assets, expiresAt: Date.now() + 15 * 60_000 };
  return assets;
}

async function syncAccountActivities() {
  if (activitySync && activitySync.expiresAt > Date.now()) return activitySync;
  activitySyncRequest ??= (async () => {
    const activities = [];
    const maximum = 1_000;
    for await (const activity of alpaca.trading.iterateActivities({ direction: "desc", pageSize: 100 })) {
      activities.push(normalizeActivity(activity));
      if (activities.length >= maximum) break;
    }
    store.syncActivities(activities);
    return { imported: activities.length, truncated: activities.length >= maximum };
  })().finally(() => { activitySyncRequest = null; });
  const result = await activitySyncRequest;
  activitySync = { ...result, expiresAt: Date.now() + 30_000 };
  return activitySync;
}

async function reconcileOrders() {
  const orders = await alpaca.trading.orders.getAllOrders({ status: "all", limit: 100 });
  for (const order of orders) {
    if (order.id && order.status) store.reconcileOrder(order.id, order.status);
    if (!order.clientOrderId || !order.status) continue;
    if (order.status === "filled") store.finishRiskReservation(order.clientOrderId, "filled");
    else if (["canceled", "expired", "replaced"].includes(order.status)) store.finishRiskReservation(order.clientOrderId, "canceled");
    else if (order.status === "rejected") store.finishRiskReservation(order.clientOrderId, "rejected");
  }
}

const workingStatuses = new Set(["new", "accepted", "pending_new", "pending_replace", "accepted_for_bidding", "partially_filled", "held", "calculated", "stopped"]);

async function pendingBrokerOrders(orders: any[], candidateSymbol: string, candidatePrice: number) {
  const working = orders.filter(order => workingStatuses.has(String(order.status)));
  const symbols = [...new Set(working.map(order => String(order.symbol)))];
  const prices = new Map(await Promise.all(symbols.map(async symbol => [symbol, symbol === candidateSymbol ? candidatePrice : await alpaca.marketData.getLatestPrice(symbol)] as const)));
  return working.map(order => {
    const qty = Number(order.qty) - Number(order.filledQty ?? 0);
    const price = Number(order.limitPrice ?? order.stopPrice ?? prices.get(String(order.symbol)));
    if (!(qty > 0) || !Number.isFinite(price) || price <= 0 || !["buy", "sell"].includes(order.side)) {
      throw new Error("A working order could not be valued safely");
    }
    return { orderId: order.id, symbol: String(order.symbol), side: order.side as "buy" | "sell", qty, price };
  });
}

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && !validMutationOrigin(request)) return json({ error: "Invalid request origin" }, 403);
    let actor = "anonymous";
    if (url.pathname.startsWith("/api/")) {
      try { actor = actorFor(request); } catch { return json({ error: "Unauthorized" }, 401); }
    }
    try {
      if (url.pathname === "/") return new Response(Bun.file("src/index.html"), { headers: securityHeaders });
      if (url.pathname === "/health") return json({ status: "ok" });
      if (url.pathname === "/ready") {
        if (previewSecret.length < 32 || !securityReady()) return json({ status: "not_ready", error: "Security configuration is incomplete" }, 503);
        await alpaca.trading.account.getAccount();
        return json({ status: "ready", paper: true });
      }
      if (url.pathname === "/api/account") {
        const [account, positions, orders] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "open", limit: 100 }),
        ]);
        return json({ account: accountDto(account), positions: positions.map(positionDto), orders: orders.map(orderDto) });
      }
      if (url.pathname === "/api/quote") {
        const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
        if (!symbol || !/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "Valid symbol is required" }, 400);
        const price = await alpaca.marketData.getLatestPrice(symbol);
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return json({ error: "No valid current price" }, 502);
        return json({ symbol, price, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/assets/search") {
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (query.length < 1 || query.length > 50) return json({ error: "Search must contain 1 to 50 characters" }, 400);
        return json({ query, results: searchAssets(await getAssetCatalog(), query) });
      }
      if (url.pathname === "/api/account/activities" && request.method === "GET") {
        const allowedCategories = new Set<LedgerCategory>(["trade", "dividend", "interest", "fee", "transfer", "corporate_action", "option", "other"]);
        const rawCategory = url.searchParams.get("category") ?? "";
        const category = rawCategory ? rawCategory as LedgerCategory : undefined;
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if ((category && !allowedCategories.has(category)) || !Number.isInteger(limit) || limit < 1 || limit > 200) return json({ error: "Valid activity category and limit from 1 to 200 are required" }, 400);
        const sync = await syncAccountActivities();
        const allActivities = store.activities(5_000);
        return json({ summary: ledgerSummary(allActivities, sync.truncated), activities: store.activities(limit, category), imported: sync.imported, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/portfolio/risk") {
        const [account, positions] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
        ]);
        if (account.equity === undefined || account.cash === undefined) return json({ error: "Account risk data unavailable" }, 502);
        const start = new Date(Date.now() - 90 * 86_400_000);
        const series = await Promise.all(positions.map(async position => ({ marketValue: Number(position.marketValue), closes: (await alpaca.marketData.getStockBarsFor(position.symbol, { timeframe: TimeFrame.Day, start })).map(bar => bar.close).slice(-90) })));
        const history = portfolioHistory(Number(account.equity), Number(account.cash), series);
        const snapshot = riskSnapshot(account.equity, account.cash, positions);
        return json({ ...snapshot, ...historicalRisk(history), ...valueAtRisk95(snapshot.equity, history), diversification: diversificationScore(snapshot.hhi, snapshot.largestPositionPercent), stressTests: stressTests(snapshot.equity, snapshot.cash, snapshot.weights), asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/portfolio/performance") {
        const periods: Record<string, string> = { "1M": "1M", "3M": "3M", "6M": "6M", "1Y": "1A" };
        const period = url.searchParams.get("period") ?? "3M";
        if (!periods[period]) return json({ error: "Period must be 1M, 3M, 6M, or 1Y" }, 400);
        const [history, positions] = await Promise.all([
          alpaca.trading.portfolioHistory.getAccountPortfolioHistory({ period: periods[period], timeframe: "1D", pnlReset: "no_reset" }),
          alpaca.trading.positions.getAllOpenPositions(),
        ]);
        const points = performancePoints(history);
        const attribution = positions.map(position => ({ symbol: position.symbol, marketValue: Number(position.marketValue), unrealizedProfitLoss: Number(position.unrealizedPl), unrealizedReturnPercent: Number(position.unrealizedPlpc) * 100 }))
          .filter(item => Object.values(item).every(value => typeof value === "string" || Number.isFinite(value)))
          .sort((a, b) => b.unrealizedProfitLoss - a.unrealizedProfitLoss);
        return json({ period, summary: performanceSummary(points), points, attribution, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/agent/plans" && request.method === "POST") {
        if (!allow(`${actor}:agent`, 10)) return json({ error: "Agent rate limit exceeded" }, 429);
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable the agent" }, 503);
        const parsed = Intent.safeParse((await requestJson(request)).intent);
        if (!parsed.success) return json({ error: "Intent must be reduce_concentration, balanced_growth, or preserve_capital" }, 400);
        const planId = crypto.randomUUID();
        const output = await runPortfolioCopilot(alpaca, parsed.data);
        store.plan(planId, parsed.data, output);
        store.event("agent.plan.created", actor, { planId, intent: parsed.data, ideas: output.ideas.length });
        return json({ planId, intent: parsed.data, ...output });
      }
      if (url.pathname.startsWith("/api/agent/plans/") && request.method === "GET") {
        const plan = store.getPlan(url.pathname.split("/").pop() ?? "");
        return plan ? json(plan) : json({ error: "Plan not found" }, 404);
      }
      if (url.pathname === "/api/research/runs" && request.method === "POST") {
        if (!allow(`${actor}:research`, 6)) return json({ error: "Research agent rate limit exceeded" }, 429);
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable company research" }, 503);
        const symbol = String((await requestJson(request)).symbol ?? "").trim().toUpperCase();
        if (!/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "A valid stock symbol is required" }, 400);
        const runId = crypto.randomUUID(); const model = process.env.OPENAI_MODEL ?? "gpt-5.5";
        store.startResearch(runId, symbol, model);
        try {
          const result = await runCompanyResearch(alpaca, symbol, runId);
          store.completeResearch(runId, result, result.metrics);
          store.event("research.completed", actor, { runId, symbol, score: result.metrics.overallScore, latencyMs: result.metrics.latencyMs });
          return json(result);
        } catch (error) {
          store.failResearch(runId, error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      if (url.pathname === "/api/research/metrics" && request.method === "GET") return json(store.researchMetrics());
      if (url.pathname.startsWith("/api/research/runs/") && request.method === "GET") {
        const research = store.getResearch(url.pathname.split("/").pop() ?? "");
        return research ? json(research) : json({ error: "Research run not found" }, 404);
      }
      if (url.pathname === "/api/orders/preview" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const { symbol: rawSymbol, qty: rawQty, side, planId } = await requestJson(request);
        const symbol = String(rawSymbol ?? "").trim().toUpperCase();
        const qty = Number(rawQty);
        if (!/^[A-Z.]{1,10}$/.test(symbol) || !Number.isFinite(qty) || qty <= 0 || !["buy", "sell"].includes(side)) {
          return json({ error: "Valid symbol, quantity, and side are required" }, 400);
        }
        if (planId !== undefined && (typeof planId !== "string" || !store.getPlan(planId))) return json({ error: "Valid stored plan id is required" }, 400);
        const [account, positions, asset, price, recentOrders] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol }),
          alpaca.marketData.getLatestPrice(symbol),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
        ]);
        if (!asset.tradable || asset._class !== "us_equity") return json({ error: "Only tradable US stocks and ETFs are supported" }, 400);
        if (typeof price !== "number") return json({ error: "No valid current price" }, 400);
        if (account.equity === undefined || account.cash === undefined) return json({ error: "Account risk data unavailable" }, 502);
        const simulation = simulateTrade({ snapshot: riskSnapshot(account.equity, account.cash, positions), positions, symbol, side, qty, price, dailyTurnover: rollingTurnover(recentOrders) });
        store.event("order.preview", actor, { symbol, side, qty, simulation });
        if (!simulation.allowed) return json({ allowed: false, simulation }, 422);
        const expiresAt = Date.now() + 120_000;
        return json({ allowed: true, simulation, expiresAt, previewToken: signPreview({ symbol, side, qty, price, expiresAt, planId, simulation }, previewSecret) });
      }
      if (url.pathname === "/api/orders" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const { previewToken, idempotencyKey } = await requestJson(request);
        if (typeof previewToken !== "string" || typeof idempotencyKey !== "string" || !/^[\w-]{8,100}$/.test(idempotencyKey)) return json({ error: "Valid preview token and idempotency key are required" }, 400);
        const previous = store.submission(idempotencyKey);
        if (previous) return previous.pending ? json({ error: "Order submission is already processing" }, 409) : json(previous);
        if (!store.reserveSubmission(idempotencyKey)) return json({ error: "Order submission is already processing" }, 409);
        let preview: Preview;
        let freshPrice = 0;
        let freshSimulation;
        try {
          const fresh = await verifyPreviewFresh(previewToken, previewSecret, async intent => {
            const [account, positions, asset, price, recentOrders] = await Promise.all([
              alpaca.trading.account.getAccount(),
              alpaca.trading.positions.getAllOpenPositions(),
              alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: intent.symbol }),
              alpaca.marketData.getLatestPrice(intent.symbol),
              alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
            ]);
            if (!asset.tradable || asset._class !== "us_equity") throw new ClientError("The asset is no longer tradable", 409);
            if (!asset.fractionable && !Number.isInteger(intent.qty)) throw new ClientError("This asset does not support fractional orders", 409);
            if (account.equity === undefined || account.cash === undefined || typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error("Fresh trade validation data is unavailable");
            if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
            if (Math.abs(price / intent.price - 1) > 0.01) throw new ClientError("The price moved more than 1%; review the order again", 409);
            const brokerPending = await pendingBrokerOrders(recentOrders, intent.symbol, price);
            return { account, positions, price, recentOrders, brokerPending };
          });
          preview = fresh.preview;
          freshPrice = fresh.validation.price;
          const reservation = store.reserveRisk(idempotencyKey, { symbol: preview.symbol, side: preview.side, qty: preview.qty, price: freshPrice }, active => {
            const brokerIds = new Set(fresh.validation.brokerPending.map(order => order.orderId));
            const localPending = active.filter(order => !order.orderId || !brokerIds.has(order.orderId));
            const simulation = simulateTrade({
              snapshot: riskSnapshot(Number(fresh.validation.account.equity), Number(fresh.validation.account.cash), fresh.validation.positions),
              positions: fresh.validation.positions,
              symbol: preview.symbol,
              side: preview.side,
              qty: preview.qty,
              price: freshPrice,
              dailyTurnover: rollingTurnover(fresh.validation.recentOrders),
              pendingOrders: [...fresh.validation.brokerPending, ...localPending],
            });
            return { allowed: simulation.allowed, value: simulation };
          });
          if (!reservation.reserved) {
            store.releaseSubmission(idempotencyKey);
            if (reservation.reason === "risk") return json({ allowed: false, simulation: reservation.validation }, 422);
            return json({ error: "Order submission is already processing" }, 409);
          }
          freshSimulation = reservation.validation;
        } catch (error) {
          store.releaseSubmission(idempotencyKey);
          if (error instanceof ClientError) throw error;
          if (error instanceof Error && ["Invalid preview token", "Preview expired"].includes(error.message)) throw new ClientError(error.message, 400);
          throw error;
        }
        store.event("order.confirmed", actor, { symbol: preview.symbol, side: preview.side, qty: preview.qty, price: freshPrice, simulation: freshSimulation, idempotencyKey });
        // Alpaca also enforces this key, covering a lost response after acceptance.
        let order;
        try {
          order = await alpaca.trading.orders.market({ symbol: preview.symbol, qty: preview.qty, side: preview.side, clientOrderId: idempotencyKey });
        } catch (placementError) {
          try { order = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId: idempotencyKey }); }
          catch {
            store.finishRiskReservation(idempotencyKey, "released");
            store.releaseSubmission(idempotencyKey);
            throw placementError;
          }
        }
        if (!order.id) {
          store.finishRiskReservation(idempotencyKey, "released");
          store.releaseSubmission(idempotencyKey);
          throw new Error("Alpaca returned an order without an id");
        }
        if (!store.markRiskSubmitted(idempotencyKey, order.id)) console.error("risk reservation transition failed", { idempotencyKey, orderId: order.id });
        if (order.status === "filled") store.finishRiskReservation(idempotencyKey, "filled");
        else if (order.status === "rejected") store.finishRiskReservation(idempotencyKey, "rejected");
        const receiptId = crypto.randomUUID();
        const response = { ...orderDto(order), receiptId };
        store.completeSubmission(idempotencyKey, order.id, response);
        store.receipt(receiptId, { advisor: actor, plan: preview.planId ? store.getPlan(preview.planId) : null, preview: { ...preview, price: freshPrice, simulation: freshSimulation }, idempotencyKey, orderId: order.id, status: order.status, createdAt: new Date().toISOString() });
        store.event("order.submitted", actor, { orderId: order.id, receiptId, idempotencyKey });
        return json(response);
      }
      if (url.pathname.startsWith("/api/receipts/") && request.method === "GET") {
        const receipt = store.getReceipt(url.pathname.split("/").pop() ?? "");
        return receipt ? json(receipt) : json({ error: "Receipt not found" }, 404);
      }
      if (url.pathname === "/api/receipts" && request.method === "GET") return json(store.receipts());
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof ClientError) return json({ error: error.message }, error.status);
      console.error("request failed", { method: request.method, path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      return json({ error: "The broker service could not complete the request" }, 502);
    }
  },
});

console.log("AI Broker running at http://localhost:3000");
void reconcileOrders().catch(error => console.error("order reconciliation failed", error instanceof Error ? error.message : error));
setInterval(() => void reconcileOrders().catch(error => console.error("order reconciliation failed", error instanceof Error ? error.message : error)), 15_000);
