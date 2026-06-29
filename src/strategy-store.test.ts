import { expect, test } from "bun:test";
import { encryptSecretValue } from "./secret-vault";
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
    orderOutcome: "drafted",
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
  expect(store.updateStrategyRunConfig("run-2", { schedule: { enabled: true, intervalMinutes: 15 } })).toBe(true);
  expect(store.approveStrategyRunPaper("run-2", 500, { schedule: { enabled: true, intervalMinutes: 15 }, paperApproval: { budget: 500 } })).toBe(true);
  store.strategyNote("run-2", "test", "Needs wider spread filter");
  expect(store.getStrategyRun("run-2")).toMatchObject({ status: "paper", budget: 500, notes: "Paused after review", config: { schedule: { intervalMinutes: 15 }, paperApproval: { budget: 500 } } });
  expect(store.strategyNotes("run-2")).toMatchObject([{ actor: "test", note: "Needs wider spread filter" }]);
  store.close();
});

test("stores hash-chained strategy audit trail with retention metadata", () => {
  const store = createStore(":memory:");
  store.createStrategyRun({
    id: "run-audit",
    strategyId: "moving-average-trend",
    strategyVersion: "strategy-plugin-v1",
    status: "shadow",
    configHash: "sha256:audit",
    policyVersion: "crypto-shadow-v1",
    symbols: ["BTC/USD"],
    budget: 0,
    config: { fast: 5, slow: 20 },
  });

  const created = store.strategyAudit({
    runId: "run-audit",
    kind: "run_created",
    actor: "tester",
    subject: "strategy_run",
    strategyId: "moving-average-trend",
    strategyVersion: "strategy-plugin-v1",
    policyVersion: "crypto-shadow-v1",
    configHash: "sha256:audit",
    after: { status: "shadow", config: { fast: 5, slow: 20 } },
    metadata: { reason: "initial test run" },
    retentionDays: 365,
    createdAt: "2026-06-24T10:00:00.000Z",
  });
  const changed = store.strategyAudit({
    runId: "run-audit",
    kind: "config_changed",
    actor: "tester",
    subject: "strategy_config",
    strategyId: "moving-average-trend",
    strategyVersion: "strategy-plugin-v1",
    policyVersion: "crypto-shadow-v1",
    configHash: "sha256:audit2",
    before: { fast: 5, slow: 20 },
    after: { fast: 8, slow: 30 },
    retentionDays: 365,
    createdAt: "2026-06-24T10:01:00.000Z",
  });

  expect(created).toMatchObject({ kind: "run_created", previousHash: null, retentionUntil: "2027-06-24T10:00:00.000Z" });
  expect(changed.previousHash).toBe(created.entryHash);
  expect(store.strategyAuditTrail("run-audit")).toMatchObject([
    { kind: "run_created", after: { status: "shadow" } },
    { kind: "config_changed", before: { fast: 5 }, after: { slow: 30 } },
  ]);
  expect(store.verifyStrategyAuditTrail("run-audit")).toEqual({ valid: true, entries: 2, invalidEntryId: null });
  store.close();
});

test("persists global operations policy updates", () => {
  const store = createStore(":memory:");

  expect(store.operationsPolicy()).toMatchObject({
    schemaVersion: "operations-policy-v1",
    globalKillSwitch: { active: false },
    maxOrderNotional: 2_500,
    updatedAt: null,
  });

  const updated = store.updateOperationsPolicy("risk-officer", {
    globalKillSwitch: { active: true, reason: "broker outage", activatedAt: "2026-06-25T10:00:00.000Z", activatedBy: "risk-officer" },
    maxOrderNotional: 1_000,
  });

  expect(updated).toMatchObject({
    globalKillSwitch: { active: true, reason: "broker outage", activatedBy: "risk-officer" },
    maxOrderNotional: 1_000,
    updatedBy: "risk-officer",
  });
  expect(store.operationsPolicy()).toMatchObject({ globalKillSwitch: { active: true }, maxOrderNotional: 1_000 });
  expect(() => store.updateOperationsPolicy("risk-officer", { globalKillSwitch: { active: true, reason: "" } })).toThrow("A kill-switch reason is required");
  store.close();
});

