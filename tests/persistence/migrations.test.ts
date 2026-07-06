import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase, SCHEMA_MIGRATIONS, type SchemaMigration } from "../../backend/persistence/migrations";
import { createStore } from "../../backend/persistence/store";
import { canonicalHash, STRATEGY_FEATURE_SCHEMA_VERSION } from "../../backend/features/strategies/strategy-provenance";
import {
  buildVersionedCryptoDataset,
  parseCryptoDatasetRequest,
} from "../../backend/features/strategies/strategy-datasets";

function temporaryDatabase(name: string) {
  const directory = mkdtempSync(join(tmpdir(), "ai-broker-migration-"));
  return { directory, filename: join(directory, name) };
}

test("migration failures roll back schema changes and history", () => {
  const db = new Database(":memory:", { strict: true });
  const broken: SchemaMigration = {
    id: "0001",
    name: "broken migration",
    checksum: "sha256:broken",
    up(database) {
      database.run("CREATE TABLE should_roll_back (id INTEGER PRIMARY KEY)");
      throw new Error("migration failed");
    },
  };

  expect(() => migrateDatabase(db, [broken])).toThrow("migration failed");
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'should_roll_back'").get()).toBeNull();
  expect(db.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 0 });

  const applied = { ...broken, up(database: Database) { database.run("CREATE TABLE applied (id INTEGER PRIMARY KEY)"); } };
  migrateDatabase(db, [applied]);
  expect(() => migrateDatabase(db, [{ ...applied, checksum: "sha256:changed" }]))
    .toThrow("Database migration 0001 does not match the application");
  expect(() => migrateDatabase(db, [{ ...applied, id: "0002" }, applied]))
    .toThrow("Database migrations must be strictly ordered");
  db.close();

  const gap = new Database(":memory:", { strict: true });
  migrateDatabase(gap, []);
  const second = SCHEMA_MIGRATIONS[1]!;
  gap.query("INSERT INTO schema_migrations (id, name, checksum) VALUES (?, ?, ?)").run(second.id, second.name, second.checksum);
  expect(() => migrateDatabase(gap, SCHEMA_MIGRATIONS.slice(0, 2))).toThrow("Database migration history is not contiguous");
  gap.close();
});

