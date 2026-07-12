import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { handleResearchRequest } from "../../backend/features/research/routes";
import type { FinnhubCompanyEnrichment } from "../../backend/integrations/finnhub";
import type { GdeltCompanySignals } from "../../backend/integrations/gdelt";
import type { OpenFigiIdentity } from "../../backend/integrations/openfigi";
import type { MacroContext } from "../../backend/integrations/macro-context";
import { createStore } from "../../backend/persistence/store";
import { canonicalEvidence } from "../../backend/shared/evidence";
import type { getCompanySecEvidence } from "../../backend/features/research/research";
import {
  buildCompanyResearchReplay,
  evaluateResearch,
  type CompanyResearch,
  type getComparableValuations,
  type getPointInTimeComparableValuations,
  type getValuationScenarios,
  type ResearchEvidence,
  type runCompanyResearch,
} from "../../backend/features/research/research";
import type {
  runPortfolioCopilot,
  runPortfolioQuestion,
} from "../../backend/features/research/copilot";

type RouteOptions = {
  alpaca?: Alpaca;
  env?: Record<string, string | undefined>;
  store?: ReturnType<typeof createStore>;
  finnhubCompanyEnrichment?: (
    symbol: string,
  ) => Promise<FinnhubCompanyEnrichment>;
  gdeltCompanySignals?: (
    symbol: string,
    companyName: string,
  ) => Promise<GdeltCompanySignals>;
  openFigiIdentity?: (
    symbol: string,
    companyName: string,
  ) => Promise<OpenFigiIdentity>;
  secCompanyEvidence?: (
    symbol: string,
    filedThrough: string | null,
  ) => ReturnType<typeof getCompanySecEvidence>;
  officialMacroContext?: () => Promise<MacroContext>;
  comparableValuations?: (
    symbol: string,
    peers: string | string[],
  ) => ReturnType<typeof getComparableValuations>;
  pointInTimeComparableValuations?: (
    symbol: string,
    peers: string | string[],
    asOf: string,
  ) => ReturnType<typeof getPointInTimeComparableValuations>;
  valuationScenarios?: (
    symbol: string,
    scenarios: unknown,
  ) => ReturnType<typeof getValuationScenarios>;
  companyResearch?: (
    symbol: string,
    runId: string,
  ) => ReturnType<typeof runCompanyResearch>;
  portfolioQuestion?: (
    alpaca: Alpaca,
    question: string,
  ) => ReturnType<typeof runPortfolioQuestion>;
  portfolioCopilot?: (
    alpaca: Alpaca,
    intent: "reduce_concentration" | "balanced_growth" | "preserve_capital",
  ) => ReturnType<typeof runPortfolioCopilot>;
};

const route = async (
  path: string,
  init?: RequestInit,
  allow: (key: string, maximum: number) => boolean = () => true,
  options: RouteOptions = {},
) => {
  const request = new Request(`http://localhost${path}`, init);
  return handleResearchRequest(request, new URL(request.url), {
    alpaca: options.alpaca ?? ({} as Alpaca),
    store: options.store ?? createStore(":memory:"),
    actor: "test-researcher",
    allow,
    env: options.env ?? {},
    finnhubCompanyEnrichment: options.finnhubCompanyEnrichment,
    gdeltCompanySignals: options.gdeltCompanySignals,
    openFigiIdentity: options.openFigiIdentity,
    secCompanyEvidence: options.secCompanyEvidence,
    officialMacroContext: options.officialMacroContext,
    comparableValuations: options.comparableValuations,
    pointInTimeComparableValuations:
      options.pointInTimeComparableValuations,
    valuationScenarios: options.valuationScenarios,
    companyResearch: options.companyResearch,
    portfolioQuestion: options.portfolioQuestion,
    portfolioCopilot: options.portfolioCopilot,
  });
};

test("research routes reject invalid and unavailable requests before provider calls", async () => {
  expect(await route("/api/account")).toBeNull();

  const invalidSymbol = await route("/api/research/sec?symbol=not-a-symbol");
  expect(invalidSymbol?.status).toBe(400);

  const missingKey = await route("/api/research/runs", {
    method: "POST",
    body: JSON.stringify({ symbol: "AAPL" }),
  });
  expect(missingKey?.status).toBe(503);

  const missingPlan = await route("/api/agent/plans/missing");
  expect(missingPlan?.status).toBe(404);

  const missingQuestionKey = await route("/api/agent/questions", {
    method: "POST",
    body: JSON.stringify({ question: "What is my largest position?" }),
  });
  expect(missingQuestionKey?.status).toBe(503);

  const invalidScenario = await route("/api/research/scenarios", {
    method: "POST",
    body: JSON.stringify({ symbol: "not-a-symbol", scenarios: {} }),
  });
  expect(invalidScenario?.status).toBe(400);

  const fixedIncome = await route("/api/research/fixed-income");
  expect(fixedIncome?.status).toBe(200);
  expect(await fixedIncome?.json()).toMatchObject({ status: "unavailable" });

  const journal = await route("/api/trade-journal");
  expect(journal?.status).toBe(200);
  expect(await journal?.json()).toMatchObject({
    entries: [],
    eligibleReceipts: [],
  });
});

