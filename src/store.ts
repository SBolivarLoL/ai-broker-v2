import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { LedgerActivity, LedgerCategory } from "./ledger";
import { migrateDatabase, SCHEMA_MIGRATIONS } from "./migrations";
import { DEFAULT_OPERATIONS_POLICY, parseOperationsPolicy, type OperationsPolicy } from "./operations-policy";
import { EncryptedSecret, SecretName, secretMetadata } from "./secret-vault";
import { parseStrategyProvenance, type StrategyProvenance } from "./strategy-provenance";
import { TradeJournalEntry } from "./trade-journal";

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
type RiskReservationResult<T> = { reserved: true; validation: T } | { reserved: false; reason: "exists" } | { reserved: false; reason: "risk"; validation: T };
type RiskBasketReservationResult<T> = { reserved: true; keys: string[]; validation: T } | { reserved: false; reason: "exists" } | { reserved: false; reason: "risk"; validation: T };
export type StrategyRunStatus = "backtest" | "shadow" | "paper" | "paused" | "completed" | "retired" | "failed";
export type StrategyDecisionKind = "hold" | "enter" | "increase" | "reduce" | "exit" | "pause" | "block";
export type StrategyRunInput = {
  id: string;
  backtestId: string;
  strategyId: string;
  strategyVersion: string;
  status: StrategyRunStatus;
  configHash: string;
  policyVersion: string;
  symbols: string[];
  budget: number;
  config: unknown;
  provenance: StrategyProvenance;
  notes?: string | null;
};
export type StrategyBacktestInput = {
  id: string;
  actor: string;
  strategyId: string;
  definitionHash: string;
  provenance: StrategyProvenance;
  request: unknown;
  result: unknown;
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
  datasetHash: string;
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
  provenance: StrategyProvenance;
  draftOrder?: unknown;
  paperOrderId?: string | null;
};
export type StrategyDecisionFilter = {
  symbol?: string | null;
  decision?: StrategyDecisionKind | null;
  strategyId?: string | null;
  strategyVersion?: string | null;
  blockReason?: string | null;
  orderOutcome?: string | null;
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
export type StrategyAuditInput = {
  runId: string;
  kind: string;
  actor: string;
  subject: string;
  strategyId?: string | null;
  strategyVersion?: string | null;
  policyVersion?: string | null;
  configHash?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  retentionDays?: number;
  createdAt?: string;
};
export type StoredOperationsPolicy = OperationsPolicy & { updatedAt: string | null; updatedBy: string | null };
export type DecisionAuditInput = {
  subjectId: string;
  kind: string;
  actor: string;
  payload?: unknown;
  retentionDays?: number;
  createdAt?: string;
};

const strategyRunSelect = `SELECT id, backtest_id AS backtestId, strategy_id AS strategyId, strategy_version AS strategyVersion,
  status, config_hash AS configHash, policy_version AS policyVersion, symbols, budget, config, provenance, notes,
  created_at AS createdAt, updated_at AS updatedAt FROM strategy_runs`;

function mapStrategyRunRow(row: any) {
  if (!row) return null;
  const provenance = row.provenance ? JSON.parse(row.provenance) : null;
  return {
    ...row,
    symbols: JSON.parse(row.symbols),
    config: JSON.parse(row.config),
    provenance,
    comparable: Boolean(row.backtestId && provenance && !provenance.workingTreeDirty),
  };
}

function mapStrategyBacktestRow(row: any) {
  if (!row) return null;
  const provenance = JSON.parse(row.provenance);
  return {
    ...row,
    provenance,
    request: JSON.parse(row.request),
    result: JSON.parse(row.result),
    comparable: !provenance.workingTreeDirty,
  };
}

function mapStrategyDecisionRow(row: any) {
  const draftOrder = row.draftOrder ? JSON.parse(row.draftOrder) : null;
  const provenance = row.provenance ? JSON.parse(row.provenance) : null;
  const order = row.orderId ? {
    id: row.orderId,
    paperOrderId: row.orderPaperOrderId,
    status: row.orderStatus,
    payload: row.orderPayload ? JSON.parse(row.orderPayload) : null,
    createdAt: row.orderCreatedAt,
    updatedAt: row.orderUpdatedAt,
  } : null;
  return {
    ...row,
    features: JSON.parse(row.features),
    weights: JSON.parse(row.weights),
    thresholds: JSON.parse(row.thresholds),
    riskChecks: JSON.parse(row.riskChecks),
    dataSnapshotIds: JSON.parse(row.dataSnapshotIds),
    provenance,
    comparable: Boolean(provenance && !provenance.workingTreeDirty),
    draftOrder,
    order,
    orderOutcome: order?.status ?? (row.paperOrderId ? "linked" : draftOrder ? "drafted" : "none"),
  };
}

function decisionMatchesFilter(decision: ReturnType<typeof mapStrategyDecisionRow>, filter: StrategyDecisionFilter) {
  if (filter.orderOutcome && decision.orderOutcome !== filter.orderOutcome) return false;
  if (!filter.blockReason) return true;
  const needle = filter.blockReason.toLowerCase();
  const reasons: string[] = Array.isArray(decision.riskChecks?.reasons) ? decision.riskChecks.reasons.map((reason: unknown) => String(reason)) : [];
  return reasons.some(reason => reason.toLowerCase().includes(needle)) || String(decision.reason).toLowerCase().includes(needle);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function hashAuditEntry(entry: Record<string, unknown>) {
  return `sha256:${createHash("sha256").update(canonicalJson(entry)).digest("hex")}`;
}

function hashBytes(bytes: Buffer | Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function mapStrategyAuditRow(row: any) {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    actor: row.actor,
    subject: row.subject,
    strategyId: row.strategyId,
    strategyVersion: row.strategyVersion,
    policyVersion: row.policyVersion,
    configHash: row.configHash,
    before: row.beforePayload ? JSON.parse(row.beforePayload) : null,
    after: row.afterPayload ? JSON.parse(row.afterPayload) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    previousHash: row.previousHash,
    entryHash: row.entryHash,
    retentionUntil: row.retentionUntil,
    createdAt: row.createdAt,
  };
}

function mapDecisionAuditRow(row: any) {
  return {
    id: row.id,
    subjectId: row.subjectId,
    kind: row.kind,
    actor: row.actor,
    payload: row.payload ? JSON.parse(row.payload) : null,
    previousHash: row.previousHash,
    entryHash: row.entryHash,
    retentionUntil: row.retentionUntil,
    createdAt: row.createdAt,
  };
}

export function createStore(filename = "data/app.db") {
  if (filename !== ":memory:") mkdirSync("data", { recursive: true });
  const db = new Database(filename, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  try {
    migrateDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const reservationRows = (now = Date.now()) => db.query(`SELECT reservation_key AS key, symbol, side, qty, price, status, order_id AS orderId,
    expires_at_ms AS expiresAt, created_at AS createdAt, updated_at AS updatedAt FROM risk_reservations
    WHERE status = 'submitted' OR (status = 'reserved' AND expires_at_ms > ?) ORDER BY created_at, reservation_key`).all(now) as RiskReservation[];

  const reserveRiskTransaction = db.transaction(<T>(key: string, candidate: ReservationCandidate, validate: (active: RiskReservation[]) => ReservationValidation<T>, ttlMs: number) => {
    if (!key || !candidate.symbol || !Number.isFinite(candidate.qty) || candidate.qty <= 0 || !Number.isFinite(candidate.price) || candidate.price <= 0) throw new Error("Invalid risk reservation");
    const now = Date.now();
    db.query("UPDATE risk_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE status = 'reserved' AND expires_at_ms <= ?").run(now);
    const existing = db.query("SELECT reservation_key FROM risk_reservations WHERE reservation_key = ? AND status <> 'released'").get(key);
    if (existing) return { reserved: false as const, reason: "exists" as const };
    const validation = validate(reservationRows(now));
    if (!validation.allowed) return { reserved: false as const, reason: "risk" as const, validation: validation.value };
    db.query(`INSERT INTO risk_reservations (reservation_key, symbol, side, qty, price, status, expires_at_ms) VALUES (?, ?, ?, ?, ?, 'reserved', ?)
      ON CONFLICT(reservation_key) DO UPDATE SET symbol=excluded.symbol, side=excluded.side, qty=excluded.qty, price=excluded.price,
      status='reserved', order_id=NULL, expires_at_ms=excluded.expires_at_ms, updated_at=CURRENT_TIMESTAMP WHERE risk_reservations.status='released'`)
      .run(key, candidate.symbol, candidate.side, candidate.qty, candidate.price, now + ttlMs);
    return { reserved: true as const, validation: validation.value };
  });
  const reserveRiskBasketTransaction = db.transaction(<T>(key: string, candidates: ReservationCandidate[], validate: (active: RiskReservation[]) => ReservationValidation<T>, ttlMs: number) => {
    if (!key || candidates.length < 2 || candidates.length > 10 || candidates.some(candidate => !candidate.symbol || !Number.isFinite(candidate.qty) || candidate.qty <= 0 || !Number.isFinite(candidate.price) || candidate.price <= 0)) throw new Error("Invalid basket risk reservation");
    const keys = candidates.map((_, index) => `${key}:${index}`);
    const placeholders = keys.map(() => "?").join(",");
    const now = Date.now();
    db.query("UPDATE risk_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE status = 'reserved' AND expires_at_ms <= ?").run(now);
    if (db.query(`SELECT reservation_key FROM risk_reservations WHERE reservation_key IN (${placeholders}) AND status <> 'released' LIMIT 1`).get(...keys)) return { reserved: false as const, reason: "exists" as const };
    const validation = validate(reservationRows(now));
    if (!validation.allowed) return { reserved: false as const, reason: "risk" as const, validation: validation.value };
    const insert = db.query(`INSERT INTO risk_reservations (reservation_key, symbol, side, qty, price, status, expires_at_ms) VALUES (?, ?, ?, ?, ?, 'reserved', ?)
      ON CONFLICT(reservation_key) DO UPDATE SET symbol=excluded.symbol, side=excluded.side, qty=excluded.qty, price=excluded.price,
      status='reserved', order_id=NULL, expires_at_ms=excluded.expires_at_ms, updated_at=CURRENT_TIMESTAMP WHERE risk_reservations.status='released'`);
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
  const strategyAuditSelect = `SELECT id, run_id AS runId, kind, actor, subject, strategy_id AS strategyId, strategy_version AS strategyVersion,
    policy_version AS policyVersion, config_hash AS configHash, before_payload AS beforePayload, after_payload AS afterPayload,
    metadata, previous_hash AS previousHash, entry_hash AS entryHash, retention_until AS retentionUntil, created_at AS createdAt FROM strategy_audit_log`;
  const decisionAuditSelect = `SELECT id, subject_id AS subjectId, kind, actor, payload, previous_hash AS previousHash,
    entry_hash AS entryHash, retention_until AS retentionUntil, created_at AS createdAt FROM decision_audit_log`;
  const mapEventRow = (row: any) => ({ id: row.id, type: row.type, actor: row.actor, payload: JSON.parse(row.payload), createdAt: row.createdAt });
  const encryptedSecretRow = (row: any) => ({
    name: row.name,
    envelope: EncryptedSecret.parse(JSON.parse(row.envelope)),
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const operationsPolicy = (): StoredOperationsPolicy => {
    const row = db.query("SELECT payload, updated_by AS updatedBy, updated_at AS updatedAt FROM operations_policy WHERE id = 'global'").get() as { payload: string; updatedBy: string | null; updatedAt: string } | null;
    const policy = parseOperationsPolicy(row ? JSON.parse(row.payload) : DEFAULT_OPERATIONS_POLICY);
    return { ...policy, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
  };
  const decisionAudit = (input: DecisionAuditInput) => {
    if (!input.subjectId || !input.kind || !input.actor) throw new Error("Invalid decision audit entry");
    const createdAt = input.createdAt ?? new Date().toISOString();
    const createdDate = new Date(createdAt);
    if (!Number.isFinite(createdDate.getTime())) throw new Error("Invalid decision audit timestamp");
    const retentionDays = Number.isFinite(input.retentionDays) && input.retentionDays! > 0 ? input.retentionDays! : 365 * 7;
    const retentionUntil = new Date(createdDate.getTime() + retentionDays * 86_400_000).toISOString();
    const previous = db.query("SELECT entry_hash AS entryHash FROM decision_audit_log ORDER BY id DESC LIMIT 1").get() as { entryHash: string } | null;
    const payload = input.payload ?? {};
    const hashInput = {
      schemaVersion: "decision-audit-v1",
      subjectId: input.subjectId,
      kind: input.kind,
      actor: input.actor,
      payload,
      previousHash: previous?.entryHash ?? null,
      retentionUntil,
      createdAt,
    };
    const entryHash = hashAuditEntry(hashInput);
    db.query(`INSERT INTO decision_audit_log (subject_id, kind, actor, payload, previous_hash, entry_hash, retention_until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.subjectId, input.kind, input.actor, JSON.stringify(payload), previous?.entryHash ?? null, entryHash, retentionUntil, createdAt);
    return mapDecisionAuditRow(db.query(`${decisionAuditSelect} WHERE entry_hash = ?`).get(entryHash));
  };
  return {
    event(type: string, actor: string, payload: unknown) {
      db.query("INSERT INTO events (type, actor, payload) VALUES (?, ?, ?)").run(type, actor, JSON.stringify(payload));
    },
    events(limit = 100, type?: string) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Event limit is out of range");
      const rows = type
        ? db.query("SELECT id, type, actor, payload, created_at AS createdAt FROM events WHERE type = ? ORDER BY id DESC LIMIT ?").all(type, limit)
        : db.query("SELECT id, type, actor, payload, created_at AS createdAt FROM events ORDER BY id DESC LIMIT ?").all(limit);
      return (rows as any[]).map(mapEventRow);
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
    reserveRisk<T>(key: string, candidate: ReservationCandidate, validate: (active: RiskReservation[]) => ReservationValidation<T>, ttlMs = 120_000): RiskReservationResult<T> {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Risk reservation TTL must be positive");
      return reserveRiskTransaction.immediate(key, candidate, validate, ttlMs) as RiskReservationResult<T>;
    },
    /** Atomically validates and reserves every leg of one application-level basket. */
    reserveRiskBasket<T>(key: string, candidates: ReservationCandidate[], validate: (active: RiskReservation[]) => ReservationValidation<T>, ttlMs = 120_000): RiskBasketReservationResult<T> {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Risk reservation TTL must be positive");
      return reserveRiskBasketTransaction.immediate(key, candidates, validate, ttlMs) as RiskBasketReservationResult<T>;
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
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      decisionAudit({ subjectId: id, kind: `receipt.${String(record.kind ?? "decision")}`, actor: String(record.advisor ?? "system"), payload });
    },
    operationsPolicy,
    updateOperationsPolicy(actor: string, patch: unknown) {
      if (!actor) throw new Error("Operations policy actor is required");
      const current = operationsPolicy();
      const { updatedAt: _updatedAt, updatedBy: _updatedBy, ...currentPolicy } = current;
      const next = parseOperationsPolicy({ ...currentPolicy, ...(patch && typeof patch === "object" ? patch : {}) });
      db.query(`INSERT INTO operations_policy (id, payload, updated_by, updated_at) VALUES ('global', ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
        .run(JSON.stringify(next), actor);
      return operationsPolicy();
    },
    upsertEncryptedSecret(name: string, envelope: EncryptedSecret, actor: string) {
      const parsedName = SecretName.parse(name);
      const parsedEnvelope = EncryptedSecret.parse(envelope);
      if (!actor) throw new Error("Encrypted secret actor is required");
      db.query(`INSERT INTO encrypted_secrets (name, envelope, updated_by) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET envelope=excluded.envelope, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
        .run(parsedName, JSON.stringify(parsedEnvelope), actor);
      const row = encryptedSecretRow(db.query("SELECT name, envelope, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM encrypted_secrets WHERE name = ?").get(parsedName));
      return secretMetadata(row.name, row.envelope, row.updatedBy, row.updatedAt);
    },
    encryptedSecret(name: string) {
      const row = db.query("SELECT name, envelope, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM encrypted_secrets WHERE name = ?").get(SecretName.parse(name)) as any;
      return row ? encryptedSecretRow(row) : null;
    },
    encryptedSecretMetadata(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Encrypted secret limit is out of range");
      return (db.query("SELECT name, envelope, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM encrypted_secrets ORDER BY name LIMIT ?").all(limit) as any[])
        .map(encryptedSecretRow)
        .map(row => secretMetadata(row.name, row.envelope, row.updatedBy, row.updatedAt));
    },
    deleteEncryptedSecret(name: string) {
      return db.query("DELETE FROM encrypted_secrets WHERE name = ?").run(SecretName.parse(name)).changes === 1;
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
    plan(id: string, intent: string, payload: unknown, actor = "agent") {
      db.query("INSERT INTO plans (id, intent, payload) VALUES (?, ?, ?)").run(id, intent, JSON.stringify(payload));
      decisionAudit({ subjectId: id, kind: "agent.plan", actor, payload: { intent, ...(payload && typeof payload === "object" ? payload as Record<string, unknown> : { payload }) } });
    },
    getPlan(id: string) {
      const row = db.query("SELECT intent, payload, created_at FROM plans WHERE id = ?").get(id) as { intent: string; payload: string; created_at: string } | null;
      return row ? { id, intent: row.intent, createdAt: row.created_at, ...JSON.parse(row.payload) } : null;
    },
    addTradeJournalEntry(value: TradeJournalEntry, actor: string) {
      const entry = TradeJournalEntry.parse(value);
      if (!actor) throw new Error("Trade journal actor is required");
      db.query("INSERT INTO trade_journal_entries (id, receipt_id, payload, updated_at) VALUES (?, ?, ?, ?)").run(entry.id, entry.receiptId, JSON.stringify(entry), entry.updatedAt);
      decisionAudit({ subjectId: entry.id, kind: "trade_journal.created", actor, payload: entry });
      return entry;
    },
    getTradeJournalEntry(id: string) {
      const row = db.query("SELECT payload FROM trade_journal_entries WHERE id = ?").get(id) as { payload: string } | null;
      return row ? TradeJournalEntry.parse(JSON.parse(row.payload)) : null;
    },
    tradeJournalEntryForReceipt(receiptId: string) {
      const row = db.query("SELECT payload FROM trade_journal_entries WHERE receipt_id = ?").get(receiptId) as { payload: string } | null;
      return row ? TradeJournalEntry.parse(JSON.parse(row.payload)) : null;
    },
    tradeJournalEntries(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Trade journal limit is out of range");
      return (db.query("SELECT payload FROM trade_journal_entries ORDER BY updated_at DESC LIMIT ?").all(limit) as { payload: string }[])
        .map(row => TradeJournalEntry.parse(JSON.parse(row.payload)));
    },
    updateTradeJournalEntry(value: TradeJournalEntry, actor: string) {
      const entry = TradeJournalEntry.parse(value);
      const review = entry.reviews.at(-1);
      if (!actor || !review) throw new Error("Trade journal review is required");
      const changed = db.query("UPDATE trade_journal_entries SET payload = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(entry), entry.updatedAt, entry.id).changes;
      if (changed !== 1) throw new Error("Trade journal entry not found");
      decisionAudit({ subjectId: entry.id, kind: "trade_journal.reviewed", actor, payload: review });
      return entry;
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
    strategyBacktest(input: StrategyBacktestInput) {
      const provenance = parseStrategyProvenance(input.provenance);
      if (!input.id || !input.actor || !input.strategyId || input.definitionHash !== provenance.definitionHash) throw new Error("Invalid strategy backtest");
      db.query(`INSERT INTO strategy_backtests (id, actor, strategy_id, definition_hash, provenance, request, result)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.actor, input.strategyId, input.definitionHash, JSON.stringify(provenance), JSON.stringify(input.request), JSON.stringify(input.result));
      return mapStrategyBacktestRow(db.query(`SELECT id, actor, strategy_id AS strategyId, definition_hash AS definitionHash,
        provenance, request, result, created_at AS createdAt FROM strategy_backtests WHERE id = ?`).get(input.id));
    },
    getStrategyBacktest(id: string) {
      return mapStrategyBacktestRow(db.query(`SELECT id, actor, strategy_id AS strategyId, definition_hash AS definitionHash,
        provenance, request, result, created_at AS createdAt FROM strategy_backtests WHERE id = ?`).get(id));
    },
    createStrategyRun(input: StrategyRunInput) {
      const provenance = parseStrategyProvenance(input.provenance);
      const backtest = this.getStrategyBacktest(input.backtestId);
      if (!input.id || !input.backtestId || !input.strategyId || !input.strategyVersion || !input.configHash || !input.policyVersion || !input.symbols.length || input.symbols.some(symbol => !/^[A-Z0-9/.-]{2,20}$/.test(symbol)) || !Number.isFinite(input.budget) || input.budget < 0) throw new Error("Invalid strategy run");
      if (!backtest?.comparable || provenance.workingTreeDirty || backtest.strategyId !== input.strategyId || backtest.definitionHash !== provenance.definitionHash || backtest.provenance.gitCommit !== provenance.gitCommit || backtest.provenance.featureSchemaVersion !== provenance.featureSchemaVersion || backtest.provenance.datasetHash !== provenance.datasetHash || provenance.pluginVersion !== input.strategyVersion || provenance.policyVersion !== input.policyVersion) throw new Error("Strategy run does not match its reviewed backtest");
      db.query(`INSERT INTO strategy_runs (id, backtest_id, strategy_id, strategy_version, status, config_hash, policy_version, symbols, budget, config, provenance, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.backtestId, input.strategyId, input.strategyVersion, input.status, input.configHash, input.policyVersion, JSON.stringify(input.symbols), input.budget, JSON.stringify(input.config), JSON.stringify(provenance), input.notes ?? null);
    },
    updateStrategyRunStatus(id: string, status: StrategyRunStatus, notes?: string | null) {
      return db.query("UPDATE strategy_runs SET status = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, notes ?? null, id).changes === 1;
    },
    updateStrategyRunConfig(id: string, config: unknown, configHash?: string | null) {
      return db.query("UPDATE strategy_runs SET config = ?, config_hash = COALESCE(?, config_hash), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify(config), configHash ?? null, id).changes === 1;
    },
    approveStrategyRunPaper(id: string, budget: number, config: unknown, configHash?: string | null) {
      if (!Number.isFinite(budget) || budget <= 0) throw new Error("Invalid paper strategy budget");
      return db.query("UPDATE strategy_runs SET status = 'paper', budget = ?, config = ?, config_hash = COALESCE(?, config_hash), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('shadow', 'paused')").run(budget, JSON.stringify(config), configHash ?? null, id).changes === 1;
    },
    getStrategyRun(id: string) {
      return mapStrategyRunRow(db.query(`${strategyRunSelect} WHERE id = ?`).get(id));
    },
    strategyRuns(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Strategy run limit is out of range");
      return (db.query(`${strategyRunSelect} ORDER BY created_at DESC LIMIT ?`).all(limit) as any[]).map(mapStrategyRunRow);
    },
    strategyDataSnapshot(input: StrategyDataSnapshotInput) {
      if (!input.id || !input.runId || !input.symbol || !input.source || !input.feed || !input.observedAt || !/^sha256:[a-f0-9]{64}$/.test(input.datasetHash) || (input.latencyMs !== null && (!Number.isFinite(input.latencyMs) || input.latencyMs < 0))) throw new Error("Invalid strategy data snapshot");
      db.query(`INSERT INTO strategy_data_snapshots (id, run_id, symbol, source, feed, observed_at, stale, latency_ms, dataset_hash, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.runId, input.symbol, input.source, input.feed, input.observedAt, input.stale ? 1 : 0, input.latencyMs, input.datasetHash, JSON.stringify(input.payload));
    },
    strategyDecision(input: StrategyDecisionInput) {
      const provenance = parseStrategyProvenance(input.provenance);
      const run = db.query("SELECT strategy_version AS strategyVersion, policy_version AS policyVersion FROM strategy_runs WHERE id = ?").get(input.runId) as { strategyVersion: string; policyVersion: string } | null;
      if (!input.id || !input.traceId || !input.runId || !input.symbol || !input.reason || !run || provenance.pluginVersion !== run.strategyVersion || provenance.policyVersion !== run.policyVersion) throw new Error("Invalid strategy decision");
      db.query(`INSERT INTO strategy_decisions (id, trace_id, run_id, symbol, decision, features, weights, thresholds, risk_checks, data_snapshot_ids, raw_signal, risk_adjusted_signal, target_position, reason, provenance, draft_order, paper_order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.traceId, input.runId, input.symbol, input.decision, JSON.stringify(input.features), JSON.stringify(input.weights), JSON.stringify(input.thresholds), JSON.stringify(input.riskChecks), JSON.stringify(input.dataSnapshotIds), input.rawSignal, input.riskAdjustedSignal, input.targetPosition, input.reason, JSON.stringify(provenance), input.draftOrder === undefined ? null : JSON.stringify(input.draftOrder), input.paperOrderId ?? null);
    },
    strategyDecisions(runId: string, limit = 50, filter: StrategyDecisionFilter = {}) {
      if (!runId || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Strategy decision query is out of range");
      const clauses = ["sd.run_id = ?"], params: (string | number | null)[] = [runId];
      if (filter.symbol) { clauses.push("sd.symbol = ?"); params.push(filter.symbol); }
      if (filter.decision) { clauses.push("sd.decision = ?"); params.push(filter.decision); }
      if (filter.strategyId) { clauses.push("sr.strategy_id = ?"); params.push(filter.strategyId); }
      if (filter.strategyVersion) { clauses.push("sr.strategy_version = ?"); params.push(filter.strategyVersion); }
      const rawLimit = filter.blockReason || filter.orderOutcome ? 500 : limit;
      const rows = db.query(`SELECT sd.id, sd.trace_id AS traceId, sd.run_id AS runId, sd.symbol, sd.decision, sd.features, sd.weights, sd.thresholds, sd.risk_checks AS riskChecks, sd.data_snapshot_ids AS dataSnapshotIds, sd.provenance,
        sd.raw_signal AS rawSignal, sd.risk_adjusted_signal AS riskAdjustedSignal, sd.target_position AS targetPosition, sd.reason, sd.draft_order AS draftOrder, sd.paper_order_id AS paperOrderId, sd.created_at AS createdAt,
        sr.strategy_id AS strategyId, sr.strategy_version AS strategyVersion,
        so.id AS orderId, so.paper_order_id AS orderPaperOrderId, so.status AS orderStatus, so.payload AS orderPayload, so.created_at AS orderCreatedAt, so.updated_at AS orderUpdatedAt
        FROM strategy_decisions sd
        JOIN strategy_runs sr ON sr.id = sd.run_id
        LEFT JOIN strategy_orders so ON so.decision_id = sd.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY sd.created_at DESC LIMIT ?`).all(...params, rawLimit) as any[];
      return rows.map(mapStrategyDecisionRow).filter(decision => decisionMatchesFilter(decision, filter)).slice(0, limit);
    },
    getStrategyDecisionTrace(traceId: string) {
      const row = db.query(`SELECT sd.id, sd.trace_id AS traceId, sd.run_id AS runId, sd.symbol, sd.decision, sd.features, sd.weights, sd.thresholds, sd.risk_checks AS riskChecks, sd.data_snapshot_ids AS dataSnapshotIds, sd.provenance,
        sd.raw_signal AS rawSignal, sd.risk_adjusted_signal AS riskAdjustedSignal, sd.target_position AS targetPosition, sd.reason, sd.draft_order AS draftOrder, sd.paper_order_id AS paperOrderId, sd.created_at AS createdAt,
        sr.strategy_id AS strategyId, sr.strategy_version AS strategyVersion,
        so.id AS orderId, so.paper_order_id AS orderPaperOrderId, so.status AS orderStatus, so.payload AS orderPayload, so.created_at AS orderCreatedAt, so.updated_at AS orderUpdatedAt
        FROM strategy_decisions sd
        JOIN strategy_runs sr ON sr.id = sd.run_id
        LEFT JOIN strategy_orders so ON so.decision_id = sd.id
        WHERE sd.trace_id = ?`).get(traceId) as any;
      if (!row) return null;
      const decision = mapStrategyDecisionRow(row);
      const dataSnapshotIds = decision.dataSnapshotIds as string[];
      const snapshots = dataSnapshotIds.length
        ? db.query(`SELECT id, run_id AS runId, symbol, source, feed, observed_at AS observedAt, stale, latency_ms AS latencyMs, dataset_hash AS datasetHash, payload, created_at AS createdAt
          FROM strategy_data_snapshots WHERE id IN (${dataSnapshotIds.map(() => "?").join(",")})`).all(...dataSnapshotIds) as any[]
        : [];
      return {
        ...decision,
        dataSnapshotIds,
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
    reconcileStrategyOrder(paperOrderId: string, status: string, payloadPatch: Record<string, unknown>) {
      if (!paperOrderId || !status) throw new Error("Invalid strategy order reconciliation");
      const row = db.query("SELECT payload FROM strategy_orders WHERE paper_order_id = ?").get(paperOrderId) as { payload: string } | null;
      if (!row) return false;
      const payload = { ...JSON.parse(row.payload), ...payloadPatch };
      return db.query("UPDATE strategy_orders SET status = ?, payload = ?, updated_at = CURRENT_TIMESTAMP WHERE paper_order_id = ?").run(status, JSON.stringify(payload), paperOrderId).changes > 0;
    },
    strategyOrders(runId: string) {
      if (!runId) throw new Error("Strategy run id is required");
      return (db.query("SELECT id, run_id AS runId, decision_id AS decisionId, paper_order_id AS paperOrderId, status, payload, created_at AS createdAt, updated_at AS updatedAt FROM strategy_orders WHERE run_id = ? ORDER BY created_at DESC").all(runId) as any[])
        .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
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
    allStrategyMetrics(limit = 500) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Strategy metric limit is out of range");
      return db.query("SELECT run_id AS runId, name, value, unit, as_of AS asOf, created_at AS createdAt FROM strategy_metrics ORDER BY as_of DESC, created_at DESC, name LIMIT ?").all(limit);
    },
    strategyNote(runId: string, actor: string, note: string) {
      if (!runId || !actor || !note.trim()) throw new Error("Invalid strategy note");
      db.query("INSERT INTO strategy_notes (run_id, actor, note) VALUES (?, ?, ?)").run(runId, actor, note.trim());
    },
    strategyNotes(runId: string) {
      if (!runId) throw new Error("Strategy run id is required");
      return db.query("SELECT actor, note, created_at AS createdAt FROM strategy_notes WHERE run_id = ? ORDER BY created_at DESC, id DESC").all(runId);
    },
    strategyAudit(input: StrategyAuditInput) {
      if (!input.runId || !input.kind || !input.actor || !input.subject) throw new Error("Invalid strategy audit entry");
      const createdAt = input.createdAt ?? new Date().toISOString();
      const createdDate = new Date(createdAt);
      if (!Number.isFinite(createdDate.getTime())) throw new Error("Invalid strategy audit timestamp");
      const retentionDays = Number.isFinite(input.retentionDays) && input.retentionDays! > 0 ? input.retentionDays! : 365 * 7;
      const retentionUntil = new Date(createdDate.getTime() + retentionDays * 86_400_000).toISOString();
      const previous = db.query("SELECT entry_hash AS entryHash FROM strategy_audit_log WHERE run_id = ? ORDER BY id DESC LIMIT 1").get(input.runId) as { entryHash: string } | null;
      const beforePayload = input.before === undefined ? null : JSON.stringify(input.before);
      const afterPayload = input.after === undefined ? null : JSON.stringify(input.after);
      const metadata = input.metadata ?? {};
      const metadataPayload = JSON.stringify(metadata);
      const hashInput = {
        schemaVersion: "strategy-audit-v1",
        runId: input.runId,
        kind: input.kind,
        actor: input.actor,
        subject: input.subject,
        strategyId: input.strategyId ?? null,
        strategyVersion: input.strategyVersion ?? null,
        policyVersion: input.policyVersion ?? null,
        configHash: input.configHash ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        metadata,
        previousHash: previous?.entryHash ?? null,
        retentionUntil,
        createdAt,
      };
      const entryHash = hashAuditEntry(hashInput);
      db.query(`INSERT INTO strategy_audit_log (run_id, kind, actor, subject, strategy_id, strategy_version, policy_version, config_hash, before_payload, after_payload, metadata, previous_hash, entry_hash, retention_until, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.runId, input.kind, input.actor, input.subject, input.strategyId ?? null, input.strategyVersion ?? null, input.policyVersion ?? null, input.configHash ?? null, beforePayload, afterPayload, metadataPayload, previous?.entryHash ?? null, entryHash, retentionUntil, createdAt);
      const row = db.query(`${strategyAuditSelect} WHERE entry_hash = ?`).get(entryHash) as any;
      return mapStrategyAuditRow(row);
    },
    strategyAuditTrail(runId: string) {
      if (!runId) throw new Error("Strategy run id is required");
      return (db.query(`${strategyAuditSelect} WHERE run_id = ? ORDER BY id`).all(runId) as any[]).map(mapStrategyAuditRow);
    },
    verifyStrategyAuditTrail(runId: string) {
      if (!runId) throw new Error("Strategy run id is required");
      const entries = (db.query(`${strategyAuditSelect} WHERE run_id = ? ORDER BY id`).all(runId) as any[]).map(mapStrategyAuditRow);
      let previousHash: string | null = null;
      const invalid = entries.find(entry => {
        const hash = hashAuditEntry({
          schemaVersion: "strategy-audit-v1",
          runId: entry.runId,
          kind: entry.kind,
          actor: entry.actor,
          subject: entry.subject,
          strategyId: entry.strategyId ?? null,
          strategyVersion: entry.strategyVersion ?? null,
          policyVersion: entry.policyVersion ?? null,
          configHash: entry.configHash ?? null,
          before: entry.before ?? null,
          after: entry.after ?? null,
          metadata: entry.metadata ?? {},
          previousHash,
          retentionUntil: entry.retentionUntil,
          createdAt: entry.createdAt,
        });
        const broken = entry.previousHash !== previousHash || entry.entryHash !== hash;
        previousHash = entry.entryHash;
        return broken;
      });
      return { valid: !invalid, entries: entries.length, invalidEntryId: invalid?.id ?? null };
    },
    decisionAudit,
    decisionAuditTrail(subjectId?: string, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Decision audit limit is out of range");
      const rows = subjectId
        ? db.query(`${decisionAuditSelect} WHERE subject_id = ? ORDER BY id LIMIT ?`).all(subjectId, limit)
        : db.query(`${decisionAuditSelect} ORDER BY id DESC LIMIT ?`).all(limit);
      return (rows as any[]).map(mapDecisionAuditRow);
    },
    verifyDecisionAuditTrail() {
      const entries = (db.query(`${decisionAuditSelect} ORDER BY id`).all() as any[]).map(mapDecisionAuditRow);
      let previousHash: string | null = null;
      const invalid = entries.find(entry => {
        const hash = hashAuditEntry({
          schemaVersion: "decision-audit-v1",
          subjectId: entry.subjectId,
          kind: entry.kind,
          actor: entry.actor,
          payload: entry.payload ?? {},
          previousHash,
          retentionUntil: entry.retentionUntil,
          createdAt: entry.createdAt,
        });
        const broken = entry.previousHash !== previousHash || entry.entryHash !== hash;
        previousHash = entry.entryHash;
        return broken;
      });
      return { valid: !invalid, entries: entries.length, invalidEntryId: invalid?.id ?? null };
    },
    schemaMigrations() {
      const rows = db.query("SELECT id, name, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY id").all() as any[];
      return rows.map(row => ({ ...row, expected: SCHEMA_MIGRATIONS.some(migration => migration.id === row.id && migration.name === row.name && migration.checksum === row.checksum) }));
    },
    databaseBackup() {
      const bytes = db.serialize();
      return { bytes, metadata: { sizeBytes: bytes.byteLength, sha256: hashBytes(bytes), createdAt: new Date().toISOString(), migrations: SCHEMA_MIGRATIONS.length } };
    },
    observabilityExport(limit = 500) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Observability export limit is out of range");
      const spans = this.events(limit, "otel.span").map(event => event.payload);
      const recentEvents = this.events(Math.min(limit, 1_000));
      return {
        generatedAt: new Date().toISOString(),
        migrations: this.schemaMigrations(),
        operationsPolicy: operationsPolicy(),
        decisionAuditVerification: this.verifyDecisionAuditTrail(),
        spans,
        strategyMetrics: this.allStrategyMetrics(limit),
        recentEvents,
      };
    },
    incidentPacket(limit = 200) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Incident packet limit is out of range");
      const patterns = [/error/i, /failed/i, /rejected/i, /kill_switch/i, /blocked/i, /incident/i, /stale/i];
      const recentEvents = this.events(Math.min(limit * 2, 1_000)).filter(event => patterns.some(pattern => pattern.test(event.type))).slice(0, limit);
      return {
        generatedAt: new Date().toISOString(),
        severity: recentEvents.some(event => /error|failed|rejected|kill_switch/i.test(event.type)) ? "review" : "normal",
        runbook: [
          "Freeze new order flow with the global operations kill switch if broker state, data quality or audit integrity is uncertain.",
          "Download a database backup before changing policy, code or broker state.",
          "Export observability evidence and review recent errors, rejected orders, stale data and audit verification.",
          "Reconcile open broker orders and strategy paper orders before clearing the incident.",
          "Record the resolution reason in the operations policy or affected strategy review.",
        ],
        migrations: this.schemaMigrations(),
        operationsPolicy: operationsPolicy(),
        decisionAuditVerification: this.verifyDecisionAuditTrail(),
        recentEvents,
      };
    },
    close() { db.close(); },
  };
}
