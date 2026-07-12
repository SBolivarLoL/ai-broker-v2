import { describe, expect, test } from "bun:test";
import { evaluateStrategyPlugin, parseStrategyParams, runBacktest, strategyPluginFromId, type BacktestBar } from "../../backend/features/strategies/strategy-backtest";
import { buildStrategyPerformance } from "../../backend/features/strategies/strategy-performance";
import { buildStrategyExperimentReport } from "../../backend/features/strategies/strategy-report";
import { draftStrategyPaperOrder, evaluateStrategyPaperRiskPolicy, parseStrategyPaperApproval } from "../../backend/features/strategies/strategy-paper";
import { buildClosedBetaEvidenceReport } from "../../backend/features/operations/production-governance";
import { createStore } from "../../backend/persistence/store";
import { canonicalHash, STRATEGY_FEATURE_SCHEMA_VERSION } from "../../backend/features/strategies/strategy-provenance";

const bars: BacktestBar[] = [
  { timestamp: "2026-06-24T10:00:00.000Z", close: 100 },
  { timestamp: "2026-06-24T11:00:00.000Z", close: 101 },
  { timestamp: "2026-06-24T12:00:00.000Z", close: 102 },
  { timestamp: "2026-06-24T13:00:00.000Z", close: 104 },
];

