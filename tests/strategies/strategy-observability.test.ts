import { expect, test } from "bun:test";
import {
  buildStrategyDecisionMetrics,
  buildStrategyErrorMetric,
  buildStrategySpan,
} from "../../backend/features/strategies/strategy-observability";

test("builds OpenTelemetry-shaped local span payloads", () => {
  const span = buildStrategySpan({
    traceId: "trace-1",
    spanId: "1234567890abcdef",
    parentSpanId: "parent",
    name: "strategy.tick",
    startedAt: Date.parse("2026-06-24T10:00:00.000Z"),
    endedAt: Date.parse("2026-06-24T10:00:00.250Z"),
    attributes: { runId: "run-1", ignored: undefined },
  });
  expect(span).toMatchObject({
    traceId: "trace-1",
    spanId: "1234567890abcdef",
    parentSpanId: "parent",
    name: "strategy.tick",
    kind: "internal",
    durationMs: 250,
    status: "ok",
    attributes: { runId: "run-1" },
    schemaUrl: "https://opentelemetry.io/schemas/1.25.0",
  });
});

test("derives persistent strategy decision metrics from tick evidence", () => {
  const metrics = buildStrategyDecisionMetrics({
    runId: "run-1",
    asOf: "2026-06-24T10:00:01.000Z",
    tickLatencyMs: 321,
    snapshots: [
      { stale: false, latencyMs: 40, observedAt: "2026-06-24T10:00:00.900Z" },
      { stale: true, latencyMs: 80, observedAt: "2026-06-24T09:59:58.000Z" },
    ],
    decision: "block",
    submittedOrder: false,
    spreadBps: 42,
    slippageBps: null,
  });
  expect(metrics).toMatchObject([
    { name: "strategy_tick_latency_ms", value: 321, unit: "ms" },
    { name: "strategy_decision_count", value: 1, unit: "count" },
    { name: "strategy_blocked_decision_count", value: 1, unit: "count" },
    { name: "strategy_snapshot_count", value: 2, unit: "count" },
    { name: "strategy_stale_snapshot_count", value: 1, unit: "count" },
    { name: "strategy_stale_data_rate", value: 0.5, unit: "ratio" },
    { name: "strategy_paper_order_submitted_count", value: 0, unit: "count" },
    { name: "strategy_data_latency_ms", value: 60, unit: "ms" },
    { name: "strategy_data_freshness_age_ms", value: 3000, unit: "ms" },
    { name: "strategy_spread_bps", value: 42, unit: "bps" },
  ]);
});

test("creates strategy error counter metric", () => {
  expect(buildStrategyErrorMetric("run-1", "2026-06-24T10:00:00.000Z")).toEqual(
    {
      runId: "run-1",
      name: "strategy_error_count",
      value: 1,
      unit: "count",
      asOf: "2026-06-24T10:00:00.000Z",
    },
  );
});
