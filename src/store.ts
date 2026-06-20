import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

export function createStore(filename = "data/app.db") {
  if (filename !== ":memory:") mkdirSync("data", { recursive: true });
  const db = new Database(filename, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS submissions (idempotency_key TEXT PRIMARY KEY, order_id TEXT, response TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, intent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
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
