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
  let requestedSymbol = "";
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
    sources: [],
    deduplication: { duplicates: [], revisions: [] },
  };
  const response = await route(
    "/api/research/sec?symbol=aapl",
    undefined,
    () => true,
    {
      secCompanyEvidence: async (symbol) => {
        requestedSymbol = symbol;
        return payload;
      },
    },
  );
  expect(requestedSymbol).toBe("AAPL");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(payload);
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
  const response = await route(
    "/api/research/macro",
    undefined,
    () => true,
    { officialMacroContext: async () => payload },
  );
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
