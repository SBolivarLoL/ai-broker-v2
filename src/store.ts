import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

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
    close() { db.close(); },
  };
}
