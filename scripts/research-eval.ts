import { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { runCompanyResearch } from "../backend/features/research/research";

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
const alpaca = new Alpaca({ paper: true, timeoutMs: 15_000 });
const symbols = (process.env.RESEARCH_EVAL_SYMBOLS ?? "AAPL,MSFT,NVDA")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
let failed = false;
for (const symbol of symbols) {
  const result = await runCompanyResearch(alpaca, symbol);
  const pass =
    result.metrics.overallScore >= 90 &&
    result.metrics.citationValidity === 1 &&
    result.metrics.numericGrounding === 1 &&
    result.metrics.toolCoverage >= 0.75;
  console.log(JSON.stringify({ symbol, pass, ...result.metrics }));
  failed ||= !pass;
}
if (failed) process.exitCode = 1;
