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
export type StrategyRunStatus = "backtest" | "shadow" | "paper" | "paused" | "completed" | "retired" | "failed";
export type StrategyDecisionKind = "hold" | "enter" | "increase" | "reduce" | "exit" | "pause" | "block";
export type StrategyRunInput = {
  id: string;
  strategyId: string;
  strategyVersion: string;
  status: StrategyRunStatus;
  configHash: string;
  policyVersion: string;
  symbols: string[];
  budget: number;
  config: unknown;
  notes?: string | null;
};
export type StrategyDataSnapshotInput = {
  id: string;
  runId: string;
  symbol: string;
  source: string;
  feed: string;
  observedAt: string;
  stale: boolean;
  latencyMs: number | null;
  payload: unknown;
};
export type StrategyDecisionInput = {
  id: string;
  traceId: string;
  runId: string;
  symbol: string;
  decision: StrategyDecisionKind;
  features: unknown;
  weights: unknown;
  thresholds: unknown;
  riskChecks: unknown;
  dataSnapshotIds: string[];
  rawSignal: number | null;
  riskAdjustedSignal: number | null;
  targetPosition: number | null;
  reason: string;
  draftOrder?: unknown;
  paperOrderId?: string | null;
};
export type StrategyOrderInput = {
  id: string;
  runId: string;
  decisionId: string;
  paperOrderId: string;
  status: string;
  payload: unknown;
};
export type StrategyMetricInput = {
  runId: string;
  name: string;
  value: number;
  unit: string;
  asOf: string;
};

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
  db.run(`CREATE TABLE IF NOT EXISTS strategy_runs (
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
  )`);
  db.run("CREATE INDEX IF NOT EXISTS strategy_runs_status ON strategy_runs(status, created_at DESC)");
  db.run(`CREATE TABLE IF NOT EXISTS strategy_data_snapshots (
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
  )`);
  db.run("CREATE INDEX IF NOT EXISTS strategy_data_snapshots_run ON strategy_data_snapshots(run_id, observed_at DESC)");
  db.run(`CREATE TABLE IF NOT EXISTS strategy_decisions (
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
  )`);
  db.run("CREATE INDEX IF NOT EXISTS strategy_decisions_run ON strategy_decisions(run_id, created_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS strategy_decisions_trace ON strategy_decisions(trace_id)");
  db.run(`CREATE TABLE IF NOT EXISTS strategy_orders (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
    decision_id TEXT NOT NULL REFERENCES strategy_decisions(id) ON DELETE CASCADE,
    paper_order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run("CREATE INDEX IF NOT EXISTS strategy_orders_run ON strategy_orders(run_id, created_at DESC)");
  db.run(`CREATE TABLE IF NOT EXISTS strategy_metrics (
    run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    as_of TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, name, as_of)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS strategy_notes (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
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
    createStrategyRun(input: StrategyRunInput) {
      if (!input.id || !input.strategyId || !input.strategyVersion || !input.configHash || !input.policyVersion || !input.symbols.length || input.symbols.some(symbol => !/^[A-Z0-9/.-]{2,20}$/.test(symbol)) || !Number.isFinite(input.budget) || input.budget < 0) throw new Error("Invalid strategy run");
      db.query(`INSERT INTO strategy_runs (id, strategy_id, strategy_version, status, config_hash, policy_version, symbols, budget, config, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.strategyId, input.strategyVersion, input.status, input.configHash, input.policyVersion, JSON.stringify(input.symbols), input.budget, JSON.stringify(input.config), input.notes ?? null);
    },
    updateStrategyRunStatus(id: string, status: StrategyRunStatus, notes?: string | null) {
      return db.query("UPDATE strategy_runs SET status = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, notes ?? null, id).changes === 1;
    },
    getStrategyRun(id: string) {
      const row = db.query("SELECT id, strategy_id AS strategyId, strategy_version AS strategyVersion, status, config_hash AS configHash, policy_version AS policyVersion, symbols, budget, config, notes, created_at AS createdAt, updated_at AS updatedAt FROM strategy_runs WHERE id = ?").get(id) as any;
      return row ? { ...row, symbols: JSON.parse(row.symbols), config: JSON.parse(row.config) } : null;
    },
    strategyRuns(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Strategy run limit is out of range");
      return (db.query("SELECT id, strategy_id AS strategyId, strategy_version AS strategyVersion, status, config_hash AS configHash, policy_version AS policyVersion, symbols, budget, config, notes, created_at AS createdAt, updated_at AS updatedAt FROM strategy_runs ORDER BY created_at DESC LIMIT ?").all(limit) as any[])
        .map(row => ({ ...row, symbols: JSON.parse(row.symbols), config: JSON.parse(row.config) }));
    },
    strategyDataSnapshot(input: StrategyDataSnapshotInput) {
      if (!input.id || !input.runId || !input.symbol || !input.source || !input.feed || !input.observedAt || (input.latencyMs !== null && (!Number.isFinite(input.latencyMs) || input.latencyMs < 0))) throw new Error("Invalid strategy data snapshot");
      db.query(`INSERT INTO strategy_data_snapshots (id, run_id, symbol, source, feed, observed_at, stale, latency_ms, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.runId, input.symbol, input.source, input.feed, input.observedAt, input.stale ? 1 : 0, input.latencyMs, JSON.stringify(input.payload));
    },
    strategyDecision(input: StrategyDecisionInput) {
      if (!input.id || !input.traceId || !input.runId || !input.symbol || !input.reason) throw new Error("Invalid strategy decision");
      db.query(`INSERT INTO strategy_decisions (id, trace_id, run_id, symbol, decision, features, weights, thresholds, risk_checks, data_snapshot_ids, raw_signal, risk_adjusted_signal, target_position, reason, draft_order, paper_order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.traceId, input.runId, input.symbol, input.decision, JSON.stringify(input.features), JSON.stringify(input.weights), JSON.stringify(input.thresholds), JSON.stringify(input.riskChecks), JSON.stringify(input.dataSnapshotIds), input.rawSignal, input.riskAdjustedSignal, input.targetPosition, input.reason, input.draftOrder === undefined ? null : JSON.stringify(input.draftOrder), input.paperOrderId ?? null);
    },
    strategyDecisions(runId: string, limit = 50) {
      if (!runId || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Strategy decision query is out of range");
      return (db.query(`SELECT id, trace_id AS traceId, run_id AS runId, symbol, decision, features, weights, thresholds, risk_checks AS riskChecks, data_snapshot_ids AS dataSnapshotIds,
        raw_signal AS rawSignal, risk_adjusted_signal AS riskAdjustedSignal, target_position AS targetPosition, reason, draft_order AS draftOrder, paper_order_id AS paperOrderId, created_at AS createdAt
        FROM strategy_decisions WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`).all(runId, limit) as any[])
        .map(row => ({ ...row, features: JSON.parse(row.features), weights: JSON.parse(row.weights), thresholds: JSON.parse(row.thresholds), riskChecks: JSON.parse(row.riskChecks), dataSnapshotIds: JSON.parse(row.dataSnapshotIds), draftOrder: row.draftOrder ? JSON.parse(row.draftOrder) : null }));
    },
    getStrategyDecisionTrace(traceId: string) {
      const row = db.query(`SELECT id, trace_id AS traceId, run_id AS runId, symbol, decision, features, weights, thresholds, risk_checks AS riskChecks, data_snapshot_ids AS dataSnapshotIds,
        raw_signal AS rawSignal, risk_adjusted_signal AS riskAdjustedSignal, target_position AS targetPosition, reason, draft_order AS draftOrder, paper_order_id AS paperOrderId, created_at AS createdAt
        FROM strategy_decisions WHERE trace_id = ?`).get(traceId) as any;
      if (!row) return null;
      const dataSnapshotIds = JSON.parse(row.dataSnapshotIds) as string[];
      const snapshots = dataSnapshotIds.length
        ? db.query(`SELECT id, run_id AS runId, symbol, source, feed, observed_at AS observedAt, stale, latency_ms AS latencyMs, payload, created_at AS createdAt
          FROM strategy_data_snapshots WHERE id IN (${dataSnapshotIds.map(() => "?").join(",")})`).all(...dataSnapshotIds) as any[]
        : [];
      return {
        ...row,
        features: JSON.parse(row.features),
        weights: JSON.parse(row.weights),
        thresholds: JSON.parse(row.thresholds),
        riskChecks: JSON.parse(row.riskChecks),
        dataSnapshotIds,
        draftOrder: row.draftOrder ? JSON.parse(row.draftOrder) : null,
        snapshots: snapshots.map(snapshot => ({ ...snapshot, stale: Boolean(snapshot.stale), payload: JSON.parse(snapshot.payload) })),
      };
    },
    strategyOrder(input: StrategyOrderInput) {
      if (!input.id || !input.runId || !input.decisionId || !input.paperOrderId || !input.status) throw new Error("Invalid strategy order");
      db.query(`INSERT INTO strategy_orders (id, run_id, decision_id, paper_order_id, status, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=CURRENT_TIMESTAMP`)
        .run(input.id, input.runId, input.decisionId, input.paperOrderId, input.status, JSON.stringify(input.payload));
    },
    strategyMetric(input: StrategyMetricInput) {
      if (!input.runId || !input.name || !Number.isFinite(input.value) || !input.unit || !input.asOf) throw new Error("Invalid strategy metric");
      db.query(`INSERT INTO strategy_metrics (run_id, name, value, unit, as_of) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, name, as_of) DO UPDATE SET value=excluded.value, unit=excluded.unit, created_at=CURRENT_TIMESTAMP`)
        .run(input.runId, input.name, input.value, input.unit, input.asOf);
    },
    strategyMetrics(runId: string) {
      return db.query("SELECT run_id AS runId, name, value, unit, as_of AS asOf, created_at AS createdAt FROM strategy_metrics WHERE run_id = ? ORDER BY as_of DESC, name").all(runId);
    },
    strategyNote(runId: string, actor: string, note: string) {
      if (!runId || !actor || !note.trim()) throw new Error("Invalid strategy note");
      db.query("INSERT INTO strategy_notes (run_id, actor, note) VALUES (?, ?, ?)").run(runId, actor, note.trim());
    },
    close() { db.close(); },
  };
}
