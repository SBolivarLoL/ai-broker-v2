import {
  normalizeIsoTime,
  providerTimeFields,
  type NormalizedEffectivePeriod,
} from "../../shared/time-provenance";
import {
  ledgerSummary,
  type LedgerActivity,
} from "./ledger";

type DateInput = string | number | Date;

const brokerSource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  environment: "paper" as const,
  endpoint: "account-activities" as const,
};

const ledgerSource = {
  provider: "local" as const,
  component: "fifo-account-ledger" as const,
  input: brokerSource,
};

function validIso(value: unknown) {
  if (
    !(
      typeof value === "string" ||
      typeof value === "number" ||
      value instanceof Date
    )
  )
    return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function validEffectivePeriod(value: unknown): NormalizedEffectivePeriod | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const period = value as Record<string, unknown>;
  const start = validIso(period.start);
  const end = validIso(period.end);
  const label = typeof period.label === "string" && period.label.trim()
    ? period.label.trim()
    : null;
  if (!start && !end && !label) return null;
  if (start && end && start > end) return null;
  return { start, end, label };
}

function activityTimeFields(
  activity: LedgerActivity,
  serverRespondedAt: DateInput,
) {
  const observedAt = validIso(activity.observedAt);
  const publishedAt = validIso(activity.publishedAt);
  const effectivePeriod = validEffectivePeriod(activity.effectivePeriod);
  const retrievedAt = validIso(activity.retrievedAt);
  const responseTime = normalizeIsoTime(
    serverRespondedAt,
    "Account activity response time",
  );
  return {
    observedAt,
    publishedAt,
    effectivePeriod,
    retrievedAt,
    serverRespondedAt: responseTime,
    time: {
      observationTime: observedAt,
      publicationTime: publishedAt,
      effectivePeriod,
      retrievalTime: retrievedAt,
      serverResponseTime: responseTime,
    },
    asOf: responseTime,
  };
}

export function accountActivityDto(
  activity: LedgerActivity,
  serverRespondedAt: DateInput,
) {
  const {
    observedAt: _observedAt,
    publishedAt: _publishedAt,
    effectivePeriod: _effectivePeriod,
    retrievedAt: _retrievedAt,
    ...ledgerActivity
  } = activity;
  return {
    ...ledgerActivity,
    source: brokerSource,
    ...activityTimeFields(activity, serverRespondedAt),
  };
}

function latest(values: (string | null)[]) {
  return (
    values
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null
  );
}

function historyPeriod(activities: LedgerActivity[]) {
  const starts = activities
    .flatMap((activity) => {
      const observedAt = validIso(activity.observedAt);
      const effectivePeriod = validEffectivePeriod(activity.effectivePeriod);
      return [
        observedAt,
        effectivePeriod?.start ?? effectivePeriod?.end ?? null,
      ];
    })
    .filter((value): value is string => value !== null)
    .sort();
  const ends = activities
    .flatMap((activity) => {
      const observedAt = validIso(activity.observedAt);
      const effectivePeriod = validEffectivePeriod(activity.effectivePeriod);
      return [
        observedAt,
        effectivePeriod?.end ?? effectivePeriod?.start ?? null,
      ];
    })
    .filter((value): value is string => value !== null)
    .sort();
  return starts.length && ends.length
    ? {
        start: starts[0]!,
        end: ends.at(-1)!,
        label: "Imported account activity history",
      }
    : null;
}

export function accountActivitiesDto(input: {
  activities: LedgerActivity[];
  allActivities: LedgerActivity[];
  imported: number;
  truncated: boolean;
  cacheHit: boolean;
  retrievedAt: DateInput;
  serverRespondedAt: DateInput;
}) {
  const rootTime = providerTimeFields({
    observationTime: latest(
      input.allActivities.map((activity) => validIso(activity.observedAt)),
    ),
    publicationTime: latest(
      input.allActivities.map((activity) => validIso(activity.publishedAt)),
    ),
    effectivePeriod: historyPeriod(input.allActivities),
    retrievalTime: input.retrievedAt,
    serverResponseTime: input.serverRespondedAt,
  });
  const rowDtos = input.activities.map((activity) =>
    accountActivityDto(activity, input.serverRespondedAt)
  );
  const missingRetrieval = input.allActivities.filter(
    (activity) => validIso(activity.retrievedAt) === null,
  ).length;
  const missingProviderTime = input.allActivities.filter(
    (activity) =>
      validIso(activity.observedAt) === null &&
      validIso(activity.publishedAt) === null &&
      validEffectivePeriod(activity.effectivePeriod) === null,
  ).length;
  const missing = [
    ...(missingRetrieval
      ? [`${missingRetrieval} stored activities have no preserved retrieval time.`]
      : []),
    ...(missingProviderTime
      ? [`${missingProviderTime} stored activities have no preserved provider time taxonomy.`]
      : []),
  ];
  const summary = {
    ...ledgerSummary(input.allActivities, input.truncated),
    source: ledgerSource,
    ...rootTime,
  };

  return {
    schemaVersion: "account-activities-v2",
    summary,
    activities: rowDtos,
    imported: input.imported,
    cache: { hit: input.cacheHit, ttlSeconds: 30 },
    quality: {
      status: missing.length ? "partial" : "complete",
      expected: { storedActivities: input.allActivities.length },
      received: {
        storedActivities: input.allActivities.length,
        withRetrievalTime: input.allActivities.length - missingRetrieval,
        withProviderTime: input.allActivities.length - missingProviderTime,
      },
      missing,
      source: brokerSource,
      ...rootTime,
    },
    source: brokerSource,
    ...rootTime,
  };
}
