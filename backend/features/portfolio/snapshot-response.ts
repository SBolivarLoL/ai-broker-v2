import {
  normalizeIsoTime,
  providerTimeFields,
  unavailableProviderTimeFields,
  type EffectivePeriodInput,
} from "../../shared/time-provenance";

type DateInput = string | number | Date;
type SnapshotInput = Record<string, unknown>;

const accountSource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  environment: "paper" as const,
};
const trackerSource = {
  provider: "local" as const,
  component: "order-tracker" as const,
};
const orderStreamSource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  transport: "websocket" as const,
};
const orderRecoverySource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  transport: "rest" as const,
};

function isoTime(value: unknown) {
  if (
    !(
      typeof value === "string" ||
      typeof value === "number" ||
      value instanceof Date
    )
  )
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function snapshotDatePeriod(value: unknown): EffectivePeriodInput | null {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime())) return null;
  return {
    start,
    end: new Date(start.getTime() + 86_400_000 - 1),
    label: "UTC daily portfolio snapshot",
  };
}

function snapshotTime(
  snapshot: SnapshotInput,
  serverRespondedAt: DateInput,
) {
  const capturedAt = isoTime(snapshot.capturedAt);
  return capturedAt
    ? providerTimeFields({
        observationTime: null,
        publicationTime: null,
        effectivePeriod: snapshotDatePeriod(snapshot.snapshotDate),
        retrievalTime: capturedAt,
        serverResponseTime: serverRespondedAt,
      })
    : unavailableProviderTimeFields(serverRespondedAt);
}

function observedWithoutRetrieval(
  observedAt: string | null,
  serverRespondedAt: DateInput,
) {
  if (!observedAt) return unavailableProviderTimeFields(serverRespondedAt);
  const responseTime = normalizeIsoTime(
    serverRespondedAt,
    "Snapshot response time",
  );
  return {
    observedAt,
    publishedAt: null,
    effectivePeriod: null,
    retrievedAt: null,
    serverRespondedAt: responseTime,
    time: {
      observationTime: observedAt,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: null,
      serverResponseTime: responseTime,
    },
    asOf: responseTime,
  };
}

function validObject(value: unknown): value is SnapshotInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown) {
  return value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(Number(value));
}

