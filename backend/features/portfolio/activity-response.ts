import {
  normalizeIsoTime,
  providerTimeFields,
  type NormalizedEffectivePeriod,
} from "../../shared/time-provenance";
import { ledgerSummary, type LedgerActivity } from "./ledger";

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

function validEffectivePeriod(
  value: unknown,
): NormalizedEffectivePeriod | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const period = value as Record<string, unknown>;
  const start = validIso(period.start);
  const end = validIso(period.end);
  const label =
    typeof period.label === "string" && period.label.trim()
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
    accountActivityDto(activity, input.serverRespondedAt),
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
  const executedActivities = input.allActivities.filter(
    (activity) => activity.status !== "canceled",
  );
  const sellBasisUnits = executedActivities
    .filter(
      (activity) =>
        activity.category === "trade" &&
        activity.side === "sell" &&
        activity.quantity !== null &&
        Number.isFinite(activity.quantity) &&
        activity.quantity > 0,
    )
    .reduce((sum, activity) => sum + activity.quantity!, 0);
  const corporateActions = executedActivities.filter(
    (activity) => activity.category === "corporate_action",
  ).length;
  const summary = {
    ...ledgerSummary(input.allActivities, input.truncated),
    source: ledgerSource,
    ...rootTime,
  };
  const missing = [
    ...(input.truncated
      ? ["Account activity history reached its configured import bound."]
      : []),
    ...(missingRetrieval
      ? [
          `${missingRetrieval} stored activities have no preserved retrieval time.`,
        ]
      : []),
    ...(missingProviderTime
      ? [
          `${missingProviderTime} stored activities have no preserved provider time taxonomy.`,
        ]
      : []),
    ...(summary.unmatchedSellQuantity > 1e-8
      ? [
          `${summary.unmatchedSellQuantity} sold units have no matched FIFO acquisition basis.`,
        ]
      : []),
    ...(summary.unresolvedCorporateActions.length
      ? [
          `${summary.unresolvedCorporateActions.length} corporate action${summary.unresolvedCorporateActions.length === 1 ? " requires" : "s require"} manual basis review.`,
        ]
      : []),
  ];
  const expected = {
    activityHistory: 1,
    storedActivities: input.allActivities.length,
    retrievalTimes: input.allActivities.length,
    providerTimes: input.allActivities.length,
    sellBasisUnits,
    corporateActions,
  };
  const received = {
    activityHistory: input.truncated ? 0 : 1,
    storedActivities: input.allActivities.length,
    retrievalTimes: input.allActivities.length - missingRetrieval,
    providerTimes: input.allActivities.length - missingProviderTime,
    sellBasisUnits: Math.max(0, sellBasisUnits - summary.unmatchedSellQuantity),
    corporateActions: summary.corporateActionsApplied,
    // Compatibility aliases retained for existing API consumers.
    withRetrievalTime: input.allActivities.length - missingRetrieval,
    withProviderTime: input.allActivities.length - missingProviderTime,
  };
  const impact = missing.length
    ? [
        "FIFO realized P&L, tax-lot basis, or historical replay may be incomplete; missing broker history and unsupported basis changes are not inferred.",
      ]
    : [
        "The imported activity history and stored time taxonomy are complete within the configured bound; FIFO remains broker-activity accounting rather than tax advice.",
      ];

  return {
    schemaVersion: "account-activities-v2",
    summary,
    activities: rowDtos,
    imported: input.imported,
    cache: { hit: input.cacheHit, ttlSeconds: 30 },
    quality: {
      status: missing.length ? "partial" : "complete",
      expected,
      received,
      omitted: {
        activityHistory: expected.activityHistory - received.activityHistory,
        storedActivities: expected.storedActivities - received.storedActivities,
        retrievalTimes: expected.retrievalTimes - received.retrievalTimes,
        providerTimes: expected.providerTimes - received.providerTimes,
        sellBasisUnits: expected.sellBasisUnits - received.sellBasisUnits,
        corporateActions: expected.corporateActions - received.corporateActions,
      },
      rejected: {
        unmatchedSellQuantity: summary.unmatchedSellQuantity,
        unresolvedCorporateActions: summary.unresolvedCorporateActions.length,
      },
      freshness: {
        status:
          rootTime.observedAt ||
          rootTime.publishedAt ||
          rootTime.effectivePeriod
            ? ("observed" as const)
            : input.allActivities.length
              ? ("unavailable" as const)
              : ("empty" as const),
        latestObservedAt: rootTime.observedAt,
        latestPublishedAt: rootTime.publishedAt,
        effectivePeriod: rootTime.effectivePeriod,
        retrievedAt: rootTime.retrievedAt,
        evaluatedAt: rootTime.serverRespondedAt,
        cacheHit: input.cacheHit,
        agePolicy: "provider_time_taxonomy" as const,
      },
      missing,
      impact,
      source: brokerSource,
      ...rootTime,
    },
    source: brokerSource,
    ...rootTime,
  };
}
