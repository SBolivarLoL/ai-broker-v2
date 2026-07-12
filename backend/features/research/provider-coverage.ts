/** Calculation-level coverage contracts for visible provider research reports. */
import type { GdeltCompanySignals } from "../../integrations/gdelt";
import type { FinnhubCompanyEnrichment } from "../../integrations/finnhub";
import type { MacroContext } from "../../integrations/macro-context";
import type { OpenFigiIdentity } from "../../integrations/openfigi";
import type { ResearchEvidence } from "./research";

type Counts = Record<string, number>;
type TimeRecord = {
  observedAt?: string | null;
  publishedAt?: string | null;
  effectivePeriod?: {
    start?: string | null;
    end?: string | null;
  } | null;
};

type SecResearchResult = {
  sources: ResearchEvidence[];
  retrievedAt: string;
  serverRespondedAt: string;
  pointInTime: {
    classification: { status: "unavailable"; reason: string };
  };
};

function latest(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .toSorted()
    .at(-1) ?? null;
}

function semanticTime(records: TimeRecord[]) {
  const starts = records
    .map((record) => record.effectivePeriod?.start)
    .filter((value): value is string => Boolean(value))
    .toSorted();
  const ends = records
    .map((record) => record.effectivePeriod?.end)
    .filter((value): value is string => Boolean(value))
    .toSorted();
  return {
    latestObservedAt: latest(records.map((record) => record.observedAt)),
    latestPublishedAt: latest(records.map((record) => record.publishedAt)),
    effectivePeriod:
      starts.length || ends.length
        ? {
            start: starts[0] ?? null,
            end: ends.at(-1) ?? null,
            label: "Provider research evidence periods",
          }
        : null,
  };
}

function coverageQuality({
  expected,
  received,
  records,
  retrievedAt,
  evaluatedAt,
  missing,
  impact,
  source,
}: {
  expected: Counts;
  received: Counts;
  records: TimeRecord[];
  retrievedAt: string | null;
  evaluatedAt: string;
  missing: string[];
  impact: string[];
  source: string;
}) {
  const omitted = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      Math.max(0, value - (received[key] ?? 0)),
    ]),
  );
  const time = semanticTime(records);
  const semanticTimes = records.filter(
    (record) =>
      record.observedAt || record.publishedAt || record.effectivePeriod,
  ).length;
  const omissionCount = Object.values(omitted).reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    status: omissionCount || missing.length ? ("partial" as const) : ("complete" as const),
    expected,
    received,
    omitted,
    freshness: {
      status: !retrievedAt
        ? ("unavailable" as const)
        : !records.length || semanticTimes < records.length
          ? ("partial_provider_time" as const)
          : ("semantic_time_available" as const),
      ...time,
      retrievedAt,
      evaluatedAt,
      agePolicy: "source_specific_semantic_time" as const,
    },
    missing,
    impact,
    source,
  };
}

function sourceHasSemanticTime(source: TimeRecord) {
  return Boolean(
    source.observedAt || source.publishedAt || source.effectivePeriod,
  );
}