/** Normalizes one durable snapshot without rewriting its persisted payload. */
export function portfolioSnapshotDto(
  rawSnapshot: unknown,
  serverRespondedAt: DateInput,
) {
  const snapshot = validObject(rawSnapshot) ? rawSnapshot : {};
  const positions = Array.isArray(snapshot.positions)
    ? snapshot.positions.filter(validObject)
    : [];
  const risk = validObject(snapshot.risk) ? snapshot.risk : {};
  const orderSync = validObject(snapshot.orderSync) ? snapshot.orderSync : {};
  const originalQuality = validObject(snapshot.quality) ? snapshot.quality : {};
  const originalFlags = Array.isArray(originalQuality.flags)
    ? originalQuality.flags.filter(validObject)
    : [];
  const capturedAt = isoTime(snapshot.capturedAt);
  const rawPositionCount = Number(snapshot.positionCount);
  const positionCount =
    Number.isInteger(rawPositionCount) && rawPositionCount >= 0
      ? rawPositionCount
      : positions.length;
  const provenanceStatus = capturedAt ? "available" : "unavailable";
  const time = snapshotTime(snapshot, serverRespondedAt);
  const missing: string[] = [];
  if (!capturedAt) missing.push("capture_time");
  if (!validObject(snapshot.quality)) missing.push("quality");
  if (!Array.isArray(snapshot.positions)) missing.push("positions");
  else if (positions.length !== positionCount)
    missing.push("position_count_mismatch");
  if (!validObject(snapshot.orderSync)) missing.push("order_sync");
  const legacyFlag = capturedAt
    ? []
    : [{
        severity: "warning",
        code: "legacy_snapshot_provenance",
        message:
          "This historical snapshot predates persisted capture-time provenance.",
      }];
  const orderObservedAt = isoTime(orderSync.lastEventAt);
  const recoveryRetrievedAt = isoTime(orderSync.lastRecoveryAt);
  if (
    orderSync.lastEventAt !== null &&
    orderSync.lastEventAt !== undefined &&
    !orderObservedAt
  )
    missing.push("order_event_observation_time");
  if (
    orderSync.lastRecoveryAt !== null &&
    orderSync.lastRecoveryAt !== undefined &&
    !recoveryRetrievedAt
  )
    missing.push("order_recovery_retrieval_time");
  const orderTime = capturedAt
    ? providerTimeFields({
        observationTime: orderObservedAt,
        publicationTime: null,
        effectivePeriod: null,
        retrievalTime: capturedAt,
        serverResponseTime: serverRespondedAt,
      })
    : unavailableProviderTimeFields(serverRespondedAt);
  const accountAvailable = [
    snapshot.equity,
    snapshot.cash,
    snapshot.buyingPower,
  ].every(finiteNumber);

  return {
    ...snapshot,
    schemaVersion: "portfolio-snapshot-v2",
    snapshotDate:
      typeof snapshot.snapshotDate === "string"
        ? snapshot.snapshotDate
        : null,
    capturedAt,
    positionCount,
    risk: {
      ...risk,
      weights: Array.isArray(risk.weights)
        ? risk.weights.filter(validObject).map((weight) => ({
            ...weight,
            source: "Derived from captured Alpaca account and positions",
            ...time,
          }))
        : [],
      source: "Derived from captured Alpaca account and positions",
      ...time,
    },
    positions: positions.map((position) => ({
      ...position,
      source: accountSource,
      ...time,
    })),
    orderSync: {
      ...orderSync,
      stream: {
        available: Boolean(orderObservedAt),
        source: orderStreamSource,
        ...observedWithoutRetrieval(
          orderObservedAt,
          serverRespondedAt,
        ),
      },
      recovery: {
        available: Boolean(recoveryRetrievedAt),
        source: orderRecoverySource,
        ...(recoveryRetrievedAt
          ? providerTimeFields({
              observationTime: null,
              publicationTime: null,
              effectivePeriod: null,
              retrievalTime: recoveryRetrievedAt,
              serverResponseTime: serverRespondedAt,
            })
          : unavailableProviderTimeFields(serverRespondedAt)),
      },
      source: trackerSource,
      ...orderTime,
    },
    quality: {
      ...originalQuality,
      status:
        typeof originalQuality.status === "string"
          ? originalQuality.status
          : "unknown",
      flags: [...originalFlags, ...legacyFlag],
      coverageStatus: missing.length ? "partial" : "complete",
      provenanceStatus,
      expected: { account: 1, positions: positionCount, orderSync: 1 },
      received: {
        account: accountAvailable ? 1 : 0,
        positions: positions.length,
        orderSync: validObject(snapshot.orderSync) ? 1 : 0,
      },
      missing,
      source: "Validated captured portfolio snapshot",
      ...time,
    },
    inputs: {
      account: {
        available: accountAvailable,
        source: accountSource,
        ...time,
      },
      positions: {
        count: positions.length,
        source: accountSource,
        ...time,
      },
      orderSync: {
        available: validObject(snapshot.orderSync),
        source: trackerSource,
        ...orderTime,
      },
    },
    source:
      typeof snapshot.source === "string" ? snapshot.source : "unknown",
    sourceDetails: {
      account: accountSource,
      orderState: trackerSource,
      orderStream: orderStreamSource,
      orderRecovery: orderRecoverySource,
      persistence: "local SQLite daily snapshot",
    },
    provenanceStatus,
    ...time,
  };
}

/** Builds the current-plus-history response with one fresh delivery time. */
export function portfolioSnapshotsDto(input: {
  current: unknown;
  history: unknown[];
  serverRespondedAt: DateInput;
}) {
  const current = portfolioSnapshotDto(
    input.current,
    input.serverRespondedAt,
  );
  const history = input.history.map((snapshot) =>
    portfolioSnapshotDto(snapshot, input.serverRespondedAt),
  );
  const snapshotDates = [current, ...history]
    .map((snapshot) => String(snapshot.snapshotDate ?? ""))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const effectivePeriod = snapshotDates.length
    ? {
        start: `${snapshotDates[0]}T00:00:00.000Z`,
        end: `${snapshotDates.at(-1)}T23:59:59.999Z`,
        label: "Persisted portfolio snapshot history",
      }
    : null;
  const capturedAt = isoTime(current.capturedAt);
  const rootTime = capturedAt
    ? providerTimeFields({
        observationTime: null,
        publicationTime: null,
        effectivePeriod,
        retrievalTime: capturedAt,
        serverResponseTime: input.serverRespondedAt,
      })
    : unavailableProviderTimeFields(input.serverRespondedAt);
  const currentMissing = current.quality.missing.map(
    (gap) => `current:${gap}`,
  );
  const historyMissing = history.flatMap((snapshot, index) =>
    snapshot.quality.missing.map(
      (gap) =>
        `history:${snapshot.snapshotDate ?? index}:${gap}`,
    ),
  );
  const completeHistory = history.filter(
    (snapshot) => snapshot.quality.coverageStatus === "complete",
  ).length;

  return {
    schemaVersion: "portfolio-snapshots-v2",
    current,
    history,
    quality: {
      status:
        current.quality.coverageStatus !== "complete" || historyMissing.length
          ? "partial"
          : "complete",
      expected: { current: 1, history: history.length },
      received: {
        current: current.quality.coverageStatus === "complete" ? 1 : 0,
        history: completeHistory,
      },
      missing: [...currentMissing, ...historyMissing],
      source: "Local SQLite portfolio snapshot history",
      ...rootTime,
    },
    source: "Alpaca paper account snapshots persisted in local SQLite",
    ...rootTime,
  };
}
