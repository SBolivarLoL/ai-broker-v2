import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetentionService,
  retentionPolicyFromEnv,
} from "../../backend/features/operations/retention";
import { createStore } from "../../backend/persistence/store";

const now = new Date("2026-07-12T12:00:00.000Z");

function fixtureDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "ai-broker-retention-"));
  const filename = join(directory, "retention.sqlite");
  createStore(filename).close();
  const db = new Database(filename, { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  const run = db.query(
    `INSERT INTO strategy_runs
      (id, strategy_id, strategy_version, status, config_hash, policy_version, symbols, budget, config, created_at, updated_at)
     VALUES (?, 'moving-average-trend', 'strategy-plugin-v1', ?, 'sha256:config', 'crypto-shadow-v1', '["BTC/USD"]', 100, '{}', ?, ?)`,
  );
  run.run("run-active", "shadow", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
  run.run("run-terminal", "completed", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");

  const snapshot = db.query(
    `INSERT INTO strategy_data_snapshots
      (id, run_id, symbol, source, feed, observed_at, stale, latency_ms, payload, created_at, dataset_hash)
     VALUES (?, ?, 'BTC/USD', 'Alpaca crypto snapshot', 'us', ?, 0, 5, ?, ?, ?)`,
  );
  const book = (seed: number) => ({
    quote: { bid: seed, ask: seed + 1 },
    orderbook: {
      b: [[seed, 1], [seed - 1, 2]],
      a: [[seed + 1, 1], [seed + 2, 2]],
    },
  });
  const old = "2025-01-01T00:00:00.000Z";
  snapshot.run("snap-active-older", "run-active", old, JSON.stringify(book(90)), old, `sha256:${"1".repeat(64)}`);
  snapshot.run("snap-active-latest", "run-active", old, JSON.stringify(book(100)), "2025-02-01T00:00:00.000Z", `sha256:${"2".repeat(64)}`);
  snapshot.run("snap-decision", "run-active", old, JSON.stringify(book(110)), "2025-01-15T00:00:00.000Z", `sha256:${"3".repeat(64)}`);
  snapshot.run("snap-terminal", "run-terminal", old, JSON.stringify(book(120)), old, `sha256:${"4".repeat(64)}`);

  db.query(
    `INSERT INTO strategy_decisions
      (id, trace_id, run_id, symbol, decision, features, weights, thresholds, risk_checks, data_snapshot_ids, reason, created_at)
     VALUES ('decision-1', 'trace-1', 'run-active', 'BTC/USD', 'hold', '{}', '{}', '{}', '{}', '["snap-decision"]', 'fixture decision', ?)`,
  ).run(old);

  const metric = db.query(
    `INSERT INTO strategy_metrics (run_id, name, value, unit, as_of, created_at)
     VALUES ('run-active', ?, ?, 'count', ?, ?)`,
  );
  metric.run("decision_count", 1, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
  metric.run("decision_count", 2, "2025-02-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z");
  metric.run("block_count", 1, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");

  const event = db.query(
    "INSERT INTO events (type, actor, payload, created_at) VALUES (?, 'fixture', '{}', ?)",
  );
  event.run("otel.span", old);
  event.run("otel.span", "2026-07-01T00:00:00.000Z");
  event.run("research.completed", old);
  event.run("research.completed", "2026-07-01T00:00:00.000Z");

  const research = db.query(
    `INSERT INTO research_runs
      (id, symbol, status, model, payload, error, created_at, completed_at)
     VALUES (?, 'AAPL', ?, ?, ?, ?, ?, ?)`,
  );
  research.run(
    "research-parent",
    "completed",
    "deterministic-comparable-valuations-v3",
    JSON.stringify({ runId: "research-parent" }),
    null,
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:01.000Z",
  );
  research.run(
    "research-child",
    "completed",
    "deterministic-valuation-scenarios-v3",
    JSON.stringify({ parentRunId: "research-parent" }),
    null,
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:01.000Z",
  );
  research.run(
    "research-orphan",
    "completed",
    "gpt-fixture",
    JSON.stringify({ evidence: [] }),
    null,
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:01.000Z",
  );
  research.run(
    "research-old-parent",
    "completed",
    "deterministic-comparable-valuations-v3",
    JSON.stringify({ runId: "research-old-parent" }),
    null,
    "2023-01-01T00:00:00.000Z",
    "2023-01-01T00:00:01.000Z",
  );
  research.run(
    "research-old-child",
    "completed",
    "deterministic-valuation-scenarios-v3",
    JSON.stringify({ parentRunId: "research-old-parent" }),
    null,
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:01.000Z",
  );
  research.run(
    "research-failed",
    "failed",
    "gpt-fixture",
    null,
    "fixture failure",
    "2025-01-01T00:00:00.000Z",
    "2025-01-01T00:00:01.000Z",
  );
  research.run(
    "research-running",
    "running",
    "gpt-fixture",
    null,
    null,
    "2026-06-01T00:00:00.000Z",
    null,
  );
  db.close();
  return {
    directory,
    filename,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("retention pruning bounds high-volume records while preserving lineage", async () => {
  const fixture = fixtureDatabase();
  try {
    const store = createStore(fixture.filename);
    const audit = store.strategyAudit({
      runId: "run-active",
      kind: "fixture",
      actor: "tester",
      subject: "retention contract",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    store.decisionAudit({
      subjectId: "decision-1",
      kind: "fixture",
      actor: "tester",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const service = createRetentionService({
      store,
      policy: retentionPolicyFromEnv({}),
      now: () => now,
    });

    const before = service.report();
    expect(before.inventory).toMatchObject({
      strategySnapshots: {
        total: 4,
        eligibleForDeletion: 2,
        protectedByDecision: 1,
        protectedActiveLatest: 1,
        orderBooksEligibleForCompaction: 4,
      },
      strategyMetrics: { total: 3, eligibleForDeletion: 1 },
      spans: { total: 2, eligibleForDeletion: 1 },
      providerEvidence: {
        totalResearchRuns: 7,
        eligibleResearchRuns: 4,
        protectedReplayParents: 2,
        eligibleResearchEvents: 1,
      },
    });

    const first = service.run("manual", "test-admin");
    const overlapping = service.run("manual", "ignored-overlap");
    expect(overlapping).toBe(first);
    const run = await first;
    expect(run).toMatchObject({
      schemaVersion: "retention-run-v1",
      trigger: "manual",
      actor: "test-admin",
      deleted: {
        strategySnapshots: 2,
        strategyMetrics: 1,
        spans: 1,
        researchRuns: 4,
        researchEvents: 1,
      },
      compacted: {
        strategyOrderBooks: 2,
        removedBidLevels: 4,
        removedAskLevels: 4,
      },
    });
    expect(run.compacted.removedBytes).toBeGreaterThan(0);
    expect(run.remainingEligible.strategySnapshots.eligibleForDeletion).toBe(0);

    const trace = store.getStrategyDecisionTrace("trace-1");
    expect(trace).toMatchObject({
      snapshots: [
        {
          id: "snap-decision",
          datasetHash: `sha256:${"3".repeat(64)}`,
          payload: {
            orderbook: null,
            retention: {
              schemaVersion: "strategy-snapshot-retention-v1",
              orderBook: {
                status: "pruned",
                prunedAt: now.toISOString(),
                originalPayloadHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
                removedBidLevels: 2,
                removedAskLevels: 2,
              },
            },
          },
        },
      ],
    });
    expect(store.strategyMetrics("run-active")).toMatchObject([
      { name: "decision_count", value: 2 },
      { name: "block_count", value: 1 },
    ]);
    expect(store.getResearch("research-parent")).not.toBeNull();
    expect(store.getResearch("research-child")).not.toBeNull();
    expect(store.getResearch("research-orphan")).toBeNull();
    expect(store.getResearch("research-failed")).toBeNull();
    expect(store.getResearch("research-running")).toBeNull();
    expect(store.getResearch("research-old-child")).toBeNull();
    expect(store.getResearch("research-old-parent")).not.toBeNull();
    expect(store.strategyAuditTrail("run-active")).toHaveLength(1);
    expect(store.strategyAuditTrail("run-active")[0]?.entryHash).toBe(
      audit.entryHash,
    );
    expect(store.verifyStrategyAuditTrail("run-active").valid).toBe(true);
    expect(store.verifyDecisionAuditTrail().valid).toBe(true);
    expect(store.events(10, "operations.retention.completed")).toHaveLength(1);

    const followup = await service.run("scheduler", "retention-scheduler");
    expect(followup.deleted).toEqual({
      strategySnapshots: 0,
      strategyMetrics: 0,
      spans: 0,
      researchRuns: 1,
      researchEvents: 0,
    });
    expect(followup.compacted.strategyOrderBooks).toBe(0);
    expect(store.getResearch("research-old-parent")).toBeNull();
    const repeated = await service.run("scheduler", "retention-scheduler");
    expect(repeated.deleted).toEqual({
      strategySnapshots: 0,
      strategyMetrics: 0,
      spans: 0,
      researchRuns: 0,
      researchEvents: 0,
    });
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test("retention fails closed and rolls back when snapshot lineage is malformed", async () => {
  const fixture = fixtureDatabase();
  try {
    const raw = new Database(fixture.filename, { strict: true });
    raw.query(
      "UPDATE strategy_decisions SET data_snapshot_ids = 'not-json' WHERE id = 'decision-1'",
    ).run();
    raw.close();
    const store = createStore(fixture.filename);
    const service = createRetentionService({
      store,
      policy: retentionPolicyFromEnv({}),
      now: () => now,
    });
    await expect(service.run("manual", "test-admin")).rejects.toThrow(
      "snapshot references are malformed",
    );
    expect(service.report().inventory.strategySnapshots.total).toBe(4);
    expect(store.events(10, "operations.retention.failed")).toMatchObject([
      {
        payload: {
          reason: "retention_pruning_failed",
          trigger: "manual",
        },
      },
    ]);
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test("retention policy rejects unsafe or unbounded configuration", () => {
  expect(() =>
    retentionPolicyFromEnv({ RETENTION_SPAN_DAYS: "0" }),
  ).toThrow("RETENTION_SPAN_DAYS");
  expect(() =>
    retentionPolicyFromEnv({ RETENTION_BATCH_LIMIT: "10001" }),
  ).toThrow("RETENTION_BATCH_LIMIT");
  expect(retentionPolicyFromEnv({})).toMatchObject({
    strategySnapshotDays: 30,
    orderBookDays: 90,
    strategyMetricDays: 90,
    spanDays: 30,
    providerEvidenceDays: 365,
    failedResearchDays: 30,
    staleRunningResearchHours: 24,
    batchLimit: 5_000,
  });
});