export function buildSecResearchCoverage(result: SecResearchResult) {
  const filings = result.sources.find((source) =>
    source.id.startsWith("sec:filings:"),
  );
  const facts = result.sources.find((source) =>
    source.id.startsWith("sec:facts:"),
  );
  const sections = result.sources.filter((source) =>
    source.id.startsWith("sec:section:"),
  );
  const filingRecords = Array.isArray(
    (filings?.data as { filings?: unknown[] } | undefined)?.filings,
  )
    ? (filings!.data as { filings: unknown[] }).filings.length
    : 0;
  const factData = facts?.data as
    | { facts?: Record<string, unknown>; trends?: { metrics?: unknown[] } }
    | undefined;
  const factCount = Object.keys(factData?.facts ?? {}).length;
  const trendCount = Array.isArray(factData?.trends?.metrics)
    ? factData.trends.metrics.length
    : 0;
  const expected = {
    filingMetadataSet: 1,
    fundamentalFactSet: 1,
    financialTrendSet: 1,
    filingSectionSet: 1,
    canonicalSourceHashes: result.sources.length,
    semanticTimeRecords: result.sources.length,
  };
  const received = {
    filingMetadataSet: filingRecords ? 1 : 0,
    fundamentalFactSet: factCount ? 1 : 0,
    financialTrendSet: trendCount ? 1 : 0,
    filingSectionSet: sections.length ? 1 : 0,
    canonicalSourceHashes: result.sources.filter((source) =>
      /^sha256:[a-f0-9]{64}$/.test(source.contentHash),
    ).length,
    semanticTimeRecords: result.sources.filter(sourceHasSemanticTime).length,
  };
  const missing = [
    ...(!filingRecords ? ["No eligible SEC filing metadata was returned."] : []),
    ...(!factCount ? ["No selected SEC fundamental facts were returned."] : []),
    ...(!trendCount ? ["No comparable SEC financial trends were available."] : []),
    ...(!sections.length ? ["No supported accession-linked filing section was extracted."] : []),
    ...(received.semanticTimeRecords < expected.semanticTimeRecords
      ? ["Some SEC records expose retrieval time without filing publication or report-period evidence."]
      : []),
  ];
  const impact = [
    ...(!filingRecords || !factCount
      ? ["Missing official filing or fundamental evidence makes the company review incomplete."]
      : []),
    ...(!trendCount
      ? ["Without comparable periods, direction and cadence cannot be evaluated from this report."]
      : []),
    ...(!sections.length
      ? ["Risk-factor and management-discussion conclusions lack extracted section context."]
      : []),
    result.pointInTime.classification.reason,
  ];
  return coverageQuality({
    expected,
    received,
    records: result.sources,
    retrievedAt: result.retrievedAt,
    evaluatedAt: result.serverRespondedAt,
    missing,
    impact,
    source: "Official SEC filing, fact, trend, section, hash, and semantic-time coverage",
  });
}

export function buildMacroResearchCoverage(result: MacroContext) {
  const available = (provider: keyof MacroContext["coverage"]) =>
    ["available", "partial"].includes(result.coverage[provider].status);
  const expected = {
    requiredProviders: 2,
    optionalProviders: 2,
    indicatorSet: 1,
    regimeDimensions: 5,
    canonicalSources: result.sources.length,
    semanticTimeRecords: result.sources.length,
  };
  const received = {
    requiredProviders: ["treasury", "bls"].filter((provider) =>
      available(provider as "treasury" | "bls"),
    ).length,
    optionalProviders: ["fred", "bea"].filter((provider) =>
      available(provider as "fred" | "bea"),
    ).length,
    indicatorSet: result.indicators.length ? 1 : 0,
    regimeDimensions: Math.min(5, result.regime.dimensions.length),
    canonicalSources: result.sources.length,
    semanticTimeRecords: result.sources.filter(sourceHasSemanticTime).length,
  };
  const missingProviders = Object.entries(result.coverage)
    .filter(([, value]) => !["available", "partial"].includes(value.status))
    .map(([provider, value]) => `${provider.toUpperCase()} is ${value.status.replaceAll("_", " ")}.`);
  const missing = [
    ...missingProviders,
    ...(!result.indicators.length
      ? ["No official macro indicators were returned."]
      : []),
    ...(received.regimeDimensions < expected.regimeDimensions
      ? [`${expected.regimeDimensions - received.regimeDimensions} macro regime dimensions lack usable observations.`]
      : []),
    ...(received.semanticTimeRecords < expected.semanticTimeRecords
      ? ["Some macro evidence lacks observation, publication, or effective-period time."]
      : []),
  ];
  return coverageQuality({
    expected,
    received,
    records: result.sources,
    retrievedAt: result.retrievedAt,
    evaluatedAt: result.serverRespondedAt,
    missing,
    impact: missing.length
      ? ["Unavailable providers or dimensions narrow the descriptive macro regime; missing data is not a neutral signal."]
      : ["All required and optional provider groups and five descriptive regime dimensions are represented."],
    source: "Official macro provider, regime-dimension, canonical-source, and semantic-time coverage",
  });
}

