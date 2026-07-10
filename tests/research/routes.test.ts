import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { handleResearchRequest } from "../../backend/features/research/routes";
import type { FinnhubCompanyEnrichment } from "../../backend/integrations/finnhub";
import type { OpenFigiIdentity } from "../../backend/integrations/openfigi";
import { createStore } from "../../backend/persistence/store";

type RouteOptions = {
  alpaca?: Alpaca;
  finnhubCompanyEnrichment?: (
    symbol: string,
  ) => Promise<FinnhubCompanyEnrichment>;
  openFigiIdentity?: (
    symbol: string,
    companyName: string,
  ) => Promise<OpenFigiIdentity>;
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
    store: createStore(":memory:"),
    actor: "test-researcher",
    allow,
    env: {},
    finnhubCompanyEnrichment: options.finnhubCompanyEnrichment,
    openFigiIdentity: options.openFigiIdentity,
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
