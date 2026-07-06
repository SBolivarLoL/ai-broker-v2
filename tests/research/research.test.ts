import { expect, test } from "bun:test";
import { canonicalEvidence } from "../../backend/shared/evidence";
import {
  evaluateResearch,
  validResearchOutput,
  type ResearchEvidence,
} from "../../backend/features/research/research";
import { createStore } from "../../backend/persistence/store";

const source = (
  id: string,
  title: string,
  url: string,
  category: ResearchEvidence["category"],
  data: unknown,
): ResearchEvidence =>
  canonicalEvidence({
    id,
    provider: id.startsWith("sec:") ? "sec" : "alpaca",
    sourceId: id,
    category,
    authority: id.startsWith("sec:")
      ? "official"
      : category === "news"
        ? "licensed_provider"
        : "regulated_broker",
    claimStatus: id.startsWith("sec:")
      ? "official_record"
      : category === "news"
        ? "media_signal"
        : "broker_observation",
    title,
    url,
    asOf: "2026-01-01",
    retrievedAt: "2026-01-01",
    entityIds: { symbol: "AAPL" },
    data,
  });

const sources: ResearchEvidence[] = [
  source("market:AAPL", "Market", "https://example.com/market", "market", {
    currentPrice: 200,
    annualizedVolatilityPercent: 24,
  }),
  source(
    "sec:facts:AAPL",
    "Facts",
    "https://example.com/facts",
    "fundamentals",
    { revenue: { value: 1000 } },
  ),
  source(
    "sec:filings:AAPL",
    "Filings",
    "https://example.com/filings",
    "filings",
    { filings: [{ form: "10-K" }] },
  ),
  source("news:AAPL", "News", "https://example.com/news", "news", {
    articles: [],
  }),
];
const claim = (text: string, evidence = ["sec:facts:AAPL"]) => ({
  text,
  evidence,
});
const output = (overrides: object = {}) => ({
  symbol: "AAPL",
  companyName: "Apple Inc.",
  stance: "balanced",
  executiveSummary: "A balanced view.",
  summaryEvidence: ["market:AAPL", "sec:facts:AAPL"],
  keyMetrics: [
    {
      label: "Price",
      value: 200,
      unit: "USD",
      period: "current",
      evidence: "market:AAPL",
    },
    {
      label: "Volatility",
      value: 24,
      unit: "%",
      period: "1 year",
      evidence: "market:AAPL",
    },
    {
      label: "Revenue",
      value: 1000,
      unit: "USD",
      period: "latest filing",
      evidence: "sec:facts:AAPL",
    },
  ],
  thesis: [
    claim("Revenue supports the thesis."),
    claim("Market data provides context.", ["market:AAPL"]),
  ],
  risks: [
    claim("Valuation can compress.", ["market:AAPL"]),
    claim("Execution remains uncertain."),
  ],
  catalysts: [claim("A filing may update the outlook.", ["sec:filings:AAPL"])],
  limitations: ["This is point-in-time public data."],
  ...overrides,
});

test("research evaluator accepts cited, numerically grounded analysis", () => {
  const metrics = evaluateResearch(output(), sources);
  expect(validResearchOutput(output(), "AAPL", sources)).toBe(true);
  expect(metrics).toMatchObject({
    schemaValid: true,
    citationValidity: 1,
    citationCoverage: 1,
    numericGrounding: 1,
    toolCoverage: 1,
    overallScore: 100,
  });
});

test("research evaluator rejects trust failures and scores ungrounded numbers", () => {
  expect(
    validResearchOutput(
      output({ summaryEvidence: ["invented"] }),
      "AAPL",
      sources,
    ),
  ).toBe(false);
  const ungrounded = output({
    keyMetrics: [
      {
        label: "Price",
        value: 999,
        unit: "USD",
        period: "current",
        evidence: "market:AAPL",
      },
      {
        label: "Volatility",
        value: 24,
        unit: "%",
        period: "1 year",
        evidence: "market:AAPL",
      },
      {
        label: "Revenue",
        value: 1000,
        unit: "USD",
        period: "latest",
        evidence: "sec:facts:AAPL",
      },
    ],
  });
  expect(validResearchOutput(ungrounded, "AAPL", sources)).toBe(true);
  expect(evaluateResearch(ungrounded, sources).numericGrounding).toBeLessThan(
    1,
  );
  expect(
    validResearchOutput(
      output({ executiveSummary: "This is a guaranteed winner." }),
      "AAPL",
      sources,
    ),
  ).toBe(false);
  expect(validResearchOutput(output({ symbol: "MSFT" }), "AAPL", sources)).toBe(
    false,
  );
});

test("research guardrail accepts the 90% citation boundary but rejects material drift", () => {
  const minorMiss = output({
    summaryEvidence: [
      "market:AAPL",
      "sec:facts:AAPL",
      "sec:filings:AAPL",
      "news:AAPL",
      "market:AAPL",
      "sec:facts:AAPL",
    ],
    thesis: [
      claim("Revenue supports the thesis.", [
        "sec:facts:AAPL",
        "sec:filings:AAPL",
        "market:AAPL",
        "news:AAPL",
      ]),
      claim("Market context.", [
        "market:AAPL",
        "sec:facts:AAPL",
        "sec:filings:AAPL",
        "news:AAPL",
      ]),
      claim("A malformed supplemental citation.", [
        "invented",
        "sec:facts:AAPL",
        "market:AAPL",
        "sec:filings:AAPL",
      ]),
    ],
  });
  expect(
    evaluateResearch(minorMiss, sources).citationValidity,
  ).toBeGreaterThanOrEqual(0.95);
  expect(validResearchOutput(minorMiss, "AAPL", sources)).toBe(true);
  const boundary = output({
    thesis: [
      claim("One unsupported citation among otherwise grounded evidence.", [
        "invented",
        "market:AAPL",
        "sec:facts:AAPL",
        "sec:filings:AAPL",
      ]),
      claim("Grounded context.", [
        "market:AAPL",
        "sec:facts:AAPL",
        "sec:filings:AAPL",
        "news:AAPL",
      ]),
    ],
  });
  expect(
    evaluateResearch(boundary, sources).citationValidity,
  ).toBeGreaterThanOrEqual(0.9);
  expect(validResearchOutput(boundary, "AAPL", sources)).toBe(true);
  expect(
    validResearchOutput(
      output({
        thesis: [
          claim("Unsupported.", ["invented"]),
          claim("Also unsupported.", ["invented-2"]),
        ],
      }),
      "AAPL",
      sources,
    ),
  ).toBe(false);
});

test("research score exposes missing source-category coverage", () => {
  const metrics = evaluateResearch(output(), sources.slice(0, 3));
  expect(metrics.toolCoverage).toBe(0.75);
  expect(metrics.overallScore).toBeLessThan(100);
});

test("research runs and reliability metrics persist", () => {
  const store = createStore(":memory:");
  store.startResearch("run-1", "AAPL", "test-model");
  const metrics = evaluateResearch(output(), sources, {
    latencyMs: 1200,
    totalTokens: 500,
  });
  store.completeResearch("run-1", { research: output(), sources }, metrics);
  expect(store.getResearch("run-1")).toMatchObject({
    id: "run-1",
    symbol: "AAPL",
    status: "completed",
    metrics: { overallScore: 100 },
  });
  expect(store.researchMetrics()).toMatchObject({
    totalRuns: 1,
    successRate: 1,
    averageScore: 100,
    averageLatencyMs: 1200,
    averageTokens: 500,
  });
  store.close();
});
