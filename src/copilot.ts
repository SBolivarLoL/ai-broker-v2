import { Agent, run, tool } from "@openai/agents";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { z } from "zod";

const Idea = z.object({
  symbol: z.string().regex(/^[A-Z.]{1,10}$/),
  action: z.enum(["buy", "hold", "reduce", "watch"]),
  thesis: z.string().min(1).max(300),
  risk: z.string().min(1).max(200),
  invalidation: z.string().min(1).max(200),
  confidence: z.number().int().min(0).max(100),
});

const CopilotOutput = z.object({
  summary: z.string().min(1).max(500),
  ideas: z.array(Idea).length(3),
});

const forbiddenClaims = /\b(guaranteed|risk[- ]free|can't lose|will definitely)\b/i;

export async function runPortfolioCopilot(alpaca: Alpaca) {
  const portfolio = tool({
    name: "get_portfolio",
    description: "Read the paper account's equity, buying power, and current positions. Never returns credentials or account identifiers.",
    parameters: z.object({}),
    timeoutMs: 10_000,
    async execute() {
      const [account, positions] = await Promise.all([
        alpaca.trading.account.getAccount(),
        alpaca.trading.positions.getAllOpenPositions(),
      ]);
      return { equity: account.equity, buyingPower: account.buyingPower, positions: positions.map(({ symbol, qty, avgEntryPrice, currentPrice, marketValue, unrealizedPl, unrealizedPlpc }) => ({ symbol, qty, avgEntryPrice, currentPrice, marketValue, unrealizedPl, unrealizedPlpc })) };
    },
  });

  const latestPrice = tool({
    name: "get_latest_price",
    description: "Get Alpaca's latest available price for one US stock symbol.",
    parameters: z.object({ symbol: z.string().trim().toUpperCase().regex(/^[A-Z.]{1,10}$/) }),
    timeoutMs: 10_000,
    async execute({ symbol }) {
      const price = await alpaca.marketData.getLatestPrice(symbol);
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error("No valid price available");
      return { symbol, price };
    },
  });

  const agent = new Agent({
    name: "Portfolio Copilot",
    model: process.env.OPENAI_MODEL ?? "gpt-5.5",
    modelSettings: { reasoning: { effort: "low" }, text: { verbosity: "low" } },
    instructions: "You are an educational paper-trading portfolio copilot. Call get_portfolio before answering and use get_latest_price only when needed. Return exactly three concise, evidence-bound ideas. Never claim certainty, invent portfolio data, or execute trades. Prefer hold/watch unless tool data supports another action. State limitations plainly.",
    tools: [portfolio, latestPrice],
    outputType: CopilotOutput,
    inputGuardrails: [{
      name: "portfolio-analysis-only",
      runInParallel: false,
      async execute({ input }) {
        const allowed = input === "Analyze my current Alpaca paper portfolio.";
        return { tripwireTriggered: !allowed, outputInfo: { allowed } };
      },
    }],
    outputGuardrails: [{
      name: "no-misleading-financial-claims",
      async execute({ agentOutput }) {
        const text = JSON.stringify(agentOutput);
        const safe = !forbiddenClaims.test(text);
        return { tripwireTriggered: !safe, outputInfo: { safe } };
      },
    }],
  });

  const result = await run(agent, "Analyze my current Alpaca paper portfolio.", { maxTurns: 6 });
  if (!result.finalOutput) throw new Error("Copilot returned no analysis");
  return result.finalOutput;
}
