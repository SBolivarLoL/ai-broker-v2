import { expect, test } from "bun:test";
import { buildStrategyDashboard } from "./strategy-dashboard";

test("builds Strategy Lab dashboard metrics from persisted run evidence", () => {
  const dashboard = buildStrategyDashboard({
    generatedAt: "2026-06-24T12:00:00.000Z",
    run: {
      id: "run-1",
      strategyId: "moving-average-trend",
      strategyVersion: "backtest-v1",
      status: "paper",
      configHash: "sha256:abc",
      policyVersion: "crypto-shadow-v1",
      symbols: ["BTC/USD"],
      budget: 500,
      config: { paperApproval: { budget: 500, maxPositionNotional: 300 } },
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T11:30:00.000Z",
    },
    decisions: [
      { id: "d2", traceId: "trace-2", symbol: "BTC/USD", decision: "block", reason: "stale data", riskChecks: { reasons: ["stale_data"] }, targetPosition: 0, orderOutcome: "none", createdAt: "2026-06-24T11:00:00.000Z" },
      { id: "d1", traceId: "trace-1", symbol: "BTC/USD", decision: "enter", reason: "trend", riskChecks: { reasons: [] }, targetPosition: 1, orderOutcome: "filled", createdAt: "2026-06-24T10:30:00.000Z" },
    ],
    traces: [
      { id: "d2", traceId: "trace-2", symbol: "BTC/USD", decision: "block", reason: "stale data", riskChecks: { reasons: ["stale_data"] }, targetPosition: 0, orderOutcome: "none", createdAt: "2026-06-24T11:00:00.000Z", snapshots: [{ id: "snap-2", symbol: "BTC/USD", stale: true, latencyMs: 200, observedAt: "2026-06-24T10:58:00.000Z" }] },
      { id: "d1", traceId: "trace-1", symbol: "BTC/USD", decision: "enter", reason: "trend", riskChecks: { reasons: [] }, targetPosition: 1, orderOutcome: "filled", createdAt: "2026-06-24T10:30:00.000Z", snapshots: [{ id: "snap-1", symbol: "BTC/USD", stale: false, latencyMs: 100, observedAt: "2026-06-24T10:30:00.000Z" }] },
    ],
    orders: [
      { id: "order-1", paperOrderId: "paper-1", status: "filled", payload: { side: "buy", notional: 100, referencePrice: 50_000, broker: { filledAvgPrice: 50_100 } }, createdAt: "2026-06-24T10:30:01.000Z", updatedAt: "2026-06-24T10:31:00.000Z" },
      { id: "order-2", paperOrderId: "paper-2", status: "accepted", payload: { side: "sell", notional: 50, referencePrice: 51_000 }, createdAt: "2026-06-24T11:30:00.000Z", updatedAt: "2026-06-24T11:30:00.000Z" },
    ],
  });

  expect(dashboard).toMatchObject({
    dashboardVersion: "strategy-dashboard-v1",
    dataCoverage: { decisionCount: 2, snapshotCount: 2, staleSnapshotCount: 1, staleDataRate: 0.5, averageLatencyMs: 150 },
    decisions: { blockedDecisionCount: 1, blockedDecisionRate: 0.5, blockReasons: { stale_data: 1 }, orderOutcomes: { none: 1, filled: 1 } },
    exposure: { netNotional: 50, budget: 500, maxPositionNotional: 300, budgetUtilization: 0.1 },
    orderExecution: { submittedOrders: 2, filledOrders: 1, fillRatio: 0.5, orderStatuses: { filled: 1, accepted: 1 } },
    fillQuality: { sampleCount: 1, averageSlippageBps: 20, bestSlippageBps: 20, worstSlippageBps: 20 },
    warnings: [],
  });
});

test("keeps dashboard honest when evidence is missing", () => {
  const dashboard = buildStrategyDashboard({
    generatedAt: "2026-06-24T12:00:00.000Z",
    run: {
      id: "run-empty",
      strategyId: "mean-reversion",
      strategyVersion: "backtest-v1",
      status: "shadow",
      configHash: "sha256:def",
      policyVersion: "crypto-shadow-v1",
      symbols: ["ETH/USD"],
      budget: 0,
      config: {},
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T10:00:00.000Z",
    },
    decisions: [],
    traces: [],
    orders: [],
  });

  expect(dashboard.dataCoverage.staleDataRate).toBe(null);
  expect(dashboard.orderExecution.fillRatio).toBe(null);
  expect(dashboard.fillQuality.averageSlippageBps).toBe(null);
  expect(dashboard.warnings).toContain("No strategy decisions have been recorded for this run yet.");
});