test("research routes preserve rate limits and local metrics", async () => {
  const limited = await route(
    "/api/research/sec?symbol=AAPL",
    undefined,
    () => false,
  );
  expect(limited?.status).toBe(429);

  const metrics = await route("/api/research/metrics");
  expect(metrics?.status).toBe(200);
  expect(await metrics?.json()).toMatchObject({ totalRuns: 0 });
});

test("advisor routes preserve versioned coverage contracts", async () => {
  const rootTime = {
    observedAt: null,
    publishedAt: null,
    effectivePeriod: null,
    retrievedAt: "2026-07-12T12:00:00.000Z",
    serverRespondedAt: "2026-07-12T12:00:01.000Z",
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: "2026-07-12T12:00:00.000Z",
      serverResponseTime: "2026-07-12T12:00:01.000Z",
    },
    asOf: "2026-07-12T12:00:01.000Z",
  };
  const questionPayload = {
    schemaVersion: "portfolio-question-v2",
    claims: [
      {
        text: "The largest position is supported by current portfolio evidence.",
        evidence: ["portfolio:current"],
      },
    ],
    limitations: [],
    evidenceRecords: [],
    quality: {
      status: "partial",
      expected: { claims: 1, providerTimeRecords: 1 },
      received: { claims: 1, providerTimeRecords: 0 },
      omitted: { claims: 0, providerTimeRecords: 1 },
      freshness: {
        status: "retrieval_only",
        expectedObservations: 1,
        receivedObservations: 0,
      },
      missing: ["Provider observation time is unavailable."],
      impact: ["Time-sensitive interpretation is limited."],
      ...rootTime,
    },
    ...rootTime,
  } as unknown as Awaited<ReturnType<typeof runPortfolioQuestion>>;
  const planPayload = {
    schemaVersion: "portfolio-plan-v2",
    summary: "Three evidence-bound ideas were independently reviewed.",
    riskReviewSummary: "No idea bypasses the independent review.",
    reviewedAt: "2026-07-12T12:00:00.000Z",
    ideas: Array.from({ length: 3 }, (_, index) => ({
      symbol: ["AAPL", "MSFT", "SPY"][index],
      action: "watch",
      proposedAction: "watch",
      thesis: "Observe only.",
      risk: "Current evidence may change.",
      invalidation: "Re-evaluate after new evidence.",
      confidence: 50,
      suggestedQty: 0,
      simulationId: null,
      evidence: ["portfolio:current"],
      actionable: false,
      riskReview: {
        symbol: ["AAPL", "MSFT", "SPY"][index],
        proposedAction: "watch",
        verdict: "caution",
        counterThesis: "The available evidence is incomplete.",
        failureCondition: "The portfolio state changes.",
        evidence: ["risk:current"],
      },
    })),
    evidenceRecords: [],
    evidenceReplay: {
      schemaVersion: "advisor-plan-evidence-v1",
      payloadPolicy: "allowlisted_typed_tool_output",
      status: "complete",
      expectedSnapshots: 2,
      receivedSnapshots: 2,
      missingSnapshots: [],
      references: [
        { phase: "proposal", evidenceId: "portfolio:current" },
        { phase: "review", evidenceId: "risk:current" },
      ],
      snapshots: [
        { schemaVersion: "advisor-evidence-snapshot-v1", evidenceId: "portfolio:current", phase: "proposal", contentHash: `sha256:${"a".repeat(64)}`, payload: { equity: "10000" } },
        { schemaVersion: "advisor-evidence-snapshot-v1", evidenceId: "risk:current", phase: "review", contentHash: `sha256:${"b".repeat(64)}`, payload: { concentration: 0.4 } },
      ],
      contentHash: `sha256:${"c".repeat(64)}`,
    },
    quality: {
      status: "partial",
      expected: { ideas: 3, providerTimeRecords: 2 },
      received: { ideas: 3, providerTimeRecords: 0 },
      omitted: { ideas: 0, providerTimeRecords: 2 },
      freshness: {
        status: "retrieval_only",
        expectedObservations: 2,
        receivedObservations: 0,
      },
      missing: ["Provider observation time is unavailable."],
      impact: ["Time-sensitive interpretation is limited."],
      ...rootTime,
    },
    ...rootTime,
  } as unknown as Awaited<ReturnType<typeof runPortfolioCopilot>>;
  const calls: string[] = [];
  const store = createStore(":memory:");
  const question = await route(
    "/api/agent/questions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What is my largest position?" }),
    },
    () => true,
    {
      env: { OPENAI_API_KEY: "configured-for-injected-contract" },
      store,
      portfolioQuestion: async (_alpaca, input) => {
        calls.push(`question:${input}`);
        return questionPayload;
      },
    },
  );
  expect(question?.status).toBe(200);
  expect(await question?.json()).toMatchObject({
    question: "What is my largest position?",
    schemaVersion: "portfolio-question-v2",
    quality: {
      status: "partial",
      expected: { claims: 1, providerTimeRecords: 1 },
      received: { claims: 1, providerTimeRecords: 0 },
    },
    time: {
      retrievalTime: "2026-07-12T12:00:00.000Z",
      serverResponseTime: "2026-07-12T12:00:01.000Z",
    },
  });

  const plan = await route(
    "/api/agent/plans",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "balanced_growth" }),
    },
    () => true,
    {
      env: { OPENAI_API_KEY: "configured-for-injected-contract" },
      store,
      portfolioCopilot: async (_alpaca, input) => {
        calls.push(`plan:${input}`);
        return planPayload;
      },
    },
  );
  expect(plan?.status).toBe(200);
  const planBody = await plan?.json();
  expect(planBody).toMatchObject({
    intent: "balanced_growth",
    schemaVersion: "portfolio-plan-v2",
    quality: {
      status: "partial",
      expected: { ideas: 3, providerTimeRecords: 2 },
      received: { ideas: 3, providerTimeRecords: 0 },
    },
    time: {
      retrievalTime: "2026-07-12T12:00:00.000Z",
      serverResponseTime: "2026-07-12T12:00:01.000Z",
    },
    evidenceReplay: {
      status: "complete",
      expectedSnapshots: 2,
      receivedSnapshots: 2,
      contentHash: `sha256:${"c".repeat(64)}`,
    },
  });
  expect(planBody.planId).toBeString();
  expect(calls).toEqual([
    "question:What is my largest position?",
    "plan:balanced_growth",
  ]);
  expect(store.getPlan(planBody.planId)).toMatchObject({
    schemaVersion: "portfolio-plan-v2",
    quality: { status: "partial" },
    evidenceReplay: {
      status: "complete",
      snapshots: [
        { phase: "proposal", payload: { equity: "10000" } },
        { phase: "review", payload: { concentration: 0.4 } },
      ],
      contentHash: `sha256:${"c".repeat(64)}`,
    },
  });
  store.close();
});

