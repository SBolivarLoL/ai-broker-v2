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
      if (url.pathname === "/api/copilot" && request.method === "POST") {
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable the copilot" }, 503);
        const [account, positions] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
        ]);
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL ?? "gpt-5.5",
            reasoning: { effort: "low" },
            input: [
              { role: "system", content: "You are an educational paper-trading portfolio copilot. Give exactly three concise, evidence-bound ideas. Never claim certainty or execute trades. Prefer hold/watch unless the supplied portfolio data supports another action." },
              { role: "user", content: `Analyze this Alpaca paper portfolio: ${JSON.stringify({ equity: account.equity, buyingPower: account.buyingPower, positions })}` },
            ],
            text: { format: { type: "json_schema", name: "portfolio_copilot", strict: true, schema: {
              type: "object", additionalProperties: false, required: ["summary", "ideas"],
              properties: {
                summary: { type: "string" },
                ideas: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["symbol", "action", "thesis", "risk", "invalidation", "confidence"], properties: {
                  symbol: { type: "string" }, action: { type: "string", enum: ["buy", "hold", "reduce", "watch"] }, thesis: { type: "string" }, risk: { type: "string" }, invalidation: { type: "string" }, confidence: { type: "integer", minimum: 0, maximum: 100 },
                } } },
              },
            } } },
          }),
        });
        const body = await response.json() as { error?: { message?: string }; output?: { content?: { type?: string; text?: string }[] }[] };
        if (!response.ok) return json({ error: body.error?.message ?? "OpenAI request failed" }, response.status);
        const text = body.output?.flatMap(item => item.content ?? []).find(item => item.type === "output_text")?.text;
        if (!text) return json({ error: "Copilot returned no analysis" }, 502);
        return json(JSON.parse(text));
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