test("upgrades an 0011 database fixture without losing legacy rows", () => {
  const { directory, filename } = temporaryDatabase("legacy.sqlite");
  try {
    const legacy = new Database(filename, { create: true, strict: true });
    migrateDatabase(legacy, SCHEMA_MIGRATIONS.slice(0, 2));
    legacy.run(`CREATE TABLE account_activities (
      activity_id TEXT PRIMARY KEY, type TEXT NOT NULL, sub_type TEXT, category TEXT NOT NULL,
      status TEXT NOT NULL, occurred_at TEXT NOT NULL, symbol TEXT, side TEXT, quantity REAL,
      price REAL, amount REAL NOT NULL, order_id TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    legacy.run("CREATE INDEX account_activities_occurred ON account_activities(occurred_at DESC, activity_id DESC)");
    legacy.run("CREATE INDEX account_activities_category ON account_activities(category, occurred_at DESC)");
    legacy.run("CREATE TABLE portfolio_snapshots (snapshot_date TEXT PRIMARY KEY, payload TEXT NOT NULL, captured_at TEXT NOT NULL)");
    const ledgerMigration = SCHEMA_MIGRATIONS[2]!;
    legacy.query("INSERT INTO schema_migrations (id, name, checksum) VALUES (?, ?, ?)")
      .run(ledgerMigration.id, ledgerMigration.name, ledgerMigration.checksum);
    migrateDatabase(legacy, SCHEMA_MIGRATIONS.slice(0, 11));
    legacy.query(`INSERT INTO strategy_runs
      (id, strategy_id, strategy_version, status, config_hash, policy_version, symbols, budget, config)
      VALUES (?, ?, ?, 'shadow', ?, ?, ?, 0, ?)`)
      .run("legacy-run", "moving-average-trend", "strategy-plugin-v1", "sha256:legacy", "crypto-shadow-v1", JSON.stringify(["BTC/USD"]), JSON.stringify({ fast: 5, slow: 20 }));
    legacy.run(`INSERT INTO account_activities
      (activity_id, type, category, status, occurred_at, symbol, side, quantity, price, amount)
      VALUES ('legacy-fill', 'FILL', 'trade', 'executed', '2026-01-02T10:00:00.000Z', 'AAPL', 'buy', 1, 100, -100)`);
    legacy.query("INSERT INTO portfolio_snapshots (snapshot_date, payload, captured_at) VALUES (?, ?, ?)")
      .run("2026-01-02", JSON.stringify({ snapshotDate: "2026-01-02", equity: 10_000 }), "2026-01-02T23:59:00.000Z");
    legacy.close();

    const upgraded = createStore(filename);
    expect(upgraded.schemaMigrations().at(-1)).toMatchObject({ id: "0014", expected: true });
    expect(upgraded.activities()).toMatchObject([{ id: "legacy-fill", symbol: "AAPL", corporateAction: null }]);
    expect(upgraded.portfolioSnapshots()).toEqual([{ snapshotDate: "2026-01-02", equity: 10_000 }]);
    expect(upgraded.getStrategyRun("legacy-run")).toMatchObject({ backtestId: null, provenance: null, comparable: false });
    expect(upgraded.strategyBarDatasets("restore-test")).toEqual([]);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restores a serialized backup with migrations and audit chains intact", () => {
  const { directory, filename: sourceFilename } = temporaryDatabase("source.sqlite");
  const restoredFilename = join(directory, "restored.sqlite");
  const source = createStore(sourceFilename);
  try {
    const definitionHash = canonicalHash({ strategyId: "moving-average-trend", symbols: ["BTC/USD"] });
    const provenance = {
      gitCommit: "a".repeat(40),
      workingTreeDirty: false,
      pluginVersion: "strategy-plugin-v1",
      featureSchemaVersion: STRATEGY_FEATURE_SCHEMA_VERSION,
      policyVersion: "crypto-shadow-v1",
      definitionHash,
      provider: "Alpaca Market Data API",
      feed: "us",
      query: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-03T00:00:00.000Z", timeframe: "1Hour", symbols: ["BTC/USD"] },
      datasetHash: canonicalHash([100, 101]),
    };
    source.strategyBacktest({
      id: "restore-backtest",
      actor: "restore-test",
      strategyId: "moving-average-trend",
      definitionHash,
      provenance: { ...provenance, policyVersion: "crypto-backtest-v1" },
      request: { strategyId: "moving-average-trend" },
      result: { totalReturnPercent: 1 },
    });
    source.createStrategyRun({
      id: "restore-run",
      backtestId: "restore-backtest",
      strategyId: "moving-average-trend",
      strategyVersion: "strategy-plugin-v1",
      status: "shadow",
      configHash: "sha256:restore",
      policyVersion: "crypto-shadow-v1",
      symbols: ["BTC/USD"],
      budget: 0,
      config: { fast: 5, slow: 20 },
      provenance,
    });
    source.strategyAudit({
      runId: "restore-run",
      kind: "run_created",
      actor: "restore-test",
      subject: "strategy_run",
      after: { status: "shadow" },
      createdAt: "2026-01-03T10:00:00.000Z",
    });
    source.strategyAudit({
      runId: "restore-run",
      kind: "config_reviewed",
      actor: "restore-test",
      subject: "strategy_config",
      before: { fast: 5, slow: 20 },
      after: { fast: 8, slow: 30 },
      createdAt: "2026-01-03T10:01:00.000Z",
    });
    source.decisionAudit({
      subjectId: "restore-receipt",
      kind: "receipt.created",
      actor: "restore-test",
      payload: { status: "accepted" },
      createdAt: "2026-01-03T10:02:00.000Z",
    });
    source.decisionAudit({
      subjectId: "restore-receipt",
      kind: "receipt.reconciled",
      actor: "restore-test",
      payload: { status: "filled" },
      createdAt: "2026-01-03T10:03:00.000Z",
    });
    const datasetRequest = parseCryptoDatasetRequest({
      symbols: ["BTC/USD"],
      timeframe: "1Hour",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T02:00:00.000Z",
    }, new Date("2026-01-03T00:00:00.000Z"));
    const dataset = buildVersionedCryptoDataset({
      request: datasetRequest,
      rawBars: { "BTC/USD": [
        { t: "2026-01-01T00:00:00.000Z", o: 100, h: 101, l: 99, c: 100, v: 10 },
        { t: "2026-01-01T01:00:00.000Z", o: 101, h: 102, l: 100, c: 101, v: 11 },
      ] },
    });
    source.strategyBarDataset({
      id: "restore-dataset",
      actor: "restore-test",
      provider: dataset.provider,
      feed: dataset.feed,
      timezone: dataset.timezone,
      timeframe: dataset.timeframe,
      symbols: dataset.symbols,
      start: dataset.start,
      end: dataset.end,
      datasetHash: dataset.datasetHash,
      previousDatasetId: null,
      stats: dataset.stats,
      bars: dataset.bars,
    });
    const backup = source.databaseBackup();
    source.close();
    writeFileSync(restoredFilename, backup.bytes);

    const restored = createStore(restoredFilename);
    expect(restored.getStrategyRun("restore-run")).toMatchObject({ status: "shadow", configHash: "sha256:restore", backtestId: "restore-backtest", comparable: true });
    expect(restored.getStrategyBacktest("restore-backtest")).toMatchObject({ actor: "restore-test", provenance: { datasetHash: provenance.datasetHash } });
    expect(restored.getStrategyBarDataset("restore-dataset")).toMatchObject({ actor: "restore-test", bars: [{ symbol: "BTC/USD" }, { symbol: "BTC/USD" }] });
    expect(restored.verifyStrategyAuditTrail("restore-run")).toEqual({ valid: true, entries: 2, invalidEntryId: null });
    expect(restored.verifyDecisionAuditTrail()).toEqual({ valid: true, entries: 2, invalidEntryId: null });
    expect(restored.schemaMigrations()).toHaveLength(SCHEMA_MIGRATIONS.length);
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