test("valuation routes preserve normalized coverage contracts", async () => {
  const comparablePayload = {
    schemaVersion: "comparable-valuations-v3",
    quality: {
      status: "partial",
      expected: { companies: 2 },
      received: { companies: 1 },
      omitted: { companies: 1 },
    },
  } as unknown as Awaited<ReturnType<typeof getComparableValuations>>;
  const comparableInputs: [string, string][] = [];
  const comparable = await route(
    "/api/research/comparables?symbol=aapl&peers=MSFT",
    undefined,
    () => true,
    {
      comparableValuations: async (symbol, peers) => {
        comparableInputs.push([
          symbol,
          Array.isArray(peers) ? peers.join(",") : peers,
        ]);
        return comparablePayload;
      },
    },
  );
  expect(comparableInputs).toEqual([["aapl", "MSFT"]]);
  expect(comparable?.status).toBe(200);
  expect(await comparable?.json()).toEqual(comparablePayload);

  const scenarioPayload = {
    schemaVersion: "valuation-scenarios-v3",
    quality: {
      status: "partial",
      expected: { scenarioOutputs: 3 },
      received: { scenarioOutputs: 2 },
      omitted: { scenarioOutputs: 1 },
    },
  } as unknown as Awaited<ReturnType<typeof getValuationScenarios>>;
  const scenarioInputs: [string, unknown][] = [];
  const scenarios = { bear: {}, base: {}, bull: {} };
  const scenario = await route(
    "/api/research/scenarios",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "AAPL", scenarios }),
    },
    () => true,
    {
      valuationScenarios: async (symbol, input) => {
        scenarioInputs.push([symbol, input]);
        return scenarioPayload;
      },
    },
  );
  expect(scenarioInputs).toEqual([["AAPL", scenarios]]);
  expect(scenario?.status).toBe(200);
  expect(await scenario?.json()).toEqual(scenarioPayload);
});

