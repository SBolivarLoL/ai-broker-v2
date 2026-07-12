import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { handleResearchRequest } from "../../backend/features/research/routes";
import type { FinnhubCompanyEnrichment } from "../../backend/integrations/finnhub";
import type { OpenFigiIdentity } from "../../backend/integrations/openfigi";
import type { MacroContext } from "../../backend/integrations/macro-context";
import { createStore } from "../../backend/persistence/store";
import type { getCompanySecEvidence } from "../../backend/features/research/research";
import type {
  getComparableValuations,
  getValuationScenarios,
  runCompanyResearch,
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
    peers: string,
  ) => ReturnType<typeof getComparableValuations>;
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
    openFigiIdentity: options.openFigiIdentity,
    secCompanyEvidence: options.secCompanyEvidence,
    officialMacroContext: options.officialMacroContext,
    comparableValuations: options.comparableValuations,
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
    schemaVersion: "comparable-valuations-v2",
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
        comparableInputs.push([symbol, peers]);
        return comparablePayload;
      },
    },
  );
  expect(comparableInputs).toEqual([["aapl", "MSFT"]]);
  expect(comparable?.status).toBe(200);
  expect(await comparable?.json()).toEqual(comparablePayload);

  const scenarioPayload = {
    schemaVersion: "valuation-scenarios-v2",
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
  expect(await response?.json()).toEqual(payload);

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
  expect(await response?.json()).toEqual(payload);
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
  expect(await response?.json()).toEqual({
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
  });
});
