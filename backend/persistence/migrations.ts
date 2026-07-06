/**
 * Append-only SQLite schema history.
 *
 * Applied ids and checksums are verified before new migrations run, preventing
 * a changed or missing historical migration from silently altering a database.
 */
import type { Database } from "bun:sqlite";

export type SchemaMigration = {
  id: string;
  name: string;
  checksum: string;
  up(db: Database): void;
};

function run(db: Database, statements: string[]) {
  for (const statement of statements) db.run(statement);
}

function hasColumn(db: Database, table: string, column: string) {
  return (
    db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((item) => item.name === column);
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    id: "0001",
    name: "core events submissions receipts plans",
    checksum: "sha256:core-events-submissions-receipts-plans-v1",
    up(db) {
      run(db, [
        "CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE submissions (idempotency_key TEXT PRIMARY KEY, order_id TEXT, response TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE plans (id TEXT PRIMARY KEY, intent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      ]);
    },
  },
  {
    id: "0002",
    name: "risk reservations",
    checksum: "sha256:risk-reservations-v1",
    up(db) {
      run(db, [
        `CREATE TABLE risk_reservations (
          reservation_key TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
          qty REAL NOT NULL CHECK(qty > 0),
          price REAL NOT NULL CHECK(price > 0),
          status TEXT NOT NULL CHECK(status IN ('reserved', 'submitted', 'filled', 'canceled', 'rejected', 'released')),
          order_id TEXT,
          expires_at_ms INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX risk_reservations_active ON risk_reservations(status)",
      ]);
    },
  },
  {
    id: "0003",
    name: "ledger and portfolio snapshots",
    checksum: "sha256:ledger-portfolio-snapshots-v1",
    up(db) {
      run(db, [
        `CREATE TABLE account_activities (
          activity_id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          sub_type TEXT,
          category TEXT NOT NULL,
          status TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          symbol TEXT,
          side TEXT,
          quantity REAL,
          price REAL,
          amount REAL NOT NULL,
          order_id TEXT,
          corporate_action TEXT,
          synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX account_activities_occurred ON account_activities(occurred_at DESC, activity_id DESC)",
        "CREATE INDEX account_activities_category ON account_activities(category, occurred_at DESC)",
        "CREATE TABLE portfolio_snapshots (snapshot_date TEXT PRIMARY KEY, payload TEXT NOT NULL)",
      ]);
    },
  },
  {
    id: "0004",
    name: "research runs and metrics",
    checksum: "sha256:research-runs-v1",
    up(db) {
      run(db, [
        `CREATE TABLE research_runs (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
          model TEXT NOT NULL,
          payload TEXT,
          metrics TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        )`,
        "CREATE INDEX research_runs_created ON research_runs(created_at DESC)",
      ]);
    },
  },
  {
    id: "0005",
    name: "strategy lab runs decisions orders metrics notes",
    checksum: "sha256:strategy-lab-v1",
    up(db) {
      run(db, [
        `CREATE TABLE strategy_runs (
          id TEXT PRIMARY KEY,
          strategy_id TEXT NOT NULL,
          strategy_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('backtest', 'shadow', 'paper', 'paused', 'completed', 'retired', 'failed')),
          config_hash TEXT NOT NULL,
          policy_version TEXT NOT NULL,
          symbols TEXT NOT NULL,
          budget REAL NOT NULL CHECK(budget >= 0),
          config TEXT NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX strategy_runs_status ON strategy_runs(status, created_at DESC)",
        `CREATE TABLE strategy_data_snapshots (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
          symbol TEXT NOT NULL,
          source TEXT NOT NULL,
          feed TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          stale INTEGER NOT NULL CHECK(stale IN (0, 1)),
          latency_ms REAL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX strategy_data_snapshots_run ON strategy_data_snapshots(run_id, observed_at DESC)",
        `CREATE TABLE strategy_decisions (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
          symbol TEXT NOT NULL,
          decision TEXT NOT NULL CHECK(decision IN ('hold', 'enter', 'increase', 'reduce', 'exit', 'pause', 'block')),
          features TEXT NOT NULL,
          weights TEXT NOT NULL,
          thresholds TEXT NOT NULL,
          risk_checks TEXT NOT NULL,
          data_snapshot_ids TEXT NOT NULL,
          raw_signal REAL,
          risk_adjusted_signal REAL,
          target_position REAL,
          reason TEXT NOT NULL,
          draft_order TEXT,
          paper_order_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX strategy_decisions_run ON strategy_decisions(run_id, created_at DESC)",
        "CREATE INDEX strategy_decisions_trace ON strategy_decisions(trace_id)",
        `CREATE TABLE strategy_orders (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
          decision_id TEXT NOT NULL REFERENCES strategy_decisions(id) ON DELETE CASCADE,
          paper_order_id TEXT NOT NULL,
          status TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX strategy_orders_run ON strategy_orders(run_id, created_at DESC)",
        `CREATE TABLE strategy_metrics (
          run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          value REAL NOT NULL,
          unit TEXT NOT NULL,
          as_of TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (run_id, name, as_of)
        )`,
        `CREATE TABLE strategy_notes (
          id INTEGER PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
          actor TEXT NOT NULL,
          note TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      ]);
    },
  },
  {
    id: "0006",
    name: "strategy hash chained audit log",
    checksum: "sha256:strategy-audit-v1",
    up(db) {
      run(db, [
        `CREATE TABLE strategy_audit_log (
          id INTEGER PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          actor TEXT NOT NULL,
          subject TEXT NOT NULL,
          strategy_id TEXT,
          strategy_version TEXT,
          policy_version TEXT,
          config_hash TEXT,
          before_payload TEXT,
          after_payload TEXT,
          metadata TEXT NOT NULL,
          previous_hash TEXT,
          entry_hash TEXT NOT NULL UNIQUE,
          retention_until TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX strategy_audit_log_run ON strategy_audit_log(run_id, id)",
      ]);
    },
  },
  {
    id: "0007",
    name: "operations policy",
    checksum: "sha256:operations-policy-v1",
    up(db) {
      db.run(`CREATE TABLE operations_policy (
        id TEXT PRIMARY KEY CHECK(id = 'global'),
        payload TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    },
  },
  {
    id: "0008",
    name: "decision receipt audit log",
    checksum: "sha256:decision-audit-v1",
    up(db) {
      run(db, [
        `CREATE TABLE decision_audit_log (
          id INTEGER PRIMARY KEY,
          subject_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          actor TEXT NOT NULL,
          payload TEXT NOT NULL,
          previous_hash TEXT,
          entry_hash TEXT NOT NULL UNIQUE,
          retention_until TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX decision_audit_log_subject ON decision_audit_log(subject_id, id)",
      ]);
    },
  },
  {
    id: "0009",
    name: "operational readiness exports",
    checksum: "sha256:operational-readiness-v1",
    up(db) {
      db.run(
        "CREATE INDEX events_type_created ON events(type, created_at DESC)",
      );
    },
  },
  {
    id: "0010",
    name: "encrypted secret vault",
    checksum: "sha256:encrypted-secret-vault-v1",
    up(db) {
      db.run(`CREATE TABLE encrypted_secrets (
        name TEXT PRIMARY KEY,
        envelope TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    },
  },
  {
    id: "0011",
    name: "receipt linked trade journal",
    checksum: "sha256:trade-journal-v1",
    up(db) {
      run(db, [
        `CREATE TABLE trade_journal_entries (
          id TEXT PRIMARY KEY,
          receipt_id TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX trade_journal_updated ON trade_journal_entries(updated_at DESC)",
      ]);
    },
  },
  {
    id: "0012",
    name: "normalize legacy ledger and portfolio schema",
    checksum: "sha256:legacy-ledger-portfolio-normalization-v1",
    up(db) {
      if (!hasColumn(db, "account_activities", "corporate_action")) {
        db.run(
          "ALTER TABLE account_activities ADD COLUMN corporate_action TEXT",
        );
      }
      if (hasColumn(db, "portfolio_snapshots", "captured_at")) {
        run(db, [
          "ALTER TABLE portfolio_snapshots RENAME TO portfolio_snapshots_legacy_0012",
          "CREATE TABLE portfolio_snapshots (snapshot_date TEXT PRIMARY KEY, payload TEXT NOT NULL)",
          "INSERT INTO portfolio_snapshots (snapshot_date, payload) SELECT snapshot_date, payload FROM portfolio_snapshots_legacy_0012",
          "DROP TABLE portfolio_snapshots_legacy_0012",
        ]);
      }
      db.run(
        "CREATE INDEX IF NOT EXISTS events_type_created ON events(type, created_at DESC)",
      );
    },
  },
  {
    id: "0013",
    name: "strategy experiment provenance",
    checksum: "sha256:strategy-experiment-provenance-v1",
    up(db) {
      run(db, [
        `CREATE TABLE strategy_backtests (
          id TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          strategy_id TEXT NOT NULL,
          definition_hash TEXT NOT NULL,
          provenance TEXT NOT NULL,
          request TEXT NOT NULL,
          result TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        "CREATE INDEX strategy_backtests_created ON strategy_backtests(created_at DESC)",
        "ALTER TABLE strategy_runs ADD COLUMN backtest_id TEXT REFERENCES strategy_backtests(id)",
        "ALTER TABLE strategy_runs ADD COLUMN provenance TEXT",
        "CREATE INDEX strategy_runs_backtest ON strategy_runs(backtest_id)",
        "ALTER TABLE strategy_data_snapshots ADD COLUMN dataset_hash TEXT",
        "ALTER TABLE strategy_decisions ADD COLUMN provenance TEXT",
      ]);
    },
  },
];

export function migrateDatabase(
  db: Database,
  migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS,
) {
  // Lexicographic ids encode execution order and make gaps easy to detect.
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1]!.id >= migrations[index]!.id)
      throw new Error("Database migrations must be strictly ordered");
  }
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const known = new Map(
    migrations.map((migration) => [migration.id, migration]),
  );
  const applied = db
    .query("SELECT id, name, checksum FROM schema_migrations ORDER BY id")
    .all() as Pick<SchemaMigration, "id" | "name" | "checksum">[];
  for (const row of applied) {
    const expected = known.get(row.id);
    if (!expected) throw new Error(`Unknown database migration ${row.id}`);
    if (row.name !== expected.name || row.checksum !== expected.checksum)
      throw new Error(
        `Database migration ${row.id} does not match the application`,
      );
  }
  if (applied.some((row, index) => row.id !== migrations[index]?.id))
    throw new Error("Database migration history is not contiguous");

  const appliedIds = new Set(applied.map((row) => row.id));
  const insert = db.query(
    "INSERT INTO schema_migrations (id, name, checksum) VALUES (?, ?, ?)",
  );
  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      insert.run(migration.id, migration.name, migration.checksum);
    }).immediate();
  }
}
