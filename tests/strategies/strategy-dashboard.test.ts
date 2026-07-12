import { expect, test } from "bun:test";
import { buildStrategyDashboard } from "../../backend/features/strategies/strategy-dashboard";

const provenance = {
  gitCommit: "a".repeat(40),
  workingTreeDirty: false,
  pluginVersion: "strategy-v1",
  featureSchemaVersion: "strategy-features-v1",
  policyVersion: "crypto-shadow-v1",
  definitionHash: `sha256:${"b".repeat(64)}`,
  provider: "Alpaca Market Data API",
  feed: "us",
  query: {
    start: "2026-05-24T00:00:00.000Z",
    end: "2026-06-24T00:00:00.000Z",
    timeframe: "1Hour",
    symbols: ["BTC/USD"],
  },
  datasetHash: `sha256:${"c".repeat(64)}`,
};

test("builds Strategy Lab dashboard metrics from persisted run evidence", () => {
  const dashboard = buildStrategyDashboard({
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
      budget: 500,
      config: { paperApproval: { budget: 500, maxPositionNotional: 300 } },
      provenance,
      comparable: true,
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T11:30:00.000Z",
    },
    decisions: [
      {
        id: "d2",
        traceId: "trace-2",
        symbol: "BTC/USD",
        decision: "block",
        reason: "stale data",
        riskChecks: { reasons: ["stale_data"] },
        targetPosition: 0,
        orderOutcome: "none",
        createdAt: "2026-06-24T11:00:00.000Z",
      },
      {
        id: "d1",
        traceId: "trace-1",
        symbol: "BTC/USD",
        decision: "enter",
        reason: "trend",
        riskChecks: { reasons: [] },
        targetPosition: 1,
        orderOutcome: "filled",
        createdAt: "2026-06-24T10:30:00.000Z",
      },
    ],
    traces: [
      {
        id: "d2",
        traceId: "trace-2",
        symbol: "BTC/USD",
        decision: "block",
        reason: "stale data",
        riskChecks: { reasons: ["stale_data"] },
        targetPosition: 0,
        orderOutcome: "none",
        createdAt: "2026-06-24T11:00:00.000Z",
        snapshots: [
          {
            id: "snap-2",
            symbol: "BTC/USD",
            stale: true,
            latencyMs: 200,
            observedAt: "2026-06-24T10:58:00.000Z",
          },
        ],
      },
      {
        id: "d1",
        traceId: "trace-1",
        symbol: "BTC/USD",
        decision: "enter",
        reason: "trend",
        riskChecks: { reasons: [] },
        targetPosition: 1,
        orderOutcome: "filled",
        createdAt: "2026-06-24T10:30:00.000Z",
        snapshots: [
          {
            id: "snap-1",
            symbol: "BTC/USD",
            stale: false,
            latencyMs: 100,
            observedAt: "2026-06-24T10:30:00.000Z",
          },
        ],
      },
    ],
    orders: [
      {
        id: "order-1",
        paperOrderId: "paper-1",
        status: "filled",
        payload: {
          side: "buy",
          notional: 100,
          referencePrice: 50_000,
          broker: { filledAvgPrice: 50_100 },
          brokerReconciledAt: "2026-06-24T10:31:00.000Z",
        },
        createdAt: "2026-06-24T10:30:01.000Z",
        updatedAt: "2026-06-24T10:31:00.000Z",
      },
      {
        id: "order-2",
        paperOrderId: "paper-2",
        status: "accepted",
        payload: {
          side: "sell",
          notional: 50,
          referencePrice: 51_000,
          brokerReconciledAt: "2026-06-24T11:30:00.000Z",
        },
        createdAt: "2026-06-24T11:30:00.000Z",
        updatedAt: "2026-06-24T11:30:00.000Z",
      },
    ],
  });

  expect(dashboard).toMatchObject({
    dashboardVersion: "strategy-dashboard-v2",
    dataCoverage: {
      decisionCount: 2,
      snapshotCount: 2,
      staleSnapshotCount: 1,
      staleDataRate: 0.5,
      averageLatencyMs: 150,
    },
    decisions: {
      blockedDecisionCount: 1,
      blockedDecisionRate: 0.5,
      blockReasons: { stale_data: 1 },
      orderOutcomes: { none: 1, filled: 1 },
    },
    exposure: {
      netNotional: 50,
      budget: 500,
      maxPositionNotional: 300,
      budgetUtilization: 0.1,
    },
    orderExecution: {
      submittedOrders: 2,
      filledOrders: 1,
      fillRatio: 0.5,
      orderStatuses: { filled: 1, accepted: 1 },
    },
    fillQuality: {
      sampleCount: 1,
      averageSlippageBps: 20,
      bestSlippageBps: 20,
      worstSlippageBps: 20,
    },
    warnings: [],
    quality: {
      status: "partial",
      expected: {
        runConfiguration: 1,
        linkedBacktest: 1,
        cleanProvenance: 1,
        comparableRun: 1,
        decisions: 2,
        decisionTraces: 2,
        marketSnapshots: 2,
        snapshotObservationTimes: 2,
        freshMarketSnapshots: 2,
        paperApproval: 1,
        reconciledOrders: 2,
        fillQualitySamples: 1,
      },
      received: {
        freshMarketSnapshots: 1,
        reconciledOrders: 2,
        fillQualitySamples: 1,
      },
      omitted: { freshMarketSnapshots: 1 },
      freshness: {
        status: "stale_inputs",
        expectedObservations: 2,
        receivedObservations: 2,
        latestObservedAt: "2026-06-24T10:58:00.000Z",
      },
    },
    observedAt: "2026-06-24T10:58:00.000Z",
    retrievedAt: "2026-06-24T12:00:00.000Z",
    serverRespondedAt: "2026-06-24T12:00:00.000Z",
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
  expect(dashboard.warnings).toContain(
    "No strategy decisions have been recorded for this run yet.",
  );
  expect(dashboard.quality).toMatchObject({
    status: "empty",
    expected: {
      decisions: 1,
      decisionTraces: 1,
      marketSnapshots: 1,
      snapshotObservationTimes: 1,
      freshMarketSnapshots: 1,
    },
    received: {
      decisions: 0,
      decisionTraces: 0,
      marketSnapshots: 0,
    },
    freshness: {
      status: "unavailable",
      expectedObservations: 1,
      receivedObservations: 0,
    },
  });
  expect(dashboard.quality.impact.join(" ")).toContain(
    "first persisted decision",
  );
});

test("marks a fully evidenced shadow run complete", () => {
  const dashboard = buildStrategyDashboard({
    retrievedAt: "2026-06-24T12:00:00.000Z",
    serverRespondedAt: "2026-06-24T12:00:01.000Z",
    run: {
      id: "run-complete",
      backtestId: "backtest-complete",
      strategyId: "moving-average-trend",
      strategyVersion: "strategy-v1",
      status: "shadow",
      configHash: `sha256:${"d".repeat(64)}`,
      policyVersion: "crypto-shadow-v1",
      symbols: ["BTC/USD"],
      budget: 0,
      config: {},
      provenance,
      comparable: true,
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T11:00:00.000Z",
    },
    decisions: [
      {
        id: "decision-complete",
        traceId: "trace-complete",
        symbol: "BTC/USD",
        decision: "hold",
        reason: "inside threshold",
        riskChecks: { reasons: [] },
        targetPosition: 0,
        orderOutcome: "none",
        createdAt: "2026-06-24T11:00:00.000Z",
      },
    ],
    traces: [
      {
        id: "decision-complete",
        traceId: "trace-complete",
        symbol: "BTC/USD",
        decision: "hold",
        reason: "inside threshold",
        riskChecks: { reasons: [] },
        targetPosition: 0,
        orderOutcome: "none",
        createdAt: "2026-06-24T11:00:00.000Z",
        snapshots: [
          {
            id: "snapshot-complete",
            symbol: "BTC/USD",
            stale: false,
            latencyMs: 80,
            observedAt: "2026-06-24T10:59:59.000Z",
          },
        ],
      },
    ],
    orders: [],
  });

  expect(dashboard.quality).toMatchObject({
    status: "complete",
    omitted: {
      runConfiguration: 0,
      linkedBacktest: 0,
      cleanProvenance: 0,
      comparableRun: 0,
      decisions: 0,
      decisionTraces: 0,
      marketSnapshots: 0,
      snapshotObservationTimes: 0,
      freshMarketSnapshots: 0,
    },
    freshness: {
      status: "fresh",
      expectedObservations: 1,
      receivedObservations: 1,
    },
    missing: [],
  });
  expect(dashboard.quality.impact).toEqual([
    "Run configuration, lineage, decisions, traces, market observations, and applicable execution evidence are complete.",
  ]);
  expect(dashboard.time).toEqual({
    observationTime: "2026-06-24T10:59:59.000Z",
    publicationTime: null,
    effectivePeriod: {
      start: "2026-06-24T10:59:59.000Z",
      end: "2026-06-24T10:59:59.000Z",
      label: "Persisted strategy market observations",
    },
    retrievalTime: "2026-06-24T12:00:00.000Z",
    serverResponseTime: "2026-06-24T12:00:01.000Z",
  });
});
