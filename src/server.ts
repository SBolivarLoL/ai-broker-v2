import { Alpaca } from "@alpacahq/alpaca-ts-alpha";

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const json = (body: unknown, status = 200) => Response.json(body, { status });

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/") return new Response(Bun.file("src/index.html"));
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
      if (url.pathname === "/api/orders" && request.method === "POST") {
        const { symbol: rawSymbol, qty: rawQty, side } = await request.json();
        const symbol = String(rawSymbol ?? "").trim().toUpperCase();
        const qty = Number(rawQty);
        if (!symbol || !Number.isFinite(qty) || qty <= 0 || !["buy", "sell"].includes(side)) {
          return json({ error: "Valid symbol, quantity, and side are required" }, 400);
        }
        return json(await alpaca.trading.orders.market({ symbol, qty, side }));
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Alpaca request failed" }, 502);
    }
  },
});

console.log("AI Broker running at http://localhost:3000");
