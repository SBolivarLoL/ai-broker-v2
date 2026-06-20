import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

export function createStore(filename = "data/app.db") {
  if (filename !== ":memory:") mkdirSync("data", { recursive: true });
  const db = new Database(filename, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS submissions (idempotency_key TEXT PRIMARY KEY, order_id TEXT, response TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
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
    completeSubmission(key: string, orderId: string, response: unknown) {
      db.query("UPDATE submissions SET order_id = ?, response = ? WHERE idempotency_key = ?").run(orderId, JSON.stringify(response), key);
    },
    receipt(id: string, payload: unknown) {
      db.query("INSERT INTO receipts (id, payload) VALUES (?, ?)").run(id, JSON.stringify(payload));
    },
    getReceipt(id: string) {
      const row = db.query("SELECT payload FROM receipts WHERE id = ?").get(id) as { payload: string } | null;
      return row ? JSON.parse(row.payload) : null;
    },
    close() { db.close(); },
  };
}