export function buildGdeltResearchCoverage(result: GdeltCompanySignals) {
  const expected = {
    providerQuery: 1,
    boundedWindow: 1,
    articlePublicationTimes: result.articles.length,
    canonicalSources: result.articles.length,
  };
  const received = {
    providerQuery: result.available ? 1 : 0,
    boundedWindow: result.query && result.windowDays > 0 ? 1 : 0,
    articlePublicationTimes: result.articles.filter((article) => article.publishedAt).length,
    canonicalSources: result.sources.length,
  };
  const missing = [
    ...(!result.available
      ? [`GDELT query coverage is ${result.rateLimited ? "rate limited" : "unavailable"}.`]
      : []),
    ...(received.articlePublicationTimes < expected.articlePublicationTimes
      ? ["Some returned GDELT articles lack publication time."]
      : []),
    ...(received.canonicalSources < expected.canonicalSources
      ? ["Some returned articles lack canonical evidence records."]
      : []),
  ];
  const impact = !result.available
    ? ["Broad public-web media context is unavailable; do not infer that no material event exists."]
    : !result.articles.length
      ? ["The bounded query returned no headline-relevant signals; this does not prove that no event exists."]
      : ["Returned items are public-web media signals, not verified company facts."];
  return coverageQuality({
    expected,
    received,
    records: result.articles,
    retrievedAt: result.retrievedAt,
    evaluatedAt: result.serverRespondedAt,
    missing,
    impact,
    source: "Bounded GDELT query, publication-time, and canonical-evidence coverage",
  });
}

export function buildFinnhubResearchCoverage(result: FinnhubCompanyEnrichment) {
  const endpointAvailable = (name: keyof FinnhubCompanyEnrichment["coverage"]) =>
    result.coverage[name] === "available";
  const expected = {
    configuredProvider: 1,
    endpointResults: 3,
    profileDataset: 1,
    earningsDataset: 1,
    newsDataset: 1,
    semanticTimeRecords: result.sources.length,
  };
  const received = {
    configuredProvider: result.configured ? 1 : 0,
    endpointResults: Object.values(result.coverage).filter((status) => status === "available").length,
    profileDataset: endpointAvailable("profile") && result.profile ? 1 : 0,
    earningsDataset: endpointAvailable("earnings") ? 1 : 0,
    newsDataset: endpointAvailable("news") ? 1 : 0,
    semanticTimeRecords: result.sources.filter(sourceHasSemanticTime).length,
  };
  const missing = [
    ...(!result.configured ? ["Optional Finnhub API access is not configured."] : []),
    ...Object.entries(result.coverage)
      .filter(([, status]) => status !== "available")
      .map(([endpoint, status]) => `Finnhub ${endpoint} is ${status.replaceAll("_", " ")}.`),
    ...(received.semanticTimeRecords < expected.semanticTimeRecords
      ? ["Some Finnhub evidence lacks publication or effective-period time."]
      : []),
  ];
  return coverageQuality({
    expected,
    received,
    records: result.sources,
    retrievedAt: result.retrievedAt,
    evaluatedAt: result.serverRespondedAt,
    missing,
    impact: missing.length
      ? ["Optional profile, earnings, or media context is incomplete; SEC evidence remains authoritative for reported fundamentals."]
      : ["All three optional Finnhub endpoint datasets returned; they supplement but do not override SEC evidence."],
    source: "Finnhub configuration, endpoint, dataset, and semantic-time coverage",
  });
}

export function buildOpenFigiResearchCoverage(result: OpenFigiIdentity) {
  const expected = {
    providerQuery: 1,
    canonicalMapping: 1,
    candidateEvidence: 1,
    canonicalSources: 1,
    semanticTimeRecords: result.sources.length,
  };
  const providerResponded = ["matched", "ambiguous", "not_found"].includes(result.status);
  const received = {
    providerQuery: providerResponded ? 1 : 0,
    canonicalMapping: result.selected && result.canonicalFigi ? 1 : 0,
    candidateEvidence: result.candidateCount ? 1 : 0,
    canonicalSources: Math.min(1, result.sources.length),
    semanticTimeRecords: result.sources.filter(sourceHasSemanticTime).length,
  };
  const missing = [
    ...(!providerResponded ? [`OpenFIGI mapping is ${result.status.replaceAll("_", " ")}.`] : []),
    ...(!result.selected ? ["No unambiguous canonical FIGI was selected."] : []),
    ...(!result.candidateCount ? ["No US-equity mapping candidate was returned."] : []),
    ...(received.semanticTimeRecords < expected.semanticTimeRecords
      ? ["OpenFIGI identity records expose retrieval time but no provider observation time."]
      : []),
  ];
  return coverageQuality({
    expected,
    received,
    records: result.sources,
    retrievedAt: result.retrievedAt,
    evaluatedAt: result.serverRespondedAt,
    missing,
    impact: result.selected
      ? ["The selected FIGI supports cross-provider identity joins; ticker text remains display metadata."]
      : ["Cross-provider joins remain symbol-scoped because identity is missing or ambiguous."],
    source: "OpenFIGI query, candidate, canonical-mapping, source, and semantic-time coverage",
  });
}
