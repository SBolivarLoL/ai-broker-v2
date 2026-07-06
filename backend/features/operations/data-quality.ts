/** Provider-health and dataset-quality reporting from local evidence. */
import type { DataGovernanceSource } from "./data-governance";

type QualityEvent = {
  type: string;
  payload?: unknown;
  createdAt?: string;
};
type DatasetQualityInput = {
  id: string;
  provider: string;
  feed: string;
  timeframe: string;
  symbols: string[];
  start: string;
  end: string;
  datasetHash: string;
  previousDatasetId: string | null;
  stats: {
    requestedBars: number;
    acceptedBars: number;
    rejectedBars: number;
    duplicateBars: number;
    conflictingDuplicates: number;
    gapCount: number;
    addedBars: number;
    correctedBars: number;
    removedBars: number;
    observedStart: string | null;
    observedEnd: string | null;
  };
  createdAt?: string;
};

const successPatterns: Record<string, RegExp[]> = {
  alpaca_paper_trading: [/^order\./, /^option\./, /^strategy\.paper\./, /^strategy\.crypto\.order/],
  alpaca_equity_iex: [/^order\.preview$/, /^portfolio\./, /^market\./],
  alpaca_crypto_data: [/^strategy\.dataset\.ingested$/, /^strategy\.crypto\./, /^strategy\.(shadow|paper)\.tick$/],
  alpaca_news_benzinga: [/^research\.completed$/, /^market\.monitoring/],
  gdelt_doc_2: [/^research\.completed$/],
  finnhub_free_enrichment: [/^research\.completed$/],
  openfigi_v3: [/^research\.completed$/],
  sec_edgar: [/^research\.completed$/],
  treasury_fiscal_data: [/^research\.completed$/],
  bls_public_data: [/^research\.completed$/],
  fred_api: [/^research\.completed$/],
  bea_data_api: [/^research\.completed$/],
  openai_api: [/^agent\./, /^research\.completed$/],
  local_derived_analytics: [/^strategy\./, /^portfolio\./, /^operations\./, /^otel\./],
};

function validDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function eventText(event: QualityEvent) {
  return `${event.type} ${JSON.stringify(event.payload ?? {})}`.toLowerCase();
}

function isIssue(event: QualityEvent) {
  return /error|failed|rejected|blocked|stale|invalid|malformed|gap|missing/i.test(
    eventText(event),
  );
}

function isThrottle(event: QualityEvent) {
  return /throttle|rate.?limit|429/.test(eventText(event));
}

function sourceEvents(sourceId: string, events: QualityEvent[]) {
  const patterns = successPatterns[sourceId] ?? [];
  return events.filter((event) => patterns.some((pattern) => pattern.test(event.type)));
}

function latestAt(events: QualityEvent[]) {
  const dates = events
    .map((event) => validDate(event.createdAt))
    .filter((date): date is Date => Boolean(date))
    .sort((left, right) => right.getTime() - left.getTime());
  return dates[0]?.toISOString() ?? null;
}