test("historical valuation runs persist and replay without another provider call", async () => {
  const replayTime = {
    observedAt: null,
    publishedAt: null,
    retrievedAt: "2026-07-12T12:00:00.000Z",
    serverRespondedAt: "2026-07-12T12:00:01.000Z",
    effectivePeriod: null,
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: "2026-07-12T12:00:00.000Z",
      serverResponseTime: "2026-07-12T12:00:01.000Z",
    },
    asOf: "2026-07-12T12:00:01.000Z",
  };
  const valuationSources = [
    canonicalEvidence({
      id: "sec:valuation-inputs:AAPL",
      provider: "sec",
      sourceId: "AAPL:historical-sec",
      category: "fundamentals",
      authority: "official",
      claimStatus: "official_record",
      title: "AAPL historical SEC inputs",
      url: "https://data.sec.gov/aapl",
      asOf: "2025-05-01T00:00:00.000Z",
      observedAt: null,
      publishedAt: "2025-05-01T00:00:00.000Z",
      retrievedAt: "2026-07-12T12:00:00.000Z",
      serverRespondedAt: "2026-07-12T12:00:01.000Z",
      effectivePeriod: null,
      entityIds: { symbol: "AAPL" },
      data: { annualRevenue: 1000, sharesOutstanding: 100 },
    }),
    canonicalEvidence({
      id: "market:valuation-price:AAPL",
      provider: "alpaca",
      sourceId: "AAPL:historical-price",
      category: "market",
      authority: "regulated_broker",
      claimStatus: "broker_observation",
      title: "AAPL historical IEX close",
      url: "https://alpaca.markets/data",
      asOf: "2025-05-14T20:00:00.000Z",
      observedAt: "2025-05-14T20:00:00.000Z",
      retrievedAt: "2026-07-12T12:00:00.000Z",
      serverRespondedAt: "2026-07-12T12:00:01.000Z",
      publishedAt: null,
      effectivePeriod: {
        start: "2025-05-14T20:00:00.000Z",
        end: "2025-05-14T20:00:00.000Z",
        label: "Historical daily-close observation",
      },
      entityIds: { symbol: "AAPL" },
      data: { price: 10, feed: "IEX", priceType: "daily_close" },
    }),
  ];
  const report = {
    schemaVersion: "comparable-valuations-v3",
    priceMode: "historical_daily_close",
    pointInTime: {
      status: "applied",
      asOfDate: "2025-05-15",
      cutoffAt: "2025-05-15T23:59:59.999Z",
      publicationPrecision: "sec_filed_date",
      marketObservationPolicy: "last_daily_bar_at_or_before_cutoff",
      excludedPostCutoffValuationObservations: 0,
      historicalClassification: {
        status: "unavailable",
        reason: "SEC submissions expose current SIC without a historical classification series.",
      },
    },
    subject: "AAPL",
    peers: ["MSFT"],
    rows: [
      {
        symbol: "AAPL",
        companyName: "Apple Inc.",
        subject: true,
        price: 10,
        marketCap: 1000,
        annualRevenue: 1000,
        annualNetIncome: 100,
        annualDilutedEps: 1,
        stockholdersEquity: 500,
        sharesOutstanding: 100,
        revenueGrowthPercent: 5,
        netMarginPercent: 10,
        priceToSales: 1,
        priceToEarnings: 10,
        priceToBook: 2,
        periods: { revenue: "2024-12-31", netIncome: "2024-12-31", dilutedEps: "2024-12-31", stockholdersEquity: "2025-03-31", sharesOutstanding: "2025-03-31", price: "2025-05-14T20:00:00.000Z" },
        evidence: { sec: "sec:valuation-inputs:AAPL", price: "market:valuation-price:AAPL", valuation: "valuation:comparables:AAPL" },
        warnings: [],
      },
    ],
    sources: valuationSources,
    warnings: ["MSFT fixture inputs are unavailable."],
    formulas: {},
    quality: {
      status: "partial",
      expected: { companies: 2, secFundamentals: 2, prices: 2, marketPriceObservations: 2, valuationMetrics: 12 },
      received: { companies: 1, secFundamentals: 1, prices: 1, marketPriceObservations: 1, valuationMetrics: 6 },
      omitted: { companies: 1, secFundamentals: 1, prices: 1, marketPriceObservations: 1, valuationMetrics: 6 },
      freshness: { status: "observed", latestPublishedAt: "2025-05-01T00:00:00.000Z", effectivePeriod: null, retrievedAt: "2026-07-12T12:00:00.000Z", evaluatedAt: "2026-07-12T12:00:01.000Z", agePolicy: "historical_price_must_not_exceed_cutoff" },
      missing: ["MSFT:valuation_inputs"],
      impact: ["The peer table is partial."],
      source: "Injected deterministic route fixture",
      ...replayTime,
    },
    ...replayTime,
  } as unknown as Awaited<ReturnType<typeof getPointInTimeComparableValuations>>;
  const calls: Array<[string, string[], string]> = [];
  const store = createStore(":memory:");
  const created = await route(
    "/api/research/valuation-runs",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "aapl", peers: ["MSFT"], asOf: "2025-05-15" }),
    },
    () => true,
    {
      store,
      pointInTimeComparableValuations: async (symbol, peers, asOf) => {
        calls.push([symbol, Array.isArray(peers) ? peers : peers.split(","), asOf]);
        return report;
      },
    },
  );
  expect(created?.status).toBe(201);
  const createdBody = await created?.json();
  expect(calls).toEqual([["AAPL", ["MSFT"], "2025-05-15"]]);
  expect(createdBody).toMatchObject({
    schemaVersion: "historical-comparable-valuation-run-v1",
    model: "deterministic-comparable-valuations-v3",
    report: { pointInTime: { status: "applied", asOfDate: "2025-05-15" } },
    evidenceReplay: {
      schemaVersion: "comparable-valuation-replay-v1",
      calculationVersion: "comparable-valuations-v3",
    },
  });
  expect(store.getResearch(createdBody.runId)).toMatchObject({
    status: "completed",
    metrics: null,
    payload: {
      runId: createdBody.runId,
      evidenceReplay: { contentHash: createdBody.evidenceReplay.contentHash },
    },
  });

  const replayed = await route(
    `/api/research/valuation-runs/${createdBody.runId}/replay`,
    { method: "POST" },
    () => true,
    { store },
  );
  expect(replayed?.status).toBe(200);
  expect(await replayed?.json()).toMatchObject({
    status: "verified",
    providerRequests: 0,
    replayHash: createdBody.evidenceReplay.contentHash,
    report: { pointInTime: { asOfDate: "2025-05-15" } },
  });
  const scenarioAssumptions = {
    bear: { revenueGrowthPercent: -10, netMarginPercent: 8, priceToEarnings: 8 },
    base: { revenueGrowthPercent: 0, netMarginPercent: 10, priceToEarnings: 10 },
    bull: { revenueGrowthPercent: 10, netMarginPercent: 12, priceToEarnings: 12 },
  };
  const scenarioCreated = await route(
    `/api/research/valuation-runs/${createdBody.runId}/scenarios`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarios: scenarioAssumptions }),
    },
    () => true,
    { store },
  );
  expect(scenarioCreated?.status).toBe(201);
  const scenarioBody = await scenarioCreated?.json();
  expect(scenarioBody).toMatchObject({
    schemaVersion: "historical-valuation-scenario-run-v1",
    parentRunId: createdBody.runId,
    model: "deterministic-valuation-scenarios-v3",
    memo: {
      schemaVersion: "valuation-scenarios-v3",
      priceMode: "historical_daily_close",
      pointInTime: { status: "applied", asOfDate: "2025-05-15" },
      scenarios: [{ case: "bear" }, { case: "base" }, { case: "bull" }],
    },
    evidenceReplay: {
      schemaVersion: "valuation-scenario-replay-v1",
      parentReplay: { contentHash: createdBody.evidenceReplay.contentHash },
    },
  });
  expect(store.getResearch(scenarioBody.runId)).toMatchObject({
    status: "completed",
    metrics: null,
    payload: {
      parentRunId: createdBody.runId,
      evidenceReplay: { contentHash: scenarioBody.evidenceReplay.contentHash },
    },
  });
  const scenarioReplayed = await route(
    `/api/research/scenario-runs/${scenarioBody.runId}/replay`,
    { method: "POST" },
    () => true,
    { store },
  );
  expect(scenarioReplayed?.status).toBe(200);
  expect(await scenarioReplayed?.json()).toMatchObject({
    status: "verified",
    providerRequests: 0,
    replayHash: scenarioBody.evidenceReplay.contentHash,
    parentReplayHash: createdBody.evidenceReplay.contentHash,
    memo: { pointInTime: { asOfDate: "2025-05-15" } },
  });
  const tamperedScenarioRunId = crypto.randomUUID();
  const tamperedScenarioPayload = structuredClone(scenarioBody);
  tamperedScenarioPayload.runId = tamperedScenarioRunId;
  tamperedScenarioPayload.evidenceReplay.contentHash = `sha256:${"0".repeat(64)}`;
  store.startResearch(
    tamperedScenarioRunId,
    "AAPL",
    "deterministic-valuation-scenarios-v3",
  );
  store.completeResearchArtifact(
    tamperedScenarioRunId,
    tamperedScenarioPayload,
  );
  await expect(
    route(
      `/api/research/scenario-runs/${tamperedScenarioRunId}/replay`,
      { method: "POST" },
      () => true,
      { store },
    ),
  ).rejects.toMatchObject({ status: 409 });
  const invalidScenario = await route(
    `/api/research/valuation-runs/${createdBody.runId}/scenarios`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarios: { ...scenarioAssumptions, bull: scenarioAssumptions.bear } }),
    },
    () => true,
    { store },
  );
  expect(invalidScenario?.status).toBe(400);
  const missingScenario = await route(
    `/api/research/scenario-runs/${crypto.randomUUID()}/replay`,
    { method: "POST" },
    () => true,
    { store },
  );
  expect(missingScenario?.status).toBe(404);
  expect(calls).toHaveLength(1);

  const tamperedRunId = crypto.randomUUID();
  const tamperedPayload = structuredClone(createdBody);
  tamperedPayload.runId = tamperedRunId;
  tamperedPayload.evidenceReplay.contentHash = `sha256:${"0".repeat(64)}`;
  store.startResearch(
    tamperedRunId,
    "AAPL",
    "deterministic-comparable-valuations-v3",
  );
  store.completeResearchArtifact(tamperedRunId, tamperedPayload);
  await expect(
    route(
      `/api/research/valuation-runs/${tamperedRunId}/replay`,
      { method: "POST" },
      () => true,
      { store },
    ),
  ).rejects.toMatchObject({ status: 409 });
  const missingReplay = await route(
    `/api/research/valuation-runs/${crypto.randomUUID()}/replay`,
    { method: "POST" },
    () => true,
    { store },
  );
  expect(missingReplay?.status).toBe(404);

  const invalid = await route(
    "/api/research/valuation-runs",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "AAPL", peers: ["MSFT"], asOf: "2025-02-30" }),
    },
    () => true,
    { store, pointInTimeComparableValuations: async () => report },
  );
  expect(invalid?.status).toBe(400);
  store.close();
});

