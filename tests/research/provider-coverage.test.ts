import { expect, test } from "bun:test";
import { canonicalEvidence } from "../../backend/shared/evidence";
import {
  buildFinnhubResearchCoverage,
  buildGdeltResearchCoverage,
  buildMacroResearchCoverage,
  buildOpenFigiResearchCoverage,
  buildSecResearchCoverage,
} from "../../backend/features/research/provider-coverage";
import type { FinnhubCompanyEnrichment } from "../../backend/integrations/finnhub";
import type { GdeltCompanySignals } from "../../backend/integrations/gdelt";
import type { MacroContext } from "../../backend/integrations/macro-context";
import type { OpenFigiIdentity } from "../../backend/integrations/openfigi";
import type { ResearchEvidence } from "../../backend/features/research/research";

const retrievedAt = "2026-07-12T11:59:00.000Z";
const serverRespondedAt = "2026-07-12T12:00:00.000Z";
const time = {
  observationTime: null,
  publicationTime: null,
  effectivePeriod: null,
  retrievalTime: retrievedAt,
  serverResponseTime: serverRespondedAt,
} as const;

function evidence(
  id: string,
  category: ResearchEvidence["category"],
  data: unknown,
  semantic = true,
) {
  return canonicalEvidence({
    id,
    provider: id.startsWith("sec:") ? "sec" : "fixture",
    sourceId: id,
    category,
    authority: id.startsWith("sec:") ? "official" : "licensed_provider",
    claimStatus: id.startsWith("sec:")
      ? "official_record"
      : "provider_record",
    title: id,
    url: `https://example.com/${encodeURIComponent(id)}`,
    asOf: serverRespondedAt,
    observedAt: semantic ? "2026-07-10T15:30:00.000Z" : null,
    retrievedAt,
    serverRespondedAt,
    publishedAt: semantic ? "2026-07-11T00:00:00.000Z" : null,
    effectivePeriod: semantic
      ? {
          start: "2026-06-01T00:00:00.000Z",
          end: "2026-06-30T23:59:59.999Z",
          label: "Fixture period",
        }
      : null,
    entityIds: { symbol: "AAPL" },
    data,
  });
}

test("SEC coverage requires filing, fact, trend, section, hash, and semantic-time evidence", () => {
  const sources = [
    evidence("sec:filings:AAPL", "filings", {
      filings: [{ form: "10-K" }],
    }),
    evidence("sec:section:AAPL:1", "filings", { title: "Risk Factors" }),
    evidence("sec:facts:AAPL", "fundamentals", {
      facts: { revenue: { value: 1000 } },
      trends: { metrics: [{ id: "revenue" }] },
    }),
  ];
  const quality = buildSecResearchCoverage({
    sources,
    retrievedAt,
    serverRespondedAt,
    pointInTime: {
      classification: {
        status: "unavailable",
        reason: "Historical SIC is unavailable.",
      },
    },
  });
  expect(quality).toMatchObject({
    status: "complete",
    received: {
      filingMetadataSet: 1,
      fundamentalFactSet: 1,
      financialTrendSet: 1,
      filingSectionSet: 1,
      canonicalSourceHashes: 3,
      semanticTimeRecords: 3,
    },
    omitted: {
      filingMetadataSet: 0,
      fundamentalFactSet: 0,
      financialTrendSet: 0,
      filingSectionSet: 0,
    },
    freshness: {
      status: "semantic_time_available",
      latestPublishedAt: "2026-07-11T00:00:00.000Z",
    },
  });
});