function providerStatus(input: {
  successes: QualityEvent[];
  issues: QualityEvent[];
  throttles: QualityEvent[];
  generatedAt: Date;
}) {
  if (input.throttles.length) return "throttled";
  if (input.issues.length) return "degraded";
  const latestSuccess = latestAt(input.successes);
  if (!latestSuccess) return "unobserved";
  const ageHours =
    (input.generatedAt.getTime() - new Date(latestSuccess).getTime()) / 3_600_000;
  return ageHours <= 24 ? "healthy" : "stale";
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

function datasetQuality(dataset: DatasetQualityInput, generatedAt: Date) {
  const stats = dataset.stats;
  const issueCount =
    stats.rejectedBars +
    stats.conflictingDuplicates +
    stats.gapCount;
  const revisionCount =
    stats.addedBars + stats.correctedBars + stats.removedBars;
  const createdAt = validDate(dataset.createdAt);
  const observedEnd = validDate(stats.observedEnd);
  const freshnessBasis = observedEnd ?? createdAt;
  const freshnessAgeHours = freshnessBasis
    ? Number(((generatedAt.getTime() - freshnessBasis.getTime()) / 3_600_000).toFixed(3))
    : null;
  return {
    id: dataset.id,
    provider: dataset.provider,
    feed: dataset.feed,
    timeframe: dataset.timeframe,
    symbols: dataset.symbols,
    start: dataset.start,
    end: dataset.end,
    datasetHash: dataset.datasetHash,
    previousDatasetId: dataset.previousDatasetId,
    status:
      stats.acceptedBars <= 0
        ? "fail"
        : issueCount || revisionCount
          ? "warning"
          : "pass",
    freshness: {
      observedStart: stats.observedStart,
      observedEnd: stats.observedEnd,
      datasetCreatedAt: dataset.createdAt ?? null,
      freshnessAgeHours,
    },
    completeness: {
      requestedBars: stats.requestedBars,
      acceptedBars: stats.acceptedBars,
      acceptedRatio: ratio(stats.acceptedBars, Math.max(stats.requestedBars, 1)),
      gapCount: stats.gapCount,
    },
    integrity: {
      rejectedBars: stats.rejectedBars,
      schemaFailureRate: ratio(stats.rejectedBars, Math.max(stats.requestedBars, 1)),
      duplicateBars: stats.duplicateBars,
      duplicateRate: ratio(stats.duplicateBars, Math.max(stats.requestedBars, 1)),
      conflictingDuplicates: stats.conflictingDuplicates,
    },
    revisions: {
      addedBars: stats.addedBars,
      correctedBars: stats.correctedBars,
      removedBars: stats.removedBars,
      revisionCount,
    },
  };
}

export function buildDataQualityReport(input: {
  sources: DataGovernanceSource[];
  events?: QualityEvent[];
  datasets?: DatasetQualityInput[];
  generatedAt?: string;
}) {
  const generatedAt = validDate(input.generatedAt) ?? new Date();
  const events = input.events ?? [];
  const providers = input.sources.map((source) => {
    const matches = sourceEvents(source.id, events);
    const issues = matches.filter(isIssue);
    const throttles = matches.filter(isThrottle);
    return {
      sourceId: source.id,
      provider: source.provider,
      category: source.category,
      entitlement: source.entitlement,
      status: providerStatus({
        successes: matches,
        issues,
        throttles,
        generatedAt,
      }),
      lastSuccessAt: latestAt(matches.filter((event) => !isIssue(event))),
      lastEventAt: latestAt(matches),
      eventCount: matches.length,
      issueCount: issues.length,
      throttlingEvents: throttles.length,
      coverage: source.coverage,
      liveUseDecision: source.liveUseDecision,
    };
  });
  const datasets = (input.datasets ?? []).map((dataset) =>
    datasetQuality(dataset, generatedAt),
  );
  return {
    reportVersion: "data-quality-v1",
    generatedAt: generatedAt.toISOString(),
    providers,
    datasets,
    summary: {
      providerCount: providers.length,
      healthyProviders: providers.filter((provider) => provider.status === "healthy").length,
      degradedProviders: providers.filter((provider) =>
        ["degraded", "throttled"].includes(provider.status),
      ).length,
      unobservedProviders: providers.filter((provider) => provider.status === "unobserved").length,
      datasetCount: datasets.length,
      warningDatasets: datasets.filter((dataset) => dataset.status === "warning").length,
      failedDatasets: datasets.filter((dataset) => dataset.status === "fail").length,
    },
    runbook: [
      "Provider health is derived from local success, failure, stale-data and throttle events; it is not an external entitlement approval.",
      "Dataset quality is derived from immutable strategy dataset stats: freshness, accepted bars, gaps, rejected bars, duplicates and revisions.",
      "Treat unobserved providers as unknown coverage, not healthy coverage.",
      "Investigate degraded or throttled providers before relying on new research, strategy, or order decisions.",
    ],
  };
}
