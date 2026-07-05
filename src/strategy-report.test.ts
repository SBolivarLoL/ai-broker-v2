import { expect, test } from "bun:test";
import { buildStrategyExperimentReport } from "./strategy-report";

const provenance = {
  gitCommit: "a".repeat(40),
  workingTreeDirty: false,
  pluginVersion: "strategy-plugin-v1",
  featureSchemaVersion: "strategy-features-v1",
  policyVersion: "crypto-shadow-v1",
  definitionHash: `sha256:${"b".repeat(64)}`,
  provider: "Alpaca Market Data API",
  feed: "us",
  query: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-24T00:00:00.000Z", timeframe: "1Hour", symbols: ["BTC/USD"] },
  datasetHash: `sha256:${"c".repeat(64)}`,
};

test("builds exportable strategy experiment report from persisted run evidence", () => {
  const report = buildStrategyExperimentReport({
    generatedAt: "2026-06-24T12:00:00.000Z",
    run: {
      id: "run-1",
      backtestId: "backtest-1",
      strategyId: "moving-average-trend",
      strategyVersion: "backtest-v1",
      status: "paper",
      configHash: "sha256:abc",
      policyVersion: "crypto-shadow-v1",
      symbols: ["BTC/USD"],
      budget: 250,
      config: { paperApproval: { budget: 250, maxSpreadBps: 100 }, schedule: { intervalMinutes: 15 }, reviewHistory: [{ action: "continue", note: "Keep running one more day" }] },
      notes: "Paper trial",
      provenance,
      comparable: true,
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T11:00:00.000Z",
    },
    decisions: [
      { id: "d2", traceId: "trace-2", symbol: "BTC/USD", decision: "block", reason: "stale data", riskChecks: { reasons: ["stale_data"] }, targetPosition: 0, rawSignal: 1, riskAdjustedSignal: 0, orderOutcome: "none", provenance, comparable: true, createdAt: "2026-06-24T11:00:00.000Z" },
      { id: "d1", traceId: "trace-1", symbol: "BTC/USD", decision: "enter", reason: "trend", riskChecks: { reasons: [] }, targetPosition: 1, rawSignal: 1, riskAdjustedSignal: 1, orderOutcome: "accepted", provenance, comparable: true, createdAt: "2026-06-24T10:30:00.000Z" },
    ],
    traces: [
      { id: "d2", traceId: "trace-2", symbol: "BTC/USD", decision: "block", reason: "stale data", riskChecks: { reasons: ["stale_data"] }, features: {}, thresholds: {}, targetPosition: 0, rawSignal: 1, riskAdjustedSignal: 0, orderOutcome: "none", createdAt: "2026-06-24T11:00:00.000Z", snapshots: [{ id: "snap-2", symbol: "BTC/USD", source: "Alpaca crypto snapshot", feed: "us", stale: true, observedAt: "2026-06-24T10:58:00.000Z", datasetHash: `sha256:${"d".repeat(64)}` }] },
      { id: "d1", traceId: "trace-1", symbol: "BTC/USD", decision: "enter", reason: "trend", riskChecks: { reasons: [] }, features: { fastAverage: 101 }, thresholds: { fast: 5 }, targetPosition: 1, rawSignal: 1, riskAdjustedSignal: 1, orderOutcome: "accepted", createdAt: "2026-06-24T10:30:00.000Z", snapshots: [{ id: "snap-1", symbol: "BTC/USD", source: "Alpaca crypto snapshot", feed: "us", stale: false, observedAt: "2026-06-24T10:30:00.000Z", datasetHash: `sha256:${"e".repeat(64)}` }] },
    ],
    orders: [{ id: "order-row-1", paperOrderId: "paper-1", status: "accepted", payload: { side: "buy", notional: 50, qty: 0.001, timeInForce: "gtc", referencePrice: 50_000 }, createdAt: "2026-06-24T10:30:01.000Z", updatedAt: "2026-06-24T10:30:01.000Z" }],
    metrics: [{ name: "stale_data_rate", value: 0.5, unit: "ratio", asOf: "2026-06-24T11:00:00.000Z" }],
    notes: [{ actor: "tester", note: "Started small", createdAt: "2026-06-24T10:00:00.000Z" }],
    attribution: { attributionVersion: "strategy-attribution-v1" },
    performance: { performanceVersion: "strategy-performance-v1" },
    executionReplay: { replayVersion: "strategy-execution-replay-v1", summary: { missedFills: 1 } },
    auditTrail: [{ kind: "run_created", entryHash: "sha256:audit", previousHash: null }],
    auditVerification: { valid: true, entries: 1, invalidEntryId: null },
  });

  expect(report).toMatchObject({
    reportVersion: "strategy-experiment-v1",
    run: { id: "run-1", backtestId: "backtest-1", strategyId: "moving-average-trend", status: "paper", comparable: true },
    provenance: {
      run: { gitCommit: provenance.gitCommit, datasetHash: provenance.datasetHash },
      decisionDatasetHashes: [provenance.datasetHash],
      snapshotDatasetHashes: [`sha256:${"d".repeat(64)}`, `sha256:${"e".repeat(64)}`],
    },
    assumptions: { executionMode: "paper", paperApproval: { budget: 250 }, schedule: { intervalMinutes: 15 } },
    dataCoverage: {
      decisionCount: 2,
      firstDecisionAt: "2026-06-24T10:30:00.000Z",
      lastDecisionAt: "2026-06-24T11:00:00.000Z",
      snapshotCount: 2,
      staleSnapshotCount: 1,
      symbols: ["BTC/USD"],
      sources: ["Alpaca crypto snapshot"],
      feeds: ["us"],
    },
    metrics: { decisionCounts: { block: 1, enter: 1 }, orderOutcomes: { accepted: 1, none: 1 }, blockReasons: { stale_data: 1 }, submittedOrders: 1, fillRatio: 0 },
    reasonCodedFailures: { stale_data: 1 },
    postFillAttribution: { attributionVersion: "strategy-attribution-v1" },
    paperRunExecutionReplay: { replayVersion: "strategy-execution-replay-v1", summary: { missedFills: 1 } },
    activeRunPerformance: { performanceVersion: "strategy-performance-v1" },
    auditTrail: [{ kind: "run_created", entryHash: "sha256:audit" }],
    auditVerification: { valid: true, entries: 1, invalidEntryId: null },
    reviews: [{ action: "continue", note: "Keep running one more day" }],
    orders: [{ paperOrderId: "paper-1", status: "accepted", side: "buy", notional: 50 }],
    notes: [{ actor: "tester", note: "Started small" }],
  });
  expect(report.notableDecisions).toHaveLength(2);
});