test("exports operational readiness evidence for migrations backups observability and incidents", () => {
  const store = createStore(":memory:");
  store.event("otel.span", "tester", { traceId: "trace-ops", name: "strategy.tick", status: "ok" });
  store.event("strategy.scheduler.error", "scheduler", { runId: "run-ops", error: "test failure" });
  store.createStrategyRun({
    id: "run-ops",
    strategyId: "moving-average-trend",
    strategyVersion: "1.0.0",
    status: "shadow",
    configHash: "sha256:ops",
    policyVersion: "crypto-shadow-v1",
    symbols: ["BTC/USD"],
    budget: 0,
    config: {},
  });
  store.strategyMetric({ runId: "run-ops", name: "strategy_error_count", value: 1, unit: "count", asOf: "2026-06-25T10:00:00.000Z" });

  const migrations = store.schemaMigrations();
  expect(migrations.length).toBeGreaterThanOrEqual(10);
  expect(migrations.every(row => row.expected)).toBe(true);
  const secret = store.upsertEncryptedSecret("OPENAI_API_KEY", encryptSecretValue("test-secret", "abcdefghijklmnopqrstuvwxyz123456", new Date("2026-06-26T10:00:00.000Z")), "admin@example.com");
  expect(secret).toMatchObject({ name: "OPENAI_API_KEY", algorithm: "aes-256-gcm", updatedBy: "admin@example.com" });
  expect(JSON.stringify(store.encryptedSecret("OPENAI_API_KEY"))).not.toContain("test-secret");
  expect(store.encryptedSecretMetadata()).toMatchObject([{ name: "OPENAI_API_KEY", ciphertextBytes: 11 }]);

  const backup = store.databaseBackup();
  expect(backup.metadata).toMatchObject({ migrations: migrations.length });
  expect(backup.metadata.sizeBytes).toBeGreaterThan(0);
  expect(backup.metadata.sha256).toStartWith("sha256:");

  const exportPayload = store.observabilityExport();
  expect(exportPayload.spans).toMatchObject([{ traceId: "trace-ops", name: "strategy.tick" }]);
  expect(exportPayload.strategyMetrics).toMatchObject([{ runId: "run-ops", name: "strategy_error_count", value: 1 }]);
  expect(exportPayload.decisionAuditVerification).toEqual({ valid: true, entries: 0, invalidEntryId: null });

  const incident = store.incidentPacket();
  expect(incident.severity).toBe("review");
  expect(incident.recentEvents).toMatchObject([{ type: "strategy.scheduler.error" }]);
  expect(incident.runbook.join(" ")).toContain("Download a database backup");
  store.close();
});

test("filters strategy decisions and exposes linked order outcomes", () => {
  const store = createStore(":memory:");
  store.createStrategyRun({
    id: "run-3",
    strategyId: "moving-average-trend",
    strategyVersion: "1.0.0",
    status: "shadow",
    configHash: "sha256:ghi",
    policyVersion: "crypto-shadow-v1",
    symbols: ["BTC/USD"],
    budget: 0,
    config: {},
  });
  store.strategyDecision({
    id: "decision-blocked",
    traceId: "trace-blocked",
    runId: "run-3",
    symbol: "BTC/USD",
    decision: "block",
    features: { fastAverage: 100 },
    weights: {},
    thresholds: {},
    riskChecks: { allowed: false, reasons: ["stale_data"], intendedAction: "enter" },
    dataSnapshotIds: [],
    rawSignal: 1,
    riskAdjustedSignal: 0,
    targetPosition: 0,
    reason: "Blocked by stale crypto market data",
  });
  store.strategyDecision({
    id: "decision-order",
    traceId: "trace-order",
    runId: "run-3",
    symbol: "BTC/USD",
    decision: "enter",
    features: {},
    weights: {},
    thresholds: {},
    riskChecks: { allowed: true, reasons: [] },
    dataSnapshotIds: [],
    rawSignal: 1,
    riskAdjustedSignal: 1,
    targetPosition: 1,
    reason: "Trend confirmed",
    paperOrderId: "paper-1",
  });
  store.strategyOrder({ id: "strategy-order-1", runId: "run-3", decisionId: "decision-order", paperOrderId: "paper-1", status: "accepted", payload: { filledQty: 0 } });

  expect(store.strategyDecisions("run-3", 10, { decision: "block", blockReason: "stale" })).toMatchObject([{ traceId: "trace-blocked", orderOutcome: "none" }]);
  expect(store.strategyDecisions("run-3", 10, { orderOutcome: "accepted" })).toMatchObject([{ traceId: "trace-order", order: { paperOrderId: "paper-1", status: "accepted" } }]);
  expect(store.getStrategyDecisionTrace("trace-order")).toMatchObject({ orderOutcome: "accepted", order: { status: "accepted", payload: { filledQty: 0 } } });
  expect(store.strategyOrders("run-3")).toMatchObject([{ paperOrderId: "paper-1", status: "accepted", payload: { filledQty: 0 } }]);
  expect(store.reconcileStrategyOrder("paper-1", "filled", { broker: { status: "filled", filledAvgPrice: 50_050 }, brokerReconciledAt: "2026-06-24T11:00:00.000Z" })).toBe(true);
  expect(store.getStrategyDecisionTrace("trace-order")).toMatchObject({ orderOutcome: "filled", order: { status: "filled", payload: { filledQty: 0, broker: { filledAvgPrice: 50_050 } } } });
  store.close();
});