test("macro coverage distinguishes required, optional, indicator, and regime evidence", () => {
  const macroSource = canonicalEvidence({
    id: "macro:fixture",
    provider: "treasury",
    sourceId: "fixture",
    category: "macro" as const,
    authority: "official" as const,
    claimStatus: "official_record" as const,
    title: "Macro fixture",
    url: "https://example.com/macro",
    asOf: serverRespondedAt,
    observedAt: "2026-07-11T00:00:00.000Z",
    retrievedAt,
    serverRespondedAt,
    entityIds: {},
    data: { value: 4.25 },
  });
  const provider = {
    status: "available" as const,
    indicators: 1,
    retrievedAt,
    serverRespondedAt,
    time,
    asOf: serverRespondedAt,
  };
  const result = {
    retrievedAt,
    serverRespondedAt,
    time,
    asOf: serverRespondedAt,
    indicators: [{ id: "rate" }],
    regime: {
      summary: "Fixture",
      dimensions: ["rates", "inflation", "labor", "growth", "fiscal"].map(
        (id) => ({ id, label: id, state: "neutral", summary: id, evidence: [] }),
      ),
      evidence: [],
    },
    sources: [macroSource],
    warnings: [],
    coverage: {
      fred: provider,
      treasury: provider,
      bls: provider,
      bea: provider,
    },
    disclosures: [],
  } as unknown as MacroContext;
  expect(buildMacroResearchCoverage(result)).toMatchObject({
    status: "complete",
    received: {
      requiredProviders: 2,
      optionalProviders: 2,
      indicatorSet: 1,
      regimeDimensions: 5,
      canonicalSources: 1,
      semanticTimeRecords: 1,
    },
  });
});

test("optional-provider coverage keeps empty media, complete enrichment, and retrieval-only identity consequential", () => {
  const gdelt = {
    symbol: "AAPL",
    companyName: "Apple Inc.",
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
    time,
    asOf: serverRespondedAt,
  } satisfies GdeltCompanySignals;
  expect(buildGdeltResearchCoverage(gdelt)).toMatchObject({
    status: "complete",
    freshness: { status: "partial_provider_time" },
    impact: [expect.stringContaining("does not prove")],
  });

  const finnhubSources = [
    evidence("finnhub:profile:AAPL", "identity", { name: "Apple Inc." }),
    evidence("finnhub:earnings:AAPL", "fundamentals", { actual: 1 }),
    evidence("finnhub:news:AAPL", "news", { headline: "Fixture" }),
  ];
  const finnhub = {
    symbol: "AAPL",
    configured: true,
    status: "available",
    profile: { name: "Apple Inc." },
    earnings: [],
    news: [],
    sources: finnhubSources,
    coverage: { profile: "available", earnings: "available", news: "available" },
    endpointTimes: { profile: null, earnings: null, news: null },
    warnings: [],
    retrievedAt,
    serverRespondedAt,
    time,
    asOf: serverRespondedAt,
  } as unknown as FinnhubCompanyEnrichment;
  expect(buildFinnhubResearchCoverage(finnhub)).toMatchObject({
    status: "complete",
    received: {
      configuredProvider: 1,
      endpointResults: 3,
      semanticTimeRecords: 3,
    },
  });

  const identitySource = evidence(
    "openfigi:AAPL",
    "identity",
    { figi: "BBG000B9XRY4" },
    false,
  );
  const openfigi = {
    symbol: "AAPL",
    companyName: "Apple Inc.",
    status: "matched",
    keyStatus: "anonymous",
    matchQuality: "company_name_confirmed",
    canonicalFigi: "BBG000B9XRY4",
    selected: { figi: "BBG000B9XRY4" },
    candidates: [{ figi: "BBG000B9XRY4" }],
    candidateCount: 1,
    sources: [identitySource],
    warnings: [],
    retrievedAt,
    serverRespondedAt,
    time,
    asOf: serverRespondedAt,
  } as unknown as OpenFigiIdentity;
  expect(buildOpenFigiResearchCoverage(openfigi)).toMatchObject({
    status: "partial",
    received: { canonicalMapping: 1, candidateEvidence: 1 },
    omitted: { semanticTimeRecords: 1 },
    freshness: { status: "partial_provider_time" },
    impact: [expect.stringContaining("supports cross-provider")],
  });
});
