import type {
  StrategyDecisionKind,
  StrategyMetricInput,
} from "../../persistence/store";

export type StrategySpanInput = {
  traceId: string;
  name: string;
  startedAt: number;
  endedAt: number;
  status?: "ok" | "error";
  parentSpanId?: string | null;
  attributes?: Record<string, unknown>;
  error?: string | null;
  spanId?: string;
};

export type StrategyDecisionMetricInput = {
  runId: string;
  asOf: string;
  tickLatencyMs: number;
  snapshots: {
    stale: boolean;
    latencyMs?: number | null;
    observedAt?: string | null;
  }[];
  decision: StrategyDecisionKind;
  submittedOrder: boolean;
  orderStatus?: string | null;
  spreadBps?: number | null;
  slippageBps?: number | null;
};

const finite = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const average = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

function randomHex(bytes: number) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeAttributes(attributes: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}

export function buildStrategySpan(input: StrategySpanInput) {
  const startedAt = Number.isFinite(input.startedAt)
    ? input.startedAt
    : Date.now();
  const endedAt = Number.isFinite(input.endedAt) ? input.endedAt : startedAt;
  return {
    traceId: input.traceId,
    spanId: input.spanId ?? randomHex(8),
    parentSpanId: input.parentSpanId ?? null,
    name: input.name,
    kind: "internal",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(Math.max(startedAt, endedAt)).toISOString(),
    durationMs: Math.max(0, endedAt - startedAt),
    status: input.status ?? (input.error ? "error" : "ok"),
    attributes: sanitizeAttributes(input.attributes ?? {}),
    ...(input.error ? { error: input.error.slice(0, 500) } : {}),
    schemaUrl: "https://opentelemetry.io/schemas/1.25.0",
  };
}

export function buildStrategyDecisionMetrics(
  input: StrategyDecisionMetricInput,
): StrategyMetricInput[] {
  const snapshots = input.snapshots ?? [];
  const staleCount = snapshots.filter((snapshot) => snapshot.stale).length;
  const snapshotLatencies = snapshots
    .map((snapshot) => finite(snapshot.latencyMs))
    .filter((value): value is number => value !== null);
  const observedAges = snapshots
    .map((snapshot) =>
      snapshot.observedAt
        ? Date.parse(input.asOf) - Date.parse(snapshot.observedAt)
        : NaN,
    )
    .filter((value) => Number.isFinite(value) && value >= 0);
  const rows: StrategyMetricInput[] = [
    {
      runId: input.runId,
      name: "strategy_tick_latency_ms",
      value: Math.max(0, input.tickLatencyMs),
      unit: "ms",
      asOf: input.asOf,
    },
    {
      runId: input.runId,
      name: "strategy_decision_count",
      value: 1,
      unit: "count",
      asOf: input.asOf,
    },
    {
      runId: input.runId,
      name: "strategy_blocked_decision_count",
      value: input.decision === "block" ? 1 : 0,
      unit: "count",
      asOf: input.asOf,
    },
    {
      runId: input.runId,
      name: "strategy_snapshot_count",
      value: snapshots.length,
      unit: "count",
      asOf: input.asOf,
    },
    {
      runId: input.runId,
      name: "strategy_stale_snapshot_count",
      value: staleCount,
      unit: "count",
      asOf: input.asOf,
    },
    {
      runId: input.runId,
      name: "strategy_stale_data_rate",
      value: snapshots.length ? staleCount / snapshots.length : 0,
      unit: "ratio",
      asOf: input.asOf,
    },
    {
      runId: input.runId,
      name: "strategy_paper_order_submitted_count",
      value: input.submittedOrder ? 1 : 0,
      unit: "count",
      asOf: input.asOf,
    },
  ];
  const averageSnapshotLatency = average(snapshotLatencies);
  const maxAge = observedAges.length ? Math.max(...observedAges) : null;
  const spreadBps = finite(input.spreadBps);
  const slippageBps = finite(input.slippageBps);
  if (averageSnapshotLatency !== null)
    rows.push({
      runId: input.runId,
      name: "strategy_data_latency_ms",
      value: averageSnapshotLatency,
      unit: "ms",
      asOf: input.asOf,
    });
  if (maxAge !== null)
    rows.push({
      runId: input.runId,
      name: "strategy_data_freshness_age_ms",
      value: maxAge,
      unit: "ms",
      asOf: input.asOf,
    });
  if (spreadBps !== null)
    rows.push({
      runId: input.runId,
      name: "strategy_spread_bps",
      value: spreadBps,
      unit: "bps",
      asOf: input.asOf,
    });
  if (slippageBps !== null)
    rows.push({
      runId: input.runId,
      name: "strategy_slippage_estimate_bps",
      value: slippageBps,
      unit: "bps",
      asOf: input.asOf,
    });
  if (input.orderStatus)
    rows.push({
      runId: input.runId,
      name: "strategy_paper_order_fill_ratio",
      value: input.orderStatus === "filled" ? 1 : 0,
      unit: "ratio",
      asOf: input.asOf,
    });
  return rows;
}

export function buildStrategyErrorMetric(
  runId: string,
  asOf: string,
): StrategyMetricInput {
  return { runId, name: "strategy_error_count", value: 1, unit: "count", asOf };
}
