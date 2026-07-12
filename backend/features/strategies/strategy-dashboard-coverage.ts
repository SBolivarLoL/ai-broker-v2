import { providerTimeFields } from "../../shared/time-provenance";

type CoverageRun = {
  id: string;
  backtestId?: string | null;
  status: string;
  symbols: string[];
  configHash: string;
  policyVersion: string;
  config: any;
  provenance?: { workingTreeDirty?: boolean } | null;
  comparable?: boolean;
};

type CoverageDecision = {
  traceId: string;
  createdAt: string;
};

type CoverageTrace = {
  traceId: string;
  snapshots: Array<{
    stale: boolean;
    observedAt: string;
  }>;
};

type CoverageOrder = {
  status: string;
  payload: any;
  createdAt: string;
  updatedAt: string;
};

function normalizedTime(value: string | null | undefined) {
  const time = value ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function latestTime(values: Array<string | null | undefined>) {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .toSorted()
      .at(-1) ?? null
  );
}

/** Builds the normalized evidence contract for one persisted strategy run. */
export function buildStrategyDashboardCoverage(input: {
  run: CoverageRun;
  decisions: CoverageDecision[];
  traces: CoverageTrace[];
  orders: CoverageOrder[];
  retrievedAt: string;
  serverRespondedAt: string;
}) {
  const snapshots = input.traces.flatMap((trace) => trace.snapshots ?? []);
  const observedTimes = snapshots
    .map((snapshot) => normalizedTime(snapshot.observedAt))
    .filter((value): value is string => Boolean(value));
  const expectedDecisions = Math.max(1, input.decisions.length);
  const expectedSnapshots = Math.max(
    input.run.symbols.length,
    input.decisions.length * input.run.symbols.length,
  );
  const filledOrders = input.orders.filter(
    (order) => String(order.status) === "filled",
  );
  const fillQualitySamples = filledOrders.filter((order) => {
    const broker = order.payload?.broker ?? {};
    const referencePrice = Number(order.payload?.referencePrice);
    const filledAvgPrice = Number(
      broker.filledAvgPrice ?? order.payload?.filledAvgPrice,
    );
    return (
      Number.isFinite(referencePrice) &&
      referencePrice > 0 &&
      Number.isFinite(filledAvgPrice)
    );
  }).length;
  const expected: Record<string, number> = {
    runConfiguration: 1,
    linkedBacktest: 1,
    cleanProvenance: 1,
    comparableRun: 1,
    decisions: expectedDecisions,
    decisionTraces: expectedDecisions,
    marketSnapshots: expectedSnapshots,
    snapshotObservationTimes: expectedSnapshots,
    freshMarketSnapshots: expectedSnapshots,
    ...(input.run.status === "paper" ? { paperApproval: 1 } : {}),
    ...(input.orders.length ? { reconciledOrders: input.orders.length } : {}),
    ...(filledOrders.length ? { fillQualitySamples: filledOrders.length } : {}),
  };
  const decisionTraceIds = new Set(input.decisions.map((item) => item.traceId));
  const received: Record<string, number> = {
    runConfiguration:
      input.run.id &&
      input.run.configHash &&
      input.run.policyVersion &&
      input.run.symbols.length
        ? 1
        : 0,
    linkedBacktest: input.run.backtestId ? 1 : 0,
    cleanProvenance:
      input.run.provenance && !input.run.provenance.workingTreeDirty ? 1 : 0,
    comparableRun: input.run.comparable ? 1 : 0,
    decisions: Math.min(expectedDecisions, input.decisions.length),
    decisionTraces: Math.min(
      expectedDecisions,
      input.traces.filter((trace) => decisionTraceIds.has(trace.traceId))
        .length,
    ),
    marketSnapshots: Math.min(expectedSnapshots, snapshots.length),
    snapshotObservationTimes: Math.min(expectedSnapshots, observedTimes.length),
    freshMarketSnapshots: Math.min(
      expectedSnapshots,
      snapshots.filter(
        (snapshot) =>
          !snapshot.stale && normalizedTime(snapshot.observedAt) !== null,
      ).length,
    ),
    ...(input.run.status === "paper"
      ? { paperApproval: input.run.config?.paperApproval ? 1 : 0 }
      : {}),
    ...(input.orders.length
      ? {
          reconciledOrders: input.orders.filter((order) =>
            normalizedTime(order.payload?.brokerReconciledAt),
          ).length,
        }
      : {}),
    ...(filledOrders.length ? { fillQualitySamples } : {}),
  };
  const omitted = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      Math.max(0, value - (received[key] ?? 0)),
    ]),
  );
  const missing = [
    ...(!input.run.backtestId
      ? ["The run has no linked immutable backtest."]
      : []),
    ...(!input.run.provenance || input.run.provenance.workingTreeDirty
      ? ["The run lacks clean reproducibility provenance."]
      : []),
    ...(!input.run.comparable
      ? [
          "The run is legacy or otherwise not comparable to its evidence cohort.",
        ]
      : []),
    ...(!input.decisions.length
      ? ["The run has not recorded its first strategy decision."]
      : []),
    ...(omitted.decisionTraces
      ? [`${omitted.decisionTraces} decisions lack a replayable trace.`]
      : []),
    ...(omitted.marketSnapshots
      ? [
          `${omitted.marketSnapshots} expected per-symbol market snapshots are missing.`,
        ]
      : []),
    ...(omitted.snapshotObservationTimes
      ? [
          `${omitted.snapshotObservationTimes} expected snapshots lack valid provider observation time.`,
        ]
      : []),
    ...(snapshots.some((snapshot) => snapshot.stale)
      ? [
          `${snapshots.filter((snapshot) => snapshot.stale).length} persisted market snapshots are stale.`,
        ]
      : []),
    ...(input.run.status === "paper" && !input.run.config?.paperApproval
      ? ["The paper run has no saved paper approval evidence."]
      : []),
    ...(omitted.reconciledOrders
      ? [
          `${omitted.reconciledOrders} paper orders lack a completed broker-reconciliation receipt.`,
        ]
      : []),
    ...(omitted.fillQualitySamples
      ? [
          `${omitted.fillQualitySamples} filled orders lack exact fill-quality evidence.`,
        ]
      : []),
  ];
  const impact = [
    ...(!input.run.backtestId ||
    !input.run.provenance ||
    input.run.provenance.workingTreeDirty ||
    !input.run.comparable
      ? [
          "The run cannot be treated as comparable or promotion-ready until immutable clean lineage is present.",
        ]
      : []),
    ...(!input.decisions.length
      ? [
          "No strategy behavior can be evaluated before the first persisted decision and trace.",
        ]
      : []),
    ...(omitted.decisionTraces ||
    omitted.marketSnapshots ||
    omitted.snapshotObservationTimes
      ? [
          "Decision replay and signal interpretation are incomplete because trace or market evidence is missing.",
        ]
      : []),
    ...(snapshots.some((snapshot) => snapshot.stale)
      ? [
          "Stale market evidence makes affected decisions unsuitable for performance or promotion conclusions.",
        ]
      : []),
    ...(omitted.paperApproval
      ? ["Paper execution authority is incomplete and must remain fail-closed."]
      : []),
    ...(omitted.reconciledOrders || omitted.fillQualitySamples
      ? [
          "Execution and slippage conclusions remain incomplete until broker reconciliation and fill evidence are available.",
        ]
      : []),
  ];
  if (!impact.length) {
    impact.push(
      "Run configuration, lineage, decisions, traces, market observations, and applicable execution evidence are complete.",
    );
  }
  const latestObservedAt = latestTime(observedTimes);
  const rootTime = providerTimeFields({
    observationTime: latestObservedAt,
    publicationTime: null,
    effectivePeriod: observedTimes.length
      ? {
          start: observedTimes.toSorted()[0],
          end: observedTimes.toSorted().at(-1),
          label: "Persisted strategy market observations",
        }
      : null,
    retrievalTime: input.retrievedAt,
    serverResponseTime: input.serverRespondedAt,
  });
  const omittedTotal = Object.values(omitted).reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    quality: {
      status: !input.decisions.length
        ? ("empty" as const)
        : omittedTotal
          ? ("partial" as const)
          : ("complete" as const),
      expected,
      received,
      omitted,
      freshness: {
        status: !snapshots.length
          ? ("unavailable" as const)
          : snapshots.some((snapshot) => snapshot.stale)
            ? ("stale_inputs" as const)
            : observedTimes.length < expectedSnapshots
              ? ("partial_observation_time" as const)
              : ("fresh" as const),
        expectedObservations: expectedSnapshots,
        receivedObservations: observedTimes.length,
        latestObservedAt,
        latestDecisionAt: latestTime(
          input.decisions.map((decision) => normalizedTime(decision.createdAt)),
        ),
        latestOrderRecordAt: latestTime(
          input.orders.map((order) =>
            normalizedTime(order.updatedAt ?? order.createdAt),
          ),
        ),
        retrievedAt: rootTime.retrievedAt,
        evaluatedAt: rootTime.serverRespondedAt,
        agePolicy: "persisted_snapshot_stale_flag" as const,
      },
      missing,
      impact,
      source:
        "Persisted run, decision, trace, market-snapshot, and reconciled paper-order evidence",
      ...rootTime,
    },
    ...rootTime,
  };
}