describe("strategy backend system flow", () => {
  test("persists canonical defaults and replays the same strategy configuration", () => {
    const store = createStore(":memory:");
    try {
      const params = parseStrategyParams("moving-average-trend", { exposure: 0.5 });
      const config = { symbols: ["BTC/USD"], strategyId: "moving-average-trend", params, timeframe: "1Hour", days: 30, mode: "shadow" };
      const definitionHash = canonicalHash({ symbols: config.symbols, strategyId: config.strategyId, params, timeframe: config.timeframe, days: config.days });
      const provenance = {
        gitCommit: "a".repeat(40),
        workingTreeDirty: false,
        pluginVersion: "strategy-plugin-v1",
        featureSchemaVersion: STRATEGY_FEATURE_SCHEMA_VERSION,
        policyVersion: "crypto-shadow-v1",
        definitionHash,
        provider: "Alpaca Market Data API",
        feed: "us",
        query: { start: "2026-05-25T00:00:00.000Z", end: "2026-06-24T00:00:00.000Z", timeframe: "1Hour", symbols: ["BTC/USD"] },
        datasetHash: canonicalHash(bars),
      };
      store.strategyBacktest({
        id: "backtest-defaults",
        actor: "system-test",
        strategyId: "moving-average-trend",
        definitionHash,
        provenance: { ...provenance, policyVersion: "crypto-backtest-v1" },
        request: config,
        result: { points: bars.length },
      });
      store.createStrategyRun({
        id: "run-defaults",
        backtestId: "backtest-defaults",
        strategyId: "moving-average-trend",
        strategyVersion: "strategy-plugin-v1",
        status: "shadow",
        configHash: "sha256:canonical-defaults",
        policyVersion: "crypto-shadow-v1",
        symbols: ["BTC/USD"],
        budget: 0,
        config,
        provenance,
      });

      const stored = store.getStrategyRun("run-defaults")!;
      expect(stored.config).toMatchObject({ params: { fast: 5, slow: 20, exposure: 0.5 } });
      const storedConfig = stored.config as typeof config;
      const evaluation = evaluateStrategyPlugin(strategyPluginFromId(stored.strategyId, storedConfig.params), bars, bars.length - 1, stored.symbols[0]);
      expect(evaluation.thresholds).toEqual({ fast: 5, slow: 20, exposure: 0.5 });
    } finally {
      store.close();
    }
  });

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

  test("keeps blocked strategy ticks out of paper orders and beta exit evidence", () => {
    const plugin = strategyPluginFromId("order-book-liquidity-scout", { exposure: 0.5 });
    const evaluation = evaluateStrategyPlugin(plugin, bars, bars.length - 1, "BTC/USD", { snapshots: {} });
    expect(evaluation).toMatchObject({
      targetExposure: 0,
      reason: "waiting for order-book liquidity snapshot",
      orders: [{ type: "target_exposure", targetExposure: 0 }],
    });

    const approval = parseStrategyPaperApproval({ budget: 1_000, maxOrderNotional: 150, minOrderNotional: 10 }, "system-test", new Date("2026-06-24T12:30:00.000Z"));
    const draft = draftStrategyPaperOrder({
      approval,
      symbol: "BTC/USD",
      targetExposure: evaluation.targetExposure,
      currentNotional: 0,
      referencePrice: 104,
      spreadBps: 10,
      now: new Date("2026-06-24T13:00:00.000Z"),
    });
    expect(draft).toEqual({ allowed: true, reasons: ["target_within_band"], order: null });

    const risk = evaluateStrategyPaperRiskPolicy({
      approval,
      draftOrder: draft.order,
      account: { cash: 1_000, buyingPower: 1_000 },
      now: new Date("2026-06-24T13:00:00.000Z"),
    });
    expect(risk).toMatchObject({ allowed: true, reasons: [] });

    const report = buildStrategyExperimentReport({
      generatedAt: "2026-06-24T13:05:00.000Z",
      run: {
        id: "run-blocked",
        strategyId: plugin.id,
        strategyVersion: plugin.version,
        status: "paper",
        configHash: "sha256:block",
        policyVersion: "crypto-paper-v1",
        symbols: ["BTC/USD"],
        budget: 1_000,
        config: { paperApproval: approval, reviewHistory: [{ action: "continue", note: "Wait for valid book data" }] },
        createdAt: "2026-06-24T12:30:00.000Z",
        updatedAt: "2026-06-24T13:00:00.000Z",
      },
      decisions: [{
        id: "decision-blocked",
        traceId: "trace-blocked",
        symbol: "BTC/USD",
        decision: "block",
        reason: evaluation.reason,
        riskChecks: { mode: "paper", allowed: false, reasons: ["stale_data"], submittedOrder: false },
        targetPosition: evaluation.targetExposure,
        rawSignal: evaluation.risk.rawTargetExposure,
        riskAdjustedSignal: evaluation.targetExposure,
        orderOutcome: "none",
        createdAt: "2026-06-24T13:00:00.000Z",
      }],
      traces: [{
        id: "decision-blocked",
        traceId: "trace-blocked",
        symbol: "BTC/USD",
        decision: "block",
        reason: evaluation.reason,
        riskChecks: { mode: "paper", allowed: false, reasons: ["stale_data"], submittedOrder: false },
        features: evaluation.features ?? {},
        thresholds: evaluation.thresholds ?? {},
        targetPosition: evaluation.targetExposure,
        rawSignal: evaluation.risk.rawTargetExposure,
        riskAdjustedSignal: evaluation.targetExposure,
        orderOutcome: "none",
        createdAt: "2026-06-24T13:00:00.000Z",
        snapshots: [{ id: "snapshot-stale", symbol: "BTC/USD", source: "alpaca-crypto", feed: "us", stale: true, observedAt: "2026-06-24T12:45:00.000Z" }],
      }],
      orders: [],
      metrics: [],
      notes: [],
    });
    expect(report).toMatchObject({
      dataCoverage: { decisionCount: 1, staleSnapshotCount: 1 },
      metrics: { decisionCounts: { block: 1 }, orderOutcomes: { none: 1 }, submittedOrders: 0, filledOrders: 0, fillRatio: null },
      reasonCodedFailures: { stale_data: 1 },
    });

    const betaDrillHashes = ["1", "2", "3", "4"].map(
      (value) => `sha256:${value.repeat(64)}`,
    );
    const betaWindowHash = `sha256:${"5".repeat(64)}`;
    const beta = buildClosedBetaEvidenceReport({
      paperClient: true,
      decisionAuditVerification: { valid: true, entries: 1, invalidEntryId: null },
      decisionAuditEntryHashes: [...betaDrillHashes, betaWindowHash],
      receipts: [],
      events: [
        { type: "operations.backup.exported", actor: "operator@example.com", payload: {}, createdAt: "2026-06-24T13:00:00.000Z" },
        { type: "operations.kill_switch.activated", actor: "operator@example.com", payload: {}, createdAt: "2026-06-24T13:01:00.000Z" },
        { type: "operations.kill_switch.cleared", actor: "operator@example.com", payload: {}, createdAt: "2026-06-24T13:02:00.000Z" },
        ...["backup_export", "restore", "kill_switch", "incident_response"].map((drillType, index) => ({
          type: "operations.closed_beta.drill_recorded",
          actor: "operator@example.com",
          payload: {
            schemaVersion: "closed-beta-workflow-record-v1",
            recordId: `system-drill-${index}`,
            kind: "drill",
            drillType,
            outcome: "pass",
            title: `${drillType} drill`,
            reference: `local://drill/${drillType}`,
            occurredAt: `2026-06-24T12:${50 + index}:00.000Z`,
            auditEntryHash: betaDrillHashes[index],
          },
          createdAt: `2026-06-24T12:${50 + index}:00.000Z`,
        })),
        {
          type: "operations.closed_beta.beta_window_recorded",
          actor: "operator@example.com",
          payload: {
            schemaVersion: "closed-beta-workflow-record-v1",
            recordId: "system-beta-window",
            kind: "beta_window",
            title: "System paper beta",
            reference: "local://beta/system",
            occurredAt: "2026-06-24T13:05:00.000Z",
            startedAt: "2026-05-20T13:05:00.000Z",
            endedAt: "2026-06-24T13:05:00.000Z",
            participantCount: 1,
            auditEntryHash: betaWindowHash,
          },
          createdAt: "2026-06-24T13:05:00.000Z",
        },
      ],
      strategyRuns: [{ id: "run-blocked", status: "paper", config: { paperApproval: approval }, reviewCount: 1, reviewTimes: ["2026-06-24T13:03:00.000Z"] }],
      strategyDecisions: [{
        runId: "run-blocked",
        decision: "block",
        riskChecks: { mode: "paper", allowed: false, reasons: ["stale_data"], submittedOrder: false },
        paperOrderId: null,
        orderOutcome: "none",
        createdAt: "2026-06-24T13:00:00.000Z",
      }],
      backupMetadata: { sha256: "sha256:backup", sizeBytes: 2048, createdAt: "2026-06-24T13:00:00.000Z" },
    }, "2026-06-24T13:10:00.000Z");

    expect(beta.summary).toMatchObject({ pass: 7, fail: 0, needsEvidence: 1, readyForExitReview: false });
    expect(beta.summary.openTargets).toEqual(["signed_preview_coverage"]);
    expect(beta.targets.find(target => target.id === "stale_data")).toMatchObject({ status: "pass", observedEvidence: { staleSubmittedCount: 0 } });
  });
});