test("company research route preserves the versioned coverage contract", async () => {
  const payload = {
    schemaVersion: "company-research-v2",
    runId: "stubbed-by-route",
    model: "test-model",
    asOf: "2026-07-12T12:00:01.000Z",
    observedAt: null,
    publishedAt: "2026-07-11T00:00:00.000Z",
    effectivePeriod: null,
    retrievedAt: "2026-07-12T12:00:00.000Z",
    serverRespondedAt: "2026-07-12T12:00:01.000Z",
    time: {
      observationTime: null,
      publicationTime: "2026-07-11T00:00:00.000Z",
      effectivePeriod: null,
      retrievalTime: "2026-07-12T12:00:00.000Z",
      serverResponseTime: "2026-07-12T12:00:01.000Z",
    },
    research: { symbol: "AAPL" },
    sources: [],
    metrics: { overallScore: 96, latencyMs: 50 },
    quality: {
      status: "partial",
      expected: { researchTools: 5 },
      received: { researchTools: 5 },
      omitted: { researchTools: 0 },
      freshness: {
        status: "partial_provider_time",
        evaluatedAt: "2026-07-12T12:00:01.000Z",
      },
      impact: ["Some sources expose retrieval time only."],
    },
  } as unknown as Awaited<ReturnType<typeof runCompanyResearch>>;
  const calls: Array<{ symbol: string; runId: string }> = [];
  const store = createStore(":memory:");
  const response = await route(
    "/api/research/runs",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "aapl" }),
    },
    () => true,
    {
      env: { OPENAI_API_KEY: "configured-for-injected-contract" },
      store,
      companyResearch: async (symbol, runId) => {
        calls.push({ symbol, runId });
        return { ...payload, runId };
      },
    },
  );

  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.symbol).toBe("AAPL");
  expect(calls[0]?.runId).toBe(body.runId);
  expect(body).toMatchObject({
    schemaVersion: "company-research-v2",
    quality: {
      status: "partial",
      expected: { researchTools: 5 },
      received: { researchTools: 5 },
      omitted: { researchTools: 0 },
    },
    time: {
      publicationTime: "2026-07-11T00:00:00.000Z",
      retrievalTime: "2026-07-12T12:00:00.000Z",
      serverResponseTime: "2026-07-12T12:00:01.000Z",
    },
  });
  expect(store.getResearch(body.runId)?.payload).toMatchObject({
    schemaVersion: "company-research-v2",
    quality: { status: "partial" },
  });
  store.close();
});

