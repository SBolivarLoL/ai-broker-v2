import { expect, test } from "bun:test";
import { evaluateResearch, validResearchOutput, type ResearchEvidence } from "./research";
import { createStore } from "./store";

const sources: ResearchEvidence[] = [
  { id: "market:AAPL", title: "Market", url: "https://example.com/market", asOf: "2026-01-01", category: "market", data: { currentPrice: 200, annualizedVolatilityPercent: 24 } },
  { id: "sec:facts:AAPL", title: "Facts", url: "https://example.com/facts", asOf: "2026-01-01", category: "fundamentals", data: { revenue: { value: 1000 } } },
  { id: "sec:filings:AAPL", title: "Filings", url: "https://example.com/filings", asOf: "2026-01-01", category: "filings", data: { filings: [{ form: "10-K" }] } },
  { id: "news:AAPL", title: "News", url: "https://example.com/news", asOf: "2026-01-01", category: "news", data: { articles: [] } },
];
const claim = (text: string, evidence = ["sec:facts:AAPL"]) => ({ text, evidence });
const output = (overrides: object = {}) => ({
  symbol: "AAPL", companyName: "Apple Inc.", stance: "balanced", executiveSummary: "A balanced view.", summaryEvidence: ["market:AAPL", "sec:facts:AAPL"],
  keyMetrics: [
    { label: "Price", value: 200, unit: "USD", period: "current", evidence: "market:AAPL" },
    { label: "Volatility", value: 24, unit: "%", period: "1 year", evidence: "market:AAPL" },
    { label: "Revenue", value: 1000, unit: "USD", period: "latest filing", evidence: "sec:facts:AAPL" },
  ],
  thesis: [claim("Revenue supports the thesis."), claim("Market data provides context.", ["market:AAPL"])],
  risks: [claim("Valuation can compress.", ["market:AAPL"]), claim("Execution remains uncertain.")], catalysts: [claim("A filing may update the outlook.", ["sec:filings:AAPL"])],
  limitations: ["This is point-in-time public data."], ...overrides,
});

test("research evaluator accepts cited, numerically grounded analysis", () => {
  const metrics = evaluateResearch(output(), sources);
  expect(validResearchOutput(output(), "AAPL", sources)).toBe(true);
  expect(metrics).toMatchObject({ schemaValid: true, citationValidity: 1, citationCoverage: 1, numericGrounding: 1, toolCoverage: 1, overallScore: 100 });
});

test("research evaluator rejects trust failures and scores ungrounded numbers", () => {
  expect(validResearchOutput(output({ summaryEvidence: ["invented"] }), "AAPL", sources)).toBe(false);
  const ungrounded = output({ keyMetrics: [{ label: "Price", value: 999, unit: "USD", period: "current", evidence: "market:AAPL" }, { label: "Volatility", value: 24, unit: "%", period: "1 year", evidence: "market:AAPL" }, { label: "Revenue", value: 1000, unit: "USD", period: "latest", evidence: "sec:facts:AAPL" }] });
  expect(validResearchOutput(ungrounded, "AAPL", sources)).toBe(true);
  expect(evaluateResearch(ungrounded, sources).numericGrounding).toBeLessThan(1);
  expect(validResearchOutput(output({ executiveSummary: "This is a guaranteed winner." }), "AAPL", sources)).toBe(false);
  expect(validResearchOutput(output({ symbol: "MSFT" }), "AAPL", sources)).toBe(false);
});

test("research score exposes missing source-category coverage", () => {
  const metrics = evaluateResearch(output(), sources.slice(0, 3));
  expect(metrics.toolCoverage).toBe(.75);
  expect(metrics.overallScore).toBeLessThan(100);
});

test("research runs and reliability metrics persist", () => {
  const store = createStore(":memory:");
  store.startResearch("run-1", "AAPL", "test-model");
  const metrics = evaluateResearch(output(), sources, { latencyMs: 1200, totalTokens: 500 });
  store.completeResearch("run-1", { research: output(), sources }, metrics);
  expect(store.getResearch("run-1")).toMatchObject({ id: "run-1", symbol: "AAPL", status: "completed", metrics: { overallScore: 100 } });
  expect(store.researchMetrics()).toMatchObject({ totalRuns: 1, successRate: 1, averageScore: 100, averageLatencyMs: 1200, averageTokens: 500 });
  store.close();
});
