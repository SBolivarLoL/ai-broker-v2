import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { LedgerActivity, LedgerCategory } from "./ledger";

export type RiskReservationStatus = "reserved" | "submitted" | "filled" | "canceled" | "rejected" | "released";
export type RiskReservation = {
  key: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  status: RiskReservationStatus;
  orderId: string | null;
  expiresAt: number | null;
  createdAt: string;
  updatedAt: string;
};

type ReservationCandidate = Pick<RiskReservation, "symbol" | "side" | "qty" | "price">;
type ReservationValidation<T> = { allowed: boolean; value: T };

export function createStore(filename = "data/app.db") {
  if (filename !== ":memory:") mkdirSync("data", { recursive: true });
  const db = new Database(filename, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS submissions (idempotency_key TEXT PRIMARY KEY, order_id TEXT, response TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, intent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run(`CREATE TABLE IF NOT EXISTS risk_reservations (
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
  )`);
  db.run("CREATE INDEX IF NOT EXISTS risk_reservations_active ON risk_reservations(status)");
  db.run(`CREATE TABLE IF NOT EXISTS account_activities (
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
  )`);
  const activityColumns = db.query("PRAGMA table_info(account_activities)").all() as { name: string }[];
  if (!activityColumns.some(column => column.name === "corporate_action")) db.run("ALTER TABLE account_activities ADD COLUMN corporate_action TEXT");
  db.run("CREATE INDEX IF NOT EXISTS account_activities_occurred ON account_activities(occurred_at DESC, activity_id DESC)");
  db.run("CREATE INDEX IF NOT EXISTS account_activities_category ON account_activities(category, occurred_at DESC)");
  db.run(`CREATE TABLE IF NOT EXISTS research_runs (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
    model TEXT NOT NULL,
    payload TEXT,
    metrics TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS research_runs_created ON research_runs(created_at DESC)");
  db.run("CREATE TABLE IF NOT EXISTS portfolio_snapshots (snapshot_date TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  const snapshotColumns = db.query("PRAGMA table_info(portfolio_snapshots)").all() as { name: string }[];
  if (snapshotColumns.some(column => column.name === "captured_at")) db.transaction(() => {
    db.run("ALTER TABLE portfolio_snapshots RENAME TO portfolio_snapshots_legacy");
    db.run("CREATE TABLE portfolio_snapshots (snapshot_date TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    db.run("INSERT INTO portfolio_snapshots (snapshot_date, payload) SELECT snapshot_date, payload FROM portfolio_snapshots_legacy");
    db.run("DROP TABLE portfolio_snapshots_legacy");
  }).immediate();

  const reservationRows = (now = Date.now()) => db.query(`SELECT reservation_key AS key, symbol, side, qty, price, status, order_id AS orderId,
    expires_at_ms AS expiresAt, created_at AS createdAt, updated_at AS updatedAt FROM risk_reservations
    WHERE status = 'submitted' OR (status = 'reserved' AND expires_at_ms > ?) ORDER BY created_at, reservation_key`).all(now) as RiskReservation[];

  const reserveRiskTransaction = db.transaction(<T>(key: string, candidate: ReservationCandidate, validate: (active: RiskReservation[]) => ReservationValidation<T>, ttlMs: number) => {
    const existing = db.query("SELECT reservation_key FROM risk_reservations WHERE reservation_key = ?").get(key);
    if (existing) return { reserved: false as const, reason: "exists" as const };
    if (!key || !candidate.symbol || !Number.isFinite(candidate.qty) || candidate.qty <= 0 || !Number.isFinite(candidate.price) || candidate.price <= 0) throw new Error("Invalid risk reservation");
    const now = Date.now();
    db.query("UPDATE risk_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE status = 'reserved' AND expires_at_ms <= ?").run(now);
    const validation = validate(reservationRows(now));
    if (!validation.allowed) return { reserved: false as const, reason: "risk" as const, validation: validation.value };
    db.query("INSERT INTO risk_reservations (reservation_key, symbol, side, qty, price, status, expires_at_ms) VALUES (?, ?, ?, ?, ?, 'reserved', ?)")
      .run(key, candidate.symbol, candidate.side, candidate.qty, candidate.price, now + ttlMs);
    return { reserved: true as const, validation: validation.value };
  });
  const reserveRiskBasketTransaction = db.transaction(<T>(key: string, candidates: ReservationCandidate[], validate: (active: RiskReservation[]) => ReservationValidation<T>, ttlMs: number) => {
    if (!key || candidates.length < 2 || candidates.length > 10 || candidates.some(candidate => !candidate.symbol || !Number.isFinite(candidate.qty) || candidate.qty <= 0 || !Number.isFinite(candidate.price) || candidate.price <= 0)) throw new Error("Invalid basket risk reservation");
    const keys = candidates.map((_, index) => `${key}:${index}`);
    const placeholders = keys.map(() => "?").join(",");
    if (db.query(`SELECT reservation_key FROM risk_reservations WHERE reservation_key IN (${placeholders}) LIMIT 1`).get(...keys)) return { reserved: false as const, reason: "exists" as const };
    const now = Date.now();
    db.query("UPDATE risk_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE status = 'reserved' AND expires_at_ms <= ?").run(now);
    const validation = validate(reservationRows(now));
    if (!validation.allowed) return { reserved: false as const, reason: "risk" as const, validation: validation.value };
    const insert = db.query("INSERT INTO risk_reservations (reservation_key, symbol, side, qty, price, status, expires_at_ms) VALUES (?, ?, ?, ?, ?, 'reserved', ?)");
    candidates.forEach((candidate, index) => insert.run(keys[index]!, candidate.symbol, candidate.side, candidate.qty, candidate.price, now + ttlMs));
    return { reserved: true as const, keys, validation: validation.value };
  });
  const syncActivitiesTransaction = db.transaction((activities: LedgerActivity[]) => {
    const statement = db.query(`INSERT INTO account_activities (activity_id, type, sub_type, category, status, occurred_at, symbol, side, quantity, price, amount, order_id, corporate_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET type=excluded.type, sub_type=excluded.sub_type, category=excluded.category, status=excluded.status,
      occurred_at=excluded.occurred_at, symbol=excluded.symbol, side=excluded.side, quantity=excluded.quantity, price=excluded.price,
      amount=excluded.amount, order_id=excluded.order_id, corporate_action=excluded.corporate_action, synced_at=CURRENT_TIMESTAMP`);
    for (const activity of activities) statement.run(activity.id, activity.type, activity.subType, activity.category, activity.status, activity.occurredAt, activity.symbol, activity.side, activity.quantity, activity.price, activity.amount, activity.orderId, activity.corporateAction ? JSON.stringify(activity.corporateAction) : null);
    return activities.length;
  });
  const activitySelect = `SELECT activity_id AS id, type, sub_type AS subType, category, status, occurred_at AS occurredAt,
    symbol, side, quantity, price, amount, order_id AS orderId, corporate_action AS corporateActionJson FROM account_activities`;
  return {
    event(type: string, actor: string, payload: unknown) {
      db.query("INSERT INTO events (type, actor, payload) VALUES (?, ?, ?)").run(type, actor, JSON.stringify(payload));
    },
    submission(key: string) {
      const row = db.query("SELECT response FROM submissions WHERE idempotency_key = ?").get(key) as { response: string } | null;
      return row ? JSON.parse(row.response) : null;
    },
    reserveSubmission(key: string) {
      return db.query("INSERT OR IGNORE INTO submissions (idempotency_key, response) VALUES (?, ?)").run(key, JSON.stringify({ pending: true })).changes === 1;
    },
    releaseSubmission(key: string) {
      db.query("DELETE FROM submissions WHERE idempotency_key = ? AND order_id IS NULL").run(key);
    },
    completeSubmission(key: string, orderId: string, response: unknown) {
      db.query("UPDATE submissions SET order_id = ?, response = ? WHERE idempotency_key = ?").run(orderId, JSON.stringify(response), key);
    },
    /** Atomically validates against every active local reservation and reserves capacity. */
    reserveRisk<T>(key: string, candidate: ReservationCandidate, validate: (active: RiskReservation[]) => ReservationValidation<T>, ttlMs = 120_000) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Risk reservation TTL must be positive");
      return reserveRiskTransaction.immediate(key, candidate, validate, ttlMs);
    },
    /** Atomically validates and reserves every leg of one application-level basket. */
    reserveRiskBasket<T>(key: string, candidates: ReservationCandidate[], validate: (active: RiskReservation[]) => ReservationValidation<T>, ttlMs = 120_000) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Risk reservation TTL must be positive");
      return reserveRiskBasketTransaction.immediate(key, candidates, validate, ttlMs);
    },
    activeRiskReservations() { return reservationRows(); },
    markRiskSubmitted(key: string, orderId: string) {
      return db.query("UPDATE risk_reservations SET status = 'submitted', order_id = ?, expires_at_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE reservation_key = ? AND status = 'reserved' AND expires_at_ms > ?").run(orderId, key, Date.now()).changes === 1;
    },
    finishRiskReservation(key: string, status: Exclude<RiskReservationStatus, "reserved" | "submitted">) {
      return db.query("UPDATE risk_reservations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE reservation_key = ? AND status IN ('reserved', 'submitted')").run(status, key).changes === 1;
    },
    receipt(id: string, payload: unknown) {
      db.query("INSERT INTO receipts (id, payload) VALUES (?, ?)").run(id, JSON.stringify(payload));
    },
    getReceipt(id: string) {
      const row = db.query("SELECT payload FROM receipts WHERE id = ?").get(id) as { payload: string } | null;
      return row ? JSON.parse(row.payload) : null;
    },
    receipts(limit = 20) {
      return (db.query("SELECT id, payload FROM receipts ORDER BY created_at DESC LIMIT ?").all(limit) as { id: string; payload: string }[])
        .map(row => ({ id: row.id, ...JSON.parse(row.payload) }));
    },
    reconcileOrder(orderId: string, status: string) {
      // ponytail: O(n) is fine for one paper account; add an indexed order_id column before multi-account use.
      const rows = db.query("SELECT id, payload FROM receipts").all() as { id: string; payload: string }[];
      for (const row of rows) {
        const receipt = JSON.parse(row.payload);
        if (receipt.orderId === orderId && receipt.status !== status) {
          receipt.status = status;
          receipt.updatedAt = new Date().toISOString();
          db.query("UPDATE receipts SET payload = ? WHERE id = ?").run(JSON.stringify(receipt), row.id);
        }
      }
    },
    plan(id: string, intent: string, payload: unknown) {
      db.query("INSERT INTO plans (id, intent, payload) VALUES (?, ?, ?)").run(id, intent, JSON.stringify(payload));
    },
    getPlan(id: string) {
      const row = db.query("SELECT intent, payload, created_at FROM plans WHERE id = ?").get(id) as { intent: string; payload: string; created_at: string } | null;
      return row ? { id, intent: row.intent, createdAt: row.created_at, ...JSON.parse(row.payload) } : null;
    },
    syncActivities(activities: LedgerActivity[]) { return syncActivitiesTransaction.immediate(activities); },
    activities(limit = 100, category?: LedgerCategory) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Activity limit is out of range");
      const rows = (category
        ? db.query(`${activitySelect} WHERE category = ? ORDER BY occurred_at DESC, activity_id DESC LIMIT ?`).all(category, limit)
        : db.query(`${activitySelect} ORDER BY occurred_at DESC, activity_id DESC LIMIT ?`).all(limit)) as (LedgerActivity & { corporateActionJson: string | null })[];
      return rows.map(({ corporateActionJson, ...activity }) => ({ ...activity, corporateAction: corporateActionJson ? JSON.parse(corporateActionJson) : null }));
    },
    startResearch(id: string, symbol: string, model: string) {
      db.query("INSERT INTO research_runs (id, symbol, status, model) VALUES (?, ?, 'running', ?)").run(id, symbol, model);
    },
    completeResearch(id: string, payload: unknown, metrics: unknown) {
      db.query("UPDATE research_runs SET status = 'completed', payload = ?, metrics = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'").run(JSON.stringify(payload), JSON.stringify(metrics), id);
    },
    failResearch(id: string, error: string) {
      db.query("UPDATE research_runs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'").run(error.slice(0, 500), id);
    },
    getResearch(id: string) {
      const row = db.query("SELECT id, symbol, status, model, payload, metrics, error, created_at AS createdAt, completed_at AS completedAt FROM research_runs WHERE id = ?").get(id) as any;
      return row ? { ...row, payload: row.payload ? JSON.parse(row.payload) : null, metrics: row.metrics ? JSON.parse(row.metrics) : null } : null;
    },
    researchMetrics(limit = 50) {
      const rows = db.query("SELECT metrics FROM research_runs WHERE status = 'completed' AND metrics IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(limit) as { metrics: string }[];
      const metrics = rows.map(row => JSON.parse(row.metrics));
      const average = (key: string) => metrics.length ? metrics.reduce((sum, item) => sum + Number(item[key] ?? 0), 0) / metrics.length : 0;
      return { totalRuns: metrics.length, successRate: metrics.length ? metrics.filter(item => item.overallScore >= 90).length / metrics.length : 0, averageScore: average("overallScore"), averageLatencyMs: average("latencyMs"), averageCitationValidity: average("citationValidity"), averageNumericGrounding: average("numericGrounding"), averageToolCoverage: average("toolCoverage"), averageTokens: average("totalTokens") };
    },
    portfolioSnapshot<T extends { snapshotDate: string }>(snapshot: T) {
      db.query("INSERT INTO portfolio_snapshots (snapshot_date, payload) VALUES (?, ?) ON CONFLICT(snapshot_date) DO UPDATE SET payload=excluded.payload")
        .run(snapshot.snapshotDate, JSON.stringify(snapshot));
    },
    portfolioSnapshots(limit = 90) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 366) throw new Error("Snapshot limit is out of range");
      return (db.query("SELECT payload FROM portfolio_snapshots ORDER BY snapshot_date DESC LIMIT ?").all(limit) as { payload: string }[]).map(row => JSON.parse(row.payload));
    },
    close() { db.close(); },
  };
}
