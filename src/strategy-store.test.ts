import { expect, test } from "bun:test";
import { createStore } from "./store";

test("persists strategy runs, snapshots, decisions and trace reconstruction", () => {
  const store = createStore(":memory:");
  store.createStrategyRun({
    id: "run-1",
    strategyId: "mean-reversion",
    strategyVersion: "1.0.0",
    status: "shadow",
    configHash: "sha256:abc",
    policyVersion: "crypto-paper-v1",
    symbols: ["BTC/USD"],
    budget: 250,
    config: { lookback: 20, entryZScore: -2 },
    notes: "Initial shadow run",
  });
  store.strategyDataSnapshot({
    id: "snap-1",
    runId: "run-1",
    symbol: "BTC/USD",
    source: "alpaca",
    feed: "us",
    observedAt: "2026-06-24T10:00:00.000Z",
    stale: false,
    latencyMs: 42,
    payload: { bid: 100, ask: 101 },
  });
  store.strategyDecision({
    id: "decision-1",
    traceId: "trace-1",
    runId: "run-1",
    symbol: "BTC/USD",
    decision: "enter",
    features: { zScore: -2.4, spreadBps: 99.5 },
    weights: { zScore: 0.8, spreadPenalty: -0.1 },
    thresholds: { entryZScore: -2, maxSpreadBps: 120 },
    riskChecks: { allowed: true, reasons: [] },
    dataSnapshotIds: ["snap-1"],
    rawSignal: 0.7,
    riskAdjustedSignal: 0.6,
    targetPosition: 100,
    reason: "Mean reversion entry passed liquidity gate",
    draftOrder: { side: "buy", notional: 100 },
  });
  store.strategyMetric({ runId: "run-1", name: "stale_data_rate", value: 0, unit: "ratio", asOf: "2026-06-24T10:00:00.000Z" });

  expect(store.getStrategyRun("run-1")).toMatchObject({ strategyId: "mean-reversion", status: "shadow", symbols: ["BTC/USD"], config: { lookback: 20 } });
  expect(store.strategyRuns()).toHaveLength(1);
  expect(store.strategyDecisions("run-1")).toMatchObject([{ traceId: "trace-1", features: { zScore: -2.4 }, dataSnapshotIds: ["snap-1"] }]);
  expect(store.getStrategyDecisionTrace("trace-1")).toMatchObject({
    runId: "run-1",
    decision: "enter",
    features: { zScore: -2.4, spreadBps: 99.5 },
    snapshots: [{ id: "snap-1", stale: false, payload: { bid: 100, ask: 101 } }],
  });
  expect(store.strategyMetrics("run-1")).toMatchObject([{ name: "stale_data_rate", value: 0, unit: "ratio" }]);
  store.close();
});

test("updates strategy run status and stores notes", () => {
  const store = createStore(":memory:");
  store.createStrategyRun({
    id: "run-2",
    strategyId: "trend",
    strategyVersion: "1.0.0",
    status: "backtest",
    configHash: "sha256:def",
    policyVersion: "crypto-paper-v1",
    symbols: ["ETH/USD"],
    budget: 0,
    config: {},
  });
  expect(store.updateStrategyRunStatus("run-2", "paused", "Paused after review")).toBe(true);
  store.strategyNote("run-2", "test", "Needs wider spread filter");
  expect(store.getStrategyRun("run-2")).toMatchObject({ status: "paused", notes: "Paused after review" });
  store.close();
});