test("stored company research replays without a provider or model request", async () => {
  const source = (
    id: string,
    category: ResearchEvidence["category"],
    data: unknown,
  ): ResearchEvidence =>
    canonicalEvidence({
      id,
      provider: id.startsWith("sec:") ? "sec" : "alpaca",
      sourceId: id,
      category,
      authority: id.startsWith("sec:") ? "official" : "regulated_broker",
      claimStatus: id.startsWith("sec:")
        ? "official_record"
        : "broker_observation",
      title: id,
      url: `https://example.com/${encodeURIComponent(id)}`,
      asOf: "2026-07-12T12:00:00.000Z",
      observedAt: "2026-07-12T11:59:00.000Z",
      retrievedAt: "2026-07-12T12:00:00.000Z",
      serverRespondedAt: "2026-07-12T12:00:01.000Z",
      publishedAt: null,
      effectivePeriod: null,
      entityIds: { symbol: "AAPL" },
      data,
    });
  const evidence = [
    source("market:AAPL", "market", { price: 200, volatility: 24 }),
    source("sec:facts:AAPL", "fundamentals", { revenue: 1000 }),
    source("sec:filings:AAPL", "filings", { form: "10-K" }),
    source("news:AAPL", "news", { articles: [] }),
  ];
  const research: CompanyResearch = {
    symbol: "AAPL",
    companyName: "Apple Inc.",
    stance: "balanced",
    executiveSummary: "A bounded evidence summary.",
    summaryEvidence: ["market:AAPL", "sec:facts:AAPL"],
    keyMetrics: [
      { label: "Price", value: 200, unit: "USD", period: "current", evidence: "market:AAPL" },
      { label: "Volatility", value: 24, unit: "%", period: "one year", evidence: "market:AAPL" },
      { label: "Revenue", value: 1000, unit: "USD", period: "latest", evidence: "sec:facts:AAPL" },
    ],
    thesis: [
      { text: "Revenue is material.", evidence: ["sec:facts:AAPL"] },
      { text: "Market evidence supplies context.", evidence: ["market:AAPL"] },
    ],
    risks: [
      { text: "Volatility remains material.", evidence: ["market:AAPL"] },
      { text: "Filings may change the view.", evidence: ["sec:filings:AAPL"] },
    ],
    catalysts: [],
    limitations: ["This is frozen point-in-time evidence."],
  };
  const metrics = evaluateResearch(research, evidence, {
    latencyMs: 10,
    toolCalls: 5,
    requests: 1,
  });
  const replay = buildCompanyResearchReplay({
    schemaVersion: "company-research-v2",
    runId: "company-replay-route",
    model: "test-model",
    research,
    sources: evidence,
    metrics,
    serverRespondedAt: "2026-07-12T12:00:01.000Z",
  });
  const store = createStore(":memory:");
  store.startResearch("company-replay-route", "AAPL", "test-model");
  store.completeResearch(
    "company-replay-route",
    { schemaVersion: "company-research-v2", evidenceReplay: replay },
    metrics,
  );

  const response = await route(
    "/api/research/runs/company-replay-route/replay",
    { method: "POST" },
    () => true,
    { store },
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    status: "verified",
    providerRequests: 0,
    modelRequests: 0,
    replayHash: replay.contentHash,
    report: { runId: "company-replay-route", research: { symbol: "AAPL" } },
  });

  store.startResearch("legacy-company-run", "AAPL", "test-model");
  store.completeResearchArtifact("legacy-company-run", {
    schemaVersion: "company-research-v2",
  });
  await expect(
    route(
      "/api/research/runs/legacy-company-run/replay",
      { method: "POST" },
      () => true,
      { store },
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await route(
      "/api/research/runs/missing-company-run/replay",
      { method: "POST" },
      () => true,
      { store },
    ),
  ).toMatchObject({ status: 404 });
  store.close();
});

