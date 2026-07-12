import { expect, test } from "bun:test";
import {
  canonicalEvidence,
  evidenceContentHash,
} from "../../backend/shared/evidence";
import {
  buildCompanyResearchReplay,
  evaluateResearch,
  replayCompanyResearch,
  validResearchOutput,
  type CompanyResearch,
  type ResearchEvidence,
} from "../../backend/features/research/research";
import { buildCompanyResearchCoverage } from "../../backend/features/research/company-research-coverage";
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
const output = (overrides: Partial<CompanyResearch> = {}): CompanyResearch => ({
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

test("company research coverage exposes complete tool, evidence, grounding, and time inputs", () => {
  const completeSources = [
    ...sources,
    source("macro:AAPL", "Macro", "https://example.com/macro", "macro", {
      rate: 4.25,
    }),
    source(
      "identity:AAPL",
      "Identity",
      "https://example.com/identity",
      "identity",
      { figi: "BBG000B9XRY4" },
    ),
  ];
  const metrics = evaluateResearch(output(), completeSources, { toolCalls: 5 });
  const coverage = buildCompanyResearchCoverage(
    output(),
    completeSources,
    metrics,
    "2026-01-01T00:01:00.000Z",
  );

  expect(coverage).toMatchObject({
    asOf: "2026-01-01T00:01:00.000Z",
    observedAt: "2026-01-01T00:00:00.000Z",
    retrievedAt: "2026-01-01T00:00:00.000Z",
    quality: {
      status: "complete",
      expected: {
        researchTools: 5,
        requiredEvidenceCategories: 4,
        supplementalEvidenceCategories: 2,
        citedClaims: 9,
        numericMetrics: 3,
        sourceTimeRecords: 6,
      },
      received: {
        researchTools: 5,
        requiredEvidenceCategories: 4,
        supplementalEvidenceCategories: 2,
        citedClaims: 9,
        numericMetrics: 3,
        sourceTimeRecords: 6,
      },
      omitted: {
        researchTools: 0,
        supplementalEvidenceCategories: 0,
        numericMetrics: 0,
      },
      freshness: {
        status: "semantic_time_available",
        latestObservedAt: "2026-01-01T00:00:00.000Z",
        evaluatedAt: "2026-01-01T00:01:00.000Z",
      },
      missing: [],
    },
  });
});

test("company research coverage keeps missing context and accepted grounding gaps consequential", () => {
  const partiallyGrounded = output({
    keyMetrics: [
      {
        label: "Price",
        value: 999,
        unit: "USD",
        period: "current",
        evidence: "market:AAPL",
      },
      ...output().keyMetrics.slice(1),
    ],
  });
  const metrics = evaluateResearch(partiallyGrounded, sources, {
    toolCalls: 4,
  });
  const retrievalOnlySources = sources.map((item) => ({
    ...item,
    observedAt: null,
    publishedAt: null,
    effectivePeriod: null,
    time: { ...item.time, observationTime: null },
  }));
  const coverage = buildCompanyResearchCoverage(
    partiallyGrounded,
    retrievalOnlySources,
    metrics,
    "2026-01-01T00:01:00.000Z",
  );

  expect(coverage.quality).toMatchObject({
    status: "partial",
    received: {
      researchTools: 4,
      supplementalEvidenceCategories: 0,
      numericMetrics: 2,
      sourceTimeRecords: 0,
    },
    omitted: {
      researchTools: 1,
      supplementalEvidenceCategories: 2,
      numericMetrics: 1,
      sourceTimeRecords: 4,
    },
    freshness: { status: "partial_provider_time" },
  });
  expect(coverage.quality.impact.join(" ")).toContain("grounding confidence");
  expect(coverage.quality.impact.join(" ")).toContain(
    "cross-provider identity confidence",
  );
});

test("company research replay re-evaluates frozen evidence without providers", () => {
  const metrics = evaluateResearch(output(), sources, {
    latencyMs: 1200,
    toolCalls: 5,
    requests: 1,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  });
  const replay = buildCompanyResearchReplay({
    schemaVersion: "company-research-v2",
    runId: "research-replay-1",
    model: "test-model",
    research: output(),
    sources,
    metrics,
    serverRespondedAt: "2026-01-01T00:01:00.000Z",
  });
  const result = replayCompanyResearch(replay);
  expect(result).toMatchObject({
    schemaVersion: "company-research-replay-result-v1",
    status: "verified",
    providerRequests: 0,
    modelRequests: 0,
    replayHash: replay.contentHash,
    report: {
      runId: "research-replay-1",
      research: { symbol: "AAPL" },
      metrics: {
        overallScore: 100,
        latencyMs: 1200,
        requests: 1,
      },
      quality: { status: "partial" },
    },
  });

  const sourceTamper = structuredClone(replay);
  sourceTamper.report.sources[0]!.data = { currentPrice: 999 };
  const { contentHash: _sourceHash, ...sourceManifest } = sourceTamper;
  sourceTamper.contentHash = evidenceContentHash(sourceManifest);
  expect(() => replayCompanyResearch(sourceTamper)).toThrow(
    "source integrity check failed",
  );

  const outputTamper = structuredClone(replay);
  outputTamper.report.research.keyMetrics[0]!.value = 999;
  const { contentHash: _outputHash, ...outputManifest } = outputTamper;
  outputTamper.contentHash = evidenceContentHash(outputManifest);
  expect(() => replayCompanyResearch(outputTamper)).toThrow(
    "metrics do not match frozen evidence",
  );

  const identityTamper = structuredClone(replay);
  identityTamper.report.symbol = "MSFT";
  const { contentHash: _identityHash, ...identityManifest } = identityTamper;
  identityTamper.contentHash = evidenceContentHash(identityManifest);
  expect(() => replayCompanyResearch(identityTamper)).toThrow(
    "run identity is invalid",
  );
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
