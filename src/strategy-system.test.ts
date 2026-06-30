import { describe, expect, test } from "bun:test";
import { evaluateStrategyPlugin, runBacktest, strategyPluginFromId, type BacktestBar } from "./strategy-backtest";
import { buildStrategyPerformance } from "./strategy-performance";
import { buildStrategyExperimentReport } from "./strategy-report";
import { draftStrategyPaperOrder, evaluateStrategyPaperRiskPolicy, parseStrategyPaperApproval } from "./strategy-paper";

const bars: BacktestBar[] = [
  { timestamp: "2026-06-24T10:00:00.000Z", close: 100 },
  { timestamp: "2026-06-24T11:00:00.000Z", close: 101 },
  { timestamp: "2026-06-24T12:00:00.000Z", close: 102 },
  { timestamp: "2026-06-24T13:00:00.000Z", close: 104 },
];

describe("strategy backend system flow", () => {
  test("runs paper-strategy evaluation approval risk performance and report without UI automation", () => {
    const plugin = strategyPluginFromId("moving-average-trend", { fast: 2, slow: 3, exposure: 0.6 });
    const evaluation = evaluateStrategyPlugin(plugin, bars, bars.length - 1, "BTC/USD");
    expect(evaluation).toMatchObject({
      targetExposure: 0.6,
      reason: "fast average above slow average",
      risk: { allowed: true },
      orders: [{ type: "target_exposure", targetExposure: 0.6 }],
    });

    const backtest = runBacktest({
      strategyId: plugin.id,
      bars,
      initialCash: 1_000,
      slippageBps: 0,
      strategy: (history, index) => evaluateStrategyPlugin(plugin, history, index, "BTC/USD"),
    });
    expect(backtest.points).toHaveLength(4);
    expect(backtest.exposureTimePercent).toBeGreaterThan(0);

    const approval = parseStrategyPaperApproval({
      budget: 1_000,
      maxPositionNotional: 500,
      maxOrderNotional: 150,
      minOrderNotional: 10,
      maxSpreadBps: 50,
      maxDailyTurnoverPercent: 30,
      expiresHours: 12,
    }, "system-test", new Date("2026-06-24T12:30:00.000Z"));
    const draft = draftStrategyPaperOrder({
      approval,
      symbol: "BTC/USD",
      targetExposure: evaluation.targetExposure,
      currentNotional: 0,
      referencePrice: 104,
      spreadBps: 10,
      now: new Date("2026-06-24T13:00:00.000Z"),
    });
    expect(draft.order).toMatchObject({ side: "buy", notional: 150, timeInForce: "gtc" });

    const risk = evaluateStrategyPaperRiskPolicy({
      approval,
      draftOrder: draft.order,
      account: { cash: 1_000, buyingPower: 1_000 },
      orders: [],
      decisions: [],
      performance: { summary: { totalPnl: backtest.totalReturnPercent, maxDrawdownPercent: backtest.maxDrawdownPercent }, points: [] },
      now: new Date("2026-06-24T13:00:00.000Z"),
    });
    expect(risk).toMatchObject({ allowed: true, reasons: [] });

    const paperOrder = {
      id: "order-row-1",
      paperOrderId: "paper-1",
      status: "filled",
      payload: {
        symbol: "BTC/USD",
        side: "buy",
        notional: draft.order!.notional,
        broker: { status: "filled", filledQty: draft.order!.qty, filledAvgPrice: 104, filledAt: "2026-06-24T13:01:00.000Z" },
      },
      createdAt: "2026-06-24T13:00:01.000Z",
      updatedAt: "2026-06-24T13:01:00.000Z",
    };
    const performance = buildStrategyPerformance({
      generatedAt: "2026-06-24T15:00:00.000Z",
      run: {
        id: "run-1",
        strategyId: plugin.id,
        strategyVersion: plugin.version,
        status: "paper",
        symbols: ["BTC/USD"],
        budget: 1_000,
        config: { paperApproval: approval },
      },
      orders: [paperOrder],
      barsBySymbol: {
        "BTC/USD": [
          { timestamp: "2026-06-24T14:00:00.000Z", close: 104 },
          { timestamp: "2026-06-24T15:00:00.000Z", close: 106 },
        ],
      },
    });
    expect(performance.summary).toMatchObject({ status: "available", filledOrders: 1 });
    expect(performance.summary.currentEquity!).toBeGreaterThan(1_000);

    const report = buildStrategyExperimentReport({
      generatedAt: "2026-06-24T15:05:00.000Z",
      run: {
        id: "run-1",
        strategyId: plugin.id,
        strategyVersion: plugin.version,
        status: "paper",
        configHash: "sha256:system",
        policyVersion: "crypto-paper-v1",
        symbols: ["BTC/USD"],
        budget: 1_000,
        config: { paperApproval: approval },
        createdAt: "2026-06-24T12:30:00.000Z",
        updatedAt: "2026-06-24T15:00:00.000Z",
      },
      decisions: [{
        id: "decision-1",
        traceId: "trace-1",
        symbol: "BTC/USD",
        decision: "enter",
        reason: evaluation.reason,
        riskChecks: risk,
        targetPosition: evaluation.targetExposure,
        rawSignal: evaluation.risk.rawTargetExposure,
        riskAdjustedSignal: evaluation.targetExposure,
        orderOutcome: "filled",
        createdAt: "2026-06-24T13:00:00.000Z",
      }],
      traces: [{
        id: "decision-1",
        traceId: "trace-1",
        symbol: "BTC/USD",
        decision: "enter",
        reason: evaluation.reason,
        riskChecks: risk,
        features: evaluation.features ?? {},
        thresholds: evaluation.thresholds ?? {},
        targetPosition: evaluation.targetExposure,
        rawSignal: evaluation.risk.rawTargetExposure,
        riskAdjustedSignal: evaluation.targetExposure,
        orderOutcome: "filled",
        createdAt: "2026-06-24T13:00:00.000Z",
        snapshots: [{ id: "snapshot-1", symbol: "BTC/USD", source: "test-bars", feed: "fixture", stale: false, observedAt: "2026-06-24T13:00:00.000Z" }],
      }],
      orders: [paperOrder],
      metrics: [],
      notes: [],
      performance,
    });

    expect(report).toMatchObject({
      assumptions: { executionMode: "paper" },
      dataCoverage: { decisionCount: 1, snapshotCount: 1, staleSnapshotCount: 0, symbols: ["BTC/USD"] },
      metrics: { decisionCounts: { enter: 1 }, orderOutcomes: { filled: 1 }, submittedOrders: 1, filledOrders: 1, fillRatio: 1 },
      activeRunPerformance: { performanceVersion: "strategy-performance-v1" },
    });
  });
});