test("SEC research route preserves provider retrieval and server response time", async () => {
  const retrievedAt = "2026-07-10T08:29:59.000Z";
  const serverRespondedAt = "2026-07-10T08:30:00.000Z";
  const requests: Array<{ symbol: string; filedThrough: string | null }> = [];
  const payload = {
    symbol: "AAPL",
    companyName: "Apple Inc.",
    retrievedAt,
    serverRespondedAt,
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: retrievedAt,
      serverResponseTime: serverRespondedAt,
    },
    asOf: serverRespondedAt,
    pointInTime: {
      status: "not_requested" as const,
      asOfDate: null,
      cutoffAt: null,
      publicationPrecision: "sec_filed_date" as const,
      excluded: {
        filings: 0,
        sections: 0,
        selectedFactObservations: 0,
        trendObservations: 0,
      },
      classification: {
        status: "unavailable" as const,
        reason:
          "SEC submissions expose current classification without history.",
      },
    },
    sources: [],
    deduplication: { duplicates: [], revisions: [] },
  };
  const response = await route(
    "/api/research/sec?symbol=aapl",
    undefined,
    () => true,
    {
      secCompanyEvidence: async (symbol, filedThrough) => {
        requests.push({ symbol, filedThrough });
        return payload;
      },
    },
  );
  expect(requests).toEqual([{ symbol: "AAPL", filedThrough: null }]);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    ...payload,
    quality: {
      status: "partial",
      expected: {
        filingMetadataSet: 1,
        fundamentalFactSet: 1,
        financialTrendSet: 1,
        filingSectionSet: 1,
      },
      received: {
        filingMetadataSet: 0,
        fundamentalFactSet: 0,
        financialTrendSet: 0,
        filingSectionSet: 0,
      },
      freshness: { status: "partial_provider_time" },
    },
  });

  const historical = await route(
    "/api/research/sec?symbol=AAPL&asOf=2025-06-30",
    undefined,
    () => true,
    {
      secCompanyEvidence: async (symbol, filedThrough) => {
        requests.push({ symbol, filedThrough });
        return {
          ...payload,
          pointInTime: {
            ...payload.pointInTime,
            status: "applied" as const,
            asOfDate: filedThrough,
            cutoffAt: `${filedThrough}T23:59:59.999Z`,
          },
        };
      },
    },
  );
  expect(historical?.status).toBe(200);
  expect(requests.at(-1)).toEqual({
    symbol: "AAPL",
    filedThrough: "2025-06-30",
  });
  expect(await historical?.json()).toMatchObject({
    pointInTime: {
      status: "applied",
      asOfDate: "2025-06-30",
      cutoffAt: "2025-06-30T23:59:59.999Z",
    },
  });

  const invalid = await route("/api/research/sec?symbol=AAPL&asOf=2025-02-30");
  expect(invalid?.status).toBe(400);
  expect(await invalid?.json()).toEqual({
    error: "SEC point-in-time date must be a real calendar date",
  });

  const future = await route("/api/research/sec?symbol=AAPL&asOf=2999-01-01");
  expect(future?.status).toBe(400);
  expect(await future?.json()).toEqual({
    error: "SEC point-in-time date cannot be in the future",
  });
  expect(requests).toHaveLength(2);
});

test("macro research route preserves explicit unavailable retrieval time", async () => {
  const serverRespondedAt = "2026-07-10T08:30:00.000Z";
  const unavailableTime = {
    retrievedAt: null,
    serverRespondedAt,
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: null,
      serverResponseTime: serverRespondedAt,
    },
    asOf: serverRespondedAt,
  } as const;
  const payload = {
    ...unavailableTime,
    indicators: [],
    regime: {
      summary: "Official macro context is currently unavailable.",
      dimensions: [],
      evidence: [],
    },
    sources: [],
    warnings: ["Official macro providers are temporarily unavailable."],
    coverage: {
      fred: { status: "missing_key", indicators: 0, ...unavailableTime },
      treasury: { status: "unavailable", indicators: 0, ...unavailableTime },
      bls: { status: "unavailable", indicators: 0, ...unavailableTime },
      bea: { status: "missing_key", indicators: 0, ...unavailableTime },
    },
    disclosures: [],
  } satisfies MacroContext;
  const response = await route("/api/research/macro", undefined, () => true, {
    officialMacroContext: async () => payload,
  });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    ...payload,
    quality: {
      status: "partial",
      received: { requiredProviders: 0, optionalProviders: 0 },
      omitted: { requiredProviders: 2, optionalProviders: 2 },
      freshness: { status: "unavailable", retrievedAt: null },
    },
  });
});

test("GDELT research route exposes bounded media-signal coverage", async () => {
  const retrievedAt = "2026-07-10T08:29:59.000Z";
  const serverRespondedAt = "2026-07-10T08:30:00.000Z";
  const requests: Array<{ symbol: string; companyName: string }> = [];
  const alpaca = {
    trading: {
      assets: {
        getV2AssetsSymbolOrAssetId: async () => ({ name: "Apple Inc." }),
      },
    },
  } as unknown as Alpaca;
  const response = await route(
    "/api/research/gdelt?symbol=aapl",
    undefined,
    () => true,
    {
      alpaca,
      gdeltCompanySignals: async (symbol, companyName) => {
        requests.push({ symbol, companyName });
        return {
          symbol,
          companyName,
          query: '"Apple Inc." OR "AAPL"',
          windowDays: 7,
          available: true,
          rateLimited: false,
          filteredOut: 0,
          articles: [],
          sources: [],
          warnings: [],
          retrievedAt,
          serverRespondedAt,
          time: {
            observationTime: null,
            publicationTime: null,
            effectivePeriod: null,
            retrievalTime: retrievedAt,
            serverResponseTime: serverRespondedAt,
          },
          asOf: serverRespondedAt,
        };
      },
    },
  );
  expect(requests).toEqual([{ symbol: "AAPL", companyName: "Apple Inc." }]);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    available: true,
    quality: {
      status: "complete",
      expected: { providerQuery: 1, boundedWindow: 1 },
      received: { providerQuery: 1, boundedWindow: 1 },
      omitted: { providerQuery: 0, boundedWindow: 0 },
      impact: [expect.stringContaining("does not prove")],
    },
  });
});

test("Finnhub research route preserves explicit missing-retrieval time provenance", async () => {
  const serverRespondedAt = "2026-07-10T08:30:00.000Z";
  let requestedSymbol = "";
  const response = await route(
    "/api/research/finnhub?symbol=aapl",
    undefined,
    () => true,
    {
      finnhubCompanyEnrichment: async (symbol) => {
        requestedSymbol = symbol;
        return {
          symbol,
          configured: false,
          status: "missing_key",
          profile: null,
          earnings: [],
          news: [],
          sources: [],
          coverage: {
            profile: "missing_key",
            earnings: "missing_key",
            news: "missing_key",
          },
          endpointTimes: { profile: null, earnings: null, news: null },
          warnings: ["Optional Finnhub enrichment is not configured."],
          retrievedAt: null,
          serverRespondedAt,
          time: {
            observationTime: null,
            publicationTime: null,
            effectivePeriod: null,
            retrievalTime: null,
            serverResponseTime: serverRespondedAt,
          },
          asOf: serverRespondedAt,
        };
      },
    },
  );
  expect(requestedSymbol).toBe("AAPL");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    symbol: "AAPL",
    configured: false,
    status: "missing_key",
    profile: null,
    earnings: [],
    news: [],
    sources: [],
    coverage: {
      profile: "missing_key",
      earnings: "missing_key",
      news: "missing_key",
    },
    endpointTimes: { profile: null, earnings: null, news: null },
    warnings: ["Optional Finnhub enrichment is not configured."],
    retrievedAt: null,
    serverRespondedAt,
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: null,
      serverResponseTime: serverRespondedAt,
    },
    asOf: serverRespondedAt,
    quality: {
      status: "partial",
      received: { configuredProvider: 0, endpointResults: 0 },
      omitted: { configuredProvider: 1, endpointResults: 3 },
      freshness: { status: "unavailable", retrievedAt: null },
    },
  });
});

test("OpenFIGI research route preserves provider retrieval and response time", async () => {
  const retrievedAt = "2026-07-10T08:29:59.000Z";
  const serverRespondedAt = "2026-07-10T08:30:00.000Z";
  let requestedSymbol = "";
  let requestedCompanyName = "";
  const alpaca = {
    trading: {
      assets: {
        getV2AssetsSymbolOrAssetId: async () => ({ name: "Apple Inc." }),
      },
    },
  } as unknown as Alpaca;
  const response = await route(
    "/api/research/openfigi?symbol=aapl",
    undefined,
    () => true,
    {
      alpaca,
      openFigiIdentity: async (symbol, companyName) => {
        requestedSymbol = symbol;
        requestedCompanyName = companyName;
        return {
          symbol,
          companyName,
          status: "rate_limited",
          keyStatus: "anonymous",
          matchQuality: null,
          canonicalFigi: null,
          selected: null,
          candidates: [],
          candidateCount: 0,
          sources: [],
          warnings: [
            "OpenFIGI identity mapping is rate limited; no ticker-to-FIGI join should be assumed.",
          ],
          retrievedAt,
          serverRespondedAt,
          time: {
            observationTime: null,
            publicationTime: null,
            effectivePeriod: null,
            retrievalTime: retrievedAt,
            serverResponseTime: serverRespondedAt,
          },
          asOf: serverRespondedAt,
        };
      },
    },
  );
  expect(requestedSymbol).toBe("AAPL");
  expect(requestedCompanyName).toBe("Apple Inc.");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    symbol: "AAPL",
    status: "rate_limited",
    retrievedAt,
    serverRespondedAt,
    asOf: serverRespondedAt,
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: retrievedAt,
      serverResponseTime: serverRespondedAt,
    },
    quality: {
      status: "partial",
      received: {
        providerQuery: 0,
        canonicalMapping: 0,
        candidateEvidence: 0,
      },
      freshness: { status: "partial_provider_time" },
    },
  });
});
