/**
 * SQLite-backed application store.
 *
 * Transactions in this module protect idempotency and risk capacity; audit
 * records are hash-chained so later verification can detect mutation.
 */
import { Database } from "bun:sqlite";
import { hashAuditEntry, hashBytes } from "./audit";
import { mkdirSync } from "node:fs";
import type {
  LedgerActivity,
  LedgerCategory,
} from "../features/portfolio/ledger";
import { migrateDatabase, SCHEMA_MIGRATIONS } from "./migrations";
import {
  DEFAULT_OPERATIONS_POLICY,
  parseOperationsPolicy,
  type OperationsPolicy,
} from "../shared/operations-policy";
import {
  EncryptedSecret,
  SecretName,
  secretMetadata,
} from "../features/operations/secret-vault";
import {
  parseStrategyProvenance,
  type StrategyProvenance,
} from "../features/strategies/strategy-provenance";
import { TradeJournalEntry } from "../features/portfolio/trade-journal";
import { createStrategyStore } from "./strategy-store";
export type { SchemaMigration } from "./migrations";
export type {
  StrategyAuditInput,
  StrategyBarDatasetInput,
  StrategyBacktestInput,
  StrategyDataSnapshotInput,
  StrategyDecisionFilter,
  StrategyDecisionInput,
  StrategyDecisionKind,
  StrategyMetricInput,
  StrategyOrderInput,
  StrategyRunInput,
  StrategyRunStatus,
} from "./strategy-store";

export type RiskReservationStatus =
  "reserved" | "submitted" | "filled" | "canceled" | "rejected" | "released";
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

type ReservationCandidate = Pick<
  RiskReservation,
  "symbol" | "side" | "qty" | "price"
>;
type ReservationValidation<T> = { allowed: boolean; value: T };
type RiskReservationResult<T> =
  | { reserved: true; validation: T }
  | { reserved: false; reason: "exists" }
  | { reserved: false; reason: "risk"; validation: T };
type RiskBasketReservationResult<T> =
  | { reserved: true; keys: string[]; validation: T }
  | { reserved: false; reason: "exists" }
  | { reserved: false; reason: "risk"; validation: T };
export type StoredOperationsPolicy = OperationsPolicy & {
  updatedAt: string | null;
  updatedBy: string | null;
};
export type DecisionAuditInput = {
  subjectId: string;
  kind: string;
  actor: string;
  payload?: unknown;
  retentionDays?: number;
  createdAt?: string;
};

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
  // WAL allows readers to continue while a short reservation/audit write runs.
  db.run("PRAGMA journal_mode = WAL");
  try {
    migrateDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const strategyStore = createStrategyStore(db);

  const reservationRows = (now = Date.now()) =>
    db
      .query(
        `SELECT reservation_key AS key, symbol, side, qty, price, status, order_id AS orderId,
    expires_at_ms AS expiresAt, created_at AS createdAt, updated_at AS updatedAt FROM risk_reservations
    WHERE status = 'submitted' OR (status = 'reserved' AND expires_at_ms > ?) ORDER BY created_at, reservation_key`,
      )
      .all(now) as RiskReservation[];

  const reserveRiskTransaction = db.transaction(
    <T>(
      key: string,
      candidate: ReservationCandidate,
      validate: (active: RiskReservation[]) => ReservationValidation<T>,
      ttlMs: number,
    ) => {
      // Expiration, duplicate detection, validation against active capacity,
      // and insertion must be one immediate transaction to prevent overspend.
      if (
        !key ||
        !candidate.symbol ||
        !Number.isFinite(candidate.qty) ||
        candidate.qty <= 0 ||
        !Number.isFinite(candidate.price) ||
        candidate.price <= 0
      )
        throw new Error("Invalid risk reservation");
      const now = Date.now();
      db.query(
        "UPDATE risk_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE status = 'reserved' AND expires_at_ms <= ?",
      ).run(now);
      const existing = db
        .query(
          "SELECT reservation_key FROM risk_reservations WHERE reservation_key = ? AND status <> 'released'",
        )
        .get(key);
      if (existing)
        return { reserved: false as const, reason: "exists" as const };
      const validation = validate(reservationRows(now));
      if (!validation.allowed)
        return {
          reserved: false as const,
          reason: "risk" as const,
          validation: validation.value,
        };
      db.query(
        `INSERT INTO risk_reservations (reservation_key, symbol, side, qty, price, status, expires_at_ms) VALUES (?, ?, ?, ?, ?, 'reserved', ?)
      ON CONFLICT(reservation_key) DO UPDATE SET symbol=excluded.symbol, side=excluded.side, qty=excluded.qty, price=excluded.price,
      status='reserved', order_id=NULL, expires_at_ms=excluded.expires_at_ms, updated_at=CURRENT_TIMESTAMP WHERE risk_reservations.status='released'`,
      ).run(
        key,
        candidate.symbol,
        candidate.side,
        candidate.qty,
        candidate.price,
        now + ttlMs,
      );
      return { reserved: true as const, validation: validation.value };
    },
  );
  const reserveRiskBasketTransaction = db.transaction(
    <T>(
      key: string,
      candidates: ReservationCandidate[],
      validate: (active: RiskReservation[]) => ReservationValidation<T>,
      ttlMs: number,
    ) => {
      // Basket legs reserve together: either every leg consumes capacity or
      // none of them do.
      if (
        !key ||
        candidates.length < 2 ||
        candidates.length > 10 ||
        candidates.some(
          (candidate) =>
            !candidate.symbol ||
            !Number.isFinite(candidate.qty) ||
            candidate.qty <= 0 ||
            !Number.isFinite(candidate.price) ||
            candidate.price <= 0,
        )
      )
        throw new Error("Invalid basket risk reservation");
      const keys = candidates.map((_, index) => `${key}:${index}`);
      const placeholders = keys.map(() => "?").join(",");
      const now = Date.now();
      db.query(
        "UPDATE risk_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE status = 'reserved' AND expires_at_ms <= ?",
      ).run(now);
      if (
        db
          .query(
            `SELECT reservation_key FROM risk_reservations WHERE reservation_key IN (${placeholders}) AND status <> 'released' LIMIT 1`,
          )
          .get(...keys)
      )
        return { reserved: false as const, reason: "exists" as const };
      const validation = validate(reservationRows(now));
      if (!validation.allowed)
        return {
          reserved: false as const,
          reason: "risk" as const,
          validation: validation.value,
        };
      const insert =
        db.query(`INSERT INTO risk_reservations (reservation_key, symbol, side, qty, price, status, expires_at_ms) VALUES (?, ?, ?, ?, ?, 'reserved', ?)
      ON CONFLICT(reservation_key) DO UPDATE SET symbol=excluded.symbol, side=excluded.side, qty=excluded.qty, price=excluded.price,
      status='reserved', order_id=NULL, expires_at_ms=excluded.expires_at_ms, updated_at=CURRENT_TIMESTAMP WHERE risk_reservations.status='released'`);
      candidates.forEach((candidate, index) =>
        insert.run(
          keys[index]!,
          candidate.symbol,
          candidate.side,
          candidate.qty,
          candidate.price,
          now + ttlMs,
        ),
      );
      return { reserved: true as const, keys, validation: validation.value };
    },
  );
  const syncActivitiesTransaction = db.transaction(
    (activities: LedgerActivity[]) => {
      const statement =
        db.query(`INSERT INTO account_activities (activity_id, type, sub_type, category, status, occurred_at, symbol, side, quantity, price, amount, order_id, corporate_action, observed_at, published_at, effective_start, effective_end, effective_label, retrieved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET type=excluded.type, sub_type=excluded.sub_type, category=excluded.category, status=excluded.status,
      occurred_at=excluded.occurred_at, symbol=excluded.symbol, side=excluded.side, quantity=excluded.quantity, price=excluded.price,
      amount=excluded.amount, order_id=excluded.order_id, corporate_action=excluded.corporate_action, observed_at=excluded.observed_at,
      published_at=excluded.published_at, effective_start=excluded.effective_start, effective_end=excluded.effective_end,
      effective_label=excluded.effective_label, retrieved_at=excluded.retrieved_at, synced_at=CURRENT_TIMESTAMP`);
      for (const activity of activities)
        statement.run(
          activity.id,
          activity.type,
          activity.subType,
          activity.category,
          activity.status,
          activity.occurredAt,
          activity.symbol,
          activity.side,
          activity.quantity,
          activity.price,
          activity.amount,
          activity.orderId,
          activity.corporateAction
            ? JSON.stringify(activity.corporateAction)
            : null,
          activity.observedAt,
          activity.publishedAt,
          activity.effectivePeriod?.start ?? null,
          activity.effectivePeriod?.end ?? null,
          activity.effectivePeriod?.label ?? null,
          activity.retrievedAt,
        );
      return activities.length;
    },
  );
  const activitySelect = `SELECT activity_id AS id, type, sub_type AS subType, category, status, occurred_at AS occurredAt,
    symbol, side, quantity, price, amount, order_id AS orderId, corporate_action AS corporateActionJson,
    observed_at AS observedAt, published_at AS publishedAt, effective_start AS effectiveStart,
    effective_end AS effectiveEnd, effective_label AS effectiveLabel, retrieved_at AS retrievedAt FROM account_activities`;
  const decisionAuditSelect = `SELECT id, subject_id AS subjectId, kind, actor, payload, previous_hash AS previousHash,
    entry_hash AS entryHash, retention_until AS retentionUntil, created_at AS createdAt FROM decision_audit_log`;
  const mapEventRow = (row: any) => ({
    id: row.id,
    type: row.type,
    actor: row.actor,
    payload: JSON.parse(row.payload),
    createdAt: row.createdAt,
  });
  const encryptedSecretRow = (row: any) => ({
    name: row.name,
    envelope: EncryptedSecret.parse(JSON.parse(row.envelope)),
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const operationsPolicy = (): StoredOperationsPolicy => {
    const row = db
      .query(
        "SELECT payload, updated_by AS updatedBy, updated_at AS updatedAt FROM operations_policy WHERE id = 'global'",
      )
      .get() as {
      payload: string;
      updatedBy: string | null;
      updatedAt: string;
    } | null;
    const policy = parseOperationsPolicy(
      row ? JSON.parse(row.payload) : DEFAULT_OPERATIONS_POLICY,
    );
    return {
      ...policy,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  };
  const decisionAudit = (input: DecisionAuditInput) => {
    if (!input.subjectId || !input.kind || !input.actor)
      throw new Error("Invalid decision audit entry");
    const createdAt = input.createdAt ?? new Date().toISOString();
    const createdDate = new Date(createdAt);
    if (!Number.isFinite(createdDate.getTime()))
      throw new Error("Invalid decision audit timestamp");
    const retentionDays =
      Number.isFinite(input.retentionDays) && input.retentionDays! > 0
        ? input.retentionDays!
        : 365 * 7;
    const retentionUntil = new Date(
      createdDate.getTime() + retentionDays * 86_400_000,
    ).toISOString();
    const previous = db
      .query(
        "SELECT entry_hash AS entryHash FROM decision_audit_log ORDER BY id DESC LIMIT 1",
      )
      .get() as { entryHash: string } | null;
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
    // The previous hash lets verification detect mutation or reordering within
    // the retained chain. Retention policy separately governs record deletion.
    const entryHash = hashAuditEntry(hashInput);
    db.query(
      `INSERT INTO decision_audit_log (subject_id, kind, actor, payload, previous_hash, entry_hash, retention_until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.subjectId,
      input.kind,
      input.actor,
      JSON.stringify(payload),
      previous?.entryHash ?? null,
      entryHash,
      retentionUntil,
      createdAt,
    );
    return mapDecisionAuditRow(
      db.query(`${decisionAuditSelect} WHERE entry_hash = ?`).get(entryHash),
    );
  };
  return {
    event(type: string, actor: string, payload: unknown) {
      db.query(
        "INSERT INTO events (type, actor, payload) VALUES (?, ?, ?)",
      ).run(type, actor, JSON.stringify(payload));
    },
    events(limit = 100, type?: string) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
        throw new Error("Event limit is out of range");
      const rows = type
        ? db
            .query(
              "SELECT id, type, actor, payload, created_at AS createdAt FROM events WHERE type = ? ORDER BY id DESC LIMIT ?",
            )
            .all(type, limit)
        : db
            .query(
              "SELECT id, type, actor, payload, created_at AS createdAt FROM events ORDER BY id DESC LIMIT ?",
            )
            .all(limit);
      return (rows as any[]).map(mapEventRow);
    },
    submission(key: string) {
      const row = db
        .query("SELECT response FROM submissions WHERE idempotency_key = ?")
        .get(key) as { response: string } | null;
      return row ? JSON.parse(row.response) : null;
    },
    reserveSubmission(key: string) {
      return (
        db
          .query(
            "INSERT OR IGNORE INTO submissions (idempotency_key, response) VALUES (?, ?)",
          )
          .run(key, JSON.stringify({ pending: true })).changes === 1
      );
    },
    releaseSubmission(key: string) {
      db.query(
        "DELETE FROM submissions WHERE idempotency_key = ? AND order_id IS NULL",
      ).run(key);
    },
    completeSubmission(key: string, orderId: string, response: unknown) {
      db.query(
        "UPDATE submissions SET order_id = ?, response = ? WHERE idempotency_key = ?",
      ).run(orderId, JSON.stringify(response), key);
    },
    /** Atomically validates against every active local reservation and reserves capacity. */
    reserveRisk<T>(
      key: string,
      candidate: ReservationCandidate,
      validate: (active: RiskReservation[]) => ReservationValidation<T>,
      ttlMs = 120_000,
    ): RiskReservationResult<T> {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0)
        throw new Error("Risk reservation TTL must be positive");
      return reserveRiskTransaction.immediate(
        key,
        candidate,
        validate,
        ttlMs,
      ) as RiskReservationResult<T>;
    },
    /** Atomically validates and reserves every leg of one application-level basket. */
    reserveRiskBasket<T>(
      key: string,
      candidates: ReservationCandidate[],
      validate: (active: RiskReservation[]) => ReservationValidation<T>,
      ttlMs = 120_000,
    ): RiskBasketReservationResult<T> {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0)
        throw new Error("Risk reservation TTL must be positive");
      return reserveRiskBasketTransaction.immediate(
        key,
        candidates,
        validate,
        ttlMs,
      ) as RiskBasketReservationResult<T>;
    },
    activeRiskReservations() {
      return reservationRows();
    },
    markRiskSubmitted(key: string, orderId: string) {
      return (
        db
          .query(
            "UPDATE risk_reservations SET status = 'submitted', order_id = ?, expires_at_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE reservation_key = ? AND status = 'reserved' AND expires_at_ms > ?",
          )
          .run(orderId, key, Date.now()).changes === 1
      );
    },
    finishRiskReservation(
      keyOrOrderId: string,
      status: Exclude<RiskReservationStatus, "reserved" | "submitted">,
    ) {
      return (
        db
          .query(
            "UPDATE risk_reservations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE (reservation_key = ? OR order_id = ?) AND status IN ('reserved', 'submitted')",
          )
          .run(status, keyOrOrderId, keyOrOrderId).changes === 1
      );
    },
    receipt(id: string, payload: unknown) {
      db.query("INSERT INTO receipts (id, payload) VALUES (?, ?)").run(
        id,
        JSON.stringify(payload),
      );
      const record =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {};
      decisionAudit({
        subjectId: id,
        kind: `receipt.${String(record.kind ?? "decision")}`,
        actor: String(record.advisor ?? "system"),
        payload,
      });
    },
    operationsPolicy,
    updateOperationsPolicy(actor: string, patch: unknown) {
      if (!actor) throw new Error("Operations policy actor is required");
      const current = operationsPolicy();
      const {
        updatedAt: _updatedAt,
        updatedBy: _updatedBy,
        ...currentPolicy
      } = current;
      const next = parseOperationsPolicy({
        ...currentPolicy,
        ...(patch && typeof patch === "object" ? patch : {}),
      });
      db.query(
        `INSERT INTO operations_policy (id, payload, updated_by, updated_at) VALUES ('global', ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`,
      ).run(JSON.stringify(next), actor);
      return operationsPolicy();
    },
    upsertEncryptedSecret(
      name: string,
      envelope: EncryptedSecret,
      actor: string,
    ) {
      const parsedName = SecretName.parse(name);
      const parsedEnvelope = EncryptedSecret.parse(envelope);
      if (!actor) throw new Error("Encrypted secret actor is required");
      db.query(
        `INSERT INTO encrypted_secrets (name, envelope, updated_by) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET envelope=excluded.envelope, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`,
      ).run(parsedName, JSON.stringify(parsedEnvelope), actor);
      const row = encryptedSecretRow(
        db
          .query(
            "SELECT name, envelope, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM encrypted_secrets WHERE name = ?",
          )
          .get(parsedName),
      );
      return secretMetadata(
        row.name,
        row.envelope,
        row.updatedBy,
        row.updatedAt,
      );
    },
    encryptedSecret(name: string) {
      const row = db
        .query(
          "SELECT name, envelope, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM encrypted_secrets WHERE name = ?",
        )
        .get(SecretName.parse(name)) as any;
      return row ? encryptedSecretRow(row) : null;
    },
    encryptedSecretMetadata(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
        throw new Error("Encrypted secret limit is out of range");
      return (
        db
          .query(
            "SELECT name, envelope, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM encrypted_secrets ORDER BY name LIMIT ?",
          )
          .all(limit) as any[]
      )
        .map(encryptedSecretRow)
        .map((row) =>
          secretMetadata(row.name, row.envelope, row.updatedBy, row.updatedAt),
        );
    },
    deleteEncryptedSecret(name: string) {
      return (
        db
          .query("DELETE FROM encrypted_secrets WHERE name = ?")
          .run(SecretName.parse(name)).changes === 1
      );
    },
    getReceipt(id: string) {
      const row = db
        .query("SELECT payload FROM receipts WHERE id = ?")
        .get(id) as { payload: string } | null;
      return row ? JSON.parse(row.payload) : null;
    },
    receipts(limit = 20) {
      return (
        db
          .query(
            "SELECT id, payload FROM receipts ORDER BY created_at DESC LIMIT ?",
          )
          .all(limit) as { id: string; payload: string }[]
      ).map((row) => ({ id: row.id, ...JSON.parse(row.payload) }));
    },
    reconcileOrder(orderId: string, status: string) {
      // Receipts currently store broker ids inside JSON, so reconciliation
      // scans the bounded paper-account history. Promote order_id to an indexed
      // column before supporting large or multi-account histories.
      const rows = db.query("SELECT id, payload FROM receipts").all() as {
        id: string;
        payload: string;
      }[];
      for (const row of rows) {
        const receipt = JSON.parse(row.payload);
        let changed = false;
        if (receipt.orderId === orderId && receipt.status !== status) {
          receipt.status = status;
          changed = true;
        }
        const result = Array.isArray(receipt.results)
          ? receipt.results.find((item: any) => item.orderId === orderId)
          : null;
        if (result && result.status !== status) {
          result.status = status;
          changed = true;
        }
        if (changed) {
          receipt.updatedAt = new Date().toISOString();
          db.query("UPDATE receipts SET payload = ? WHERE id = ?").run(
            JSON.stringify(receipt),
            row.id,
          );
        }
      }
    },
    plan(id: string, intent: string, payload: unknown, actor = "agent") {
      db.query("INSERT INTO plans (id, intent, payload) VALUES (?, ?, ?)").run(
        id,
        intent,
        JSON.stringify(payload),
      );
      decisionAudit({
        subjectId: id,
        kind: "agent.plan",
        actor,
        payload: {
          intent,
          ...(payload && typeof payload === "object"
            ? (payload as Record<string, unknown>)
            : { payload }),
        },
      });
    },
    getPlan(id: string) {
      const row = db
        .query("SELECT intent, payload, created_at FROM plans WHERE id = ?")
        .get(id) as {
        intent: string;
        payload: string;
        created_at: string;
      } | null;
      return row
        ? {
            id,
            intent: row.intent,
            createdAt: row.created_at,
            ...JSON.parse(row.payload),
          }
        : null;
    },
    addTradeJournalEntry(value: TradeJournalEntry, actor: string) {
      const entry = TradeJournalEntry.parse(value);
      if (!actor) throw new Error("Trade journal actor is required");
      db.query(
        "INSERT INTO trade_journal_entries (id, receipt_id, payload, updated_at) VALUES (?, ?, ?, ?)",
      ).run(entry.id, entry.receiptId, JSON.stringify(entry), entry.updatedAt);
      decisionAudit({
        subjectId: entry.id,
        kind: "trade_journal.created",
        actor,
        payload: entry,
      });
      return entry;
    },
    getTradeJournalEntry(id: string) {
      const row = db
        .query("SELECT payload FROM trade_journal_entries WHERE id = ?")
        .get(id) as { payload: string } | null;
      return row ? TradeJournalEntry.parse(JSON.parse(row.payload)) : null;
    },
    tradeJournalEntryForReceipt(receiptId: string) {
      const row = db
        .query("SELECT payload FROM trade_journal_entries WHERE receipt_id = ?")
        .get(receiptId) as { payload: string } | null;
      return row ? TradeJournalEntry.parse(JSON.parse(row.payload)) : null;
    },
    tradeJournalEntries(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error("Trade journal limit is out of range");
      return (
        db
          .query(
            "SELECT payload FROM trade_journal_entries ORDER BY updated_at DESC LIMIT ?",
          )
          .all(limit) as { payload: string }[]
      ).map((row) => TradeJournalEntry.parse(JSON.parse(row.payload)));
    },
    updateTradeJournalEntry(value: TradeJournalEntry, actor: string) {
      const entry = TradeJournalEntry.parse(value);
      const review = entry.reviews.at(-1);
      if (!actor || !review)
        throw new Error("Trade journal review is required");
      const changed = db
        .query(
          "UPDATE trade_journal_entries SET payload = ?, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(entry), entry.updatedAt, entry.id).changes;
      if (changed !== 1) throw new Error("Trade journal entry not found");
      decisionAudit({
        subjectId: entry.id,
        kind: "trade_journal.reviewed",
        actor,
        payload: review,
      });
      return entry;
    },
    syncActivities(activities: LedgerActivity[]) {
      return syncActivitiesTransaction.immediate(activities);
    },
    activities(limit = 100, category?: LedgerCategory) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000)
        throw new Error("Activity limit is out of range");
      const rows = (
        category
          ? db
              .query(
                `${activitySelect} WHERE category = ? ORDER BY occurred_at DESC, activity_id DESC LIMIT ?`,
              )
              .all(category, limit)
          : db
              .query(
                `${activitySelect} ORDER BY occurred_at DESC, activity_id DESC LIMIT ?`,
              )
              .all(limit)
      ) as (LedgerActivity & {
        corporateActionJson: string | null;
        effectiveStart: string | null;
        effectiveEnd: string | null;
        effectiveLabel: string | null;
      })[];
      return rows.map(({
        corporateActionJson,
        effectiveStart,
        effectiveEnd,
        effectiveLabel,
        ...activity
      }) => ({
        ...activity,
        corporateAction: corporateActionJson
          ? JSON.parse(corporateActionJson)
          : null,
        effectivePeriod:
          effectiveStart || effectiveEnd || effectiveLabel
            ? {
                start: effectiveStart,
                end: effectiveEnd,
                label: effectiveLabel,
              }
            : null,
      }));
    },
    startResearch(id: string, symbol: string, model: string) {
      db.query(
        "INSERT INTO research_runs (id, symbol, status, model) VALUES (?, ?, 'running', ?)",
      ).run(id, symbol, model);
    },
    completeResearch(id: string, payload: unknown, metrics: unknown) {
      db.query(
        "UPDATE research_runs SET status = 'completed', payload = ?, metrics = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
      ).run(JSON.stringify(payload), JSON.stringify(metrics), id);
    },
    completeResearchArtifact(id: string, payload: unknown) {
      db.query(
        "UPDATE research_runs SET status = 'completed', payload = ?, metrics = NULL, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
      ).run(JSON.stringify(payload), id);
    },
    failResearch(id: string, error: string) {
      db.query(
        "UPDATE research_runs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
      ).run(error.slice(0, 500), id);
    },
    getResearch(id: string) {
      const row = db
        .query(
          "SELECT id, symbol, status, model, payload, metrics, error, created_at AS createdAt, completed_at AS completedAt FROM research_runs WHERE id = ?",
        )
        .get(id) as any;
      return row
        ? {
            ...row,
            payload: row.payload ? JSON.parse(row.payload) : null,
            metrics: row.metrics ? JSON.parse(row.metrics) : null,
          }
        : null;
    },
    researchMetrics(limit = 50) {
      const rows = db
        .query(
          "SELECT metrics FROM research_runs WHERE status = 'completed' AND metrics IS NOT NULL ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as { metrics: string }[];
      const metrics = rows.map((row) => JSON.parse(row.metrics));
      const average = (key: string) =>
        metrics.length
          ? metrics.reduce((sum, item) => sum + Number(item[key] ?? 0), 0) /
            metrics.length
          : 0;
      return {
        totalRuns: metrics.length,
        successRate: metrics.length
          ? metrics.filter((item) => item.overallScore >= 90).length /
            metrics.length
          : 0,
        averageScore: average("overallScore"),
        averageLatencyMs: average("latencyMs"),
        averageCitationValidity: average("citationValidity"),
        averageNumericGrounding: average("numericGrounding"),
        averageToolCoverage: average("toolCoverage"),
        averageTokens: average("totalTokens"),
      };
    },
    portfolioSnapshot<T extends { snapshotDate: string }>(snapshot: T) {
      db.query(
        "INSERT INTO portfolio_snapshots (snapshot_date, payload) VALUES (?, ?) ON CONFLICT(snapshot_date) DO UPDATE SET payload=excluded.payload",
      ).run(snapshot.snapshotDate, JSON.stringify(snapshot));
    },
    portfolioSnapshots(limit = 90) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 366)
        throw new Error("Snapshot limit is out of range");
      return (
        db
          .query(
            "SELECT payload FROM portfolio_snapshots ORDER BY snapshot_date DESC LIMIT ?",
          )
          .all(limit) as { payload: string }[]
      ).map((row) => JSON.parse(row.payload));
    },
    ...strategyStore,
    decisionAudit,
    decisionAuditTrail(subjectId?: string, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
        throw new Error("Decision audit limit is out of range");
      const rows = subjectId
        ? db
            .query(
              `${decisionAuditSelect} WHERE subject_id = ? ORDER BY id LIMIT ?`,
            )
            .all(subjectId, limit)
        : db
            .query(`${decisionAuditSelect} ORDER BY id DESC LIMIT ?`)
            .all(limit);
      return (rows as any[]).map(mapDecisionAuditRow);
    },
    verifyDecisionAuditTrail() {
      const entries = (
        db.query(`${decisionAuditSelect} ORDER BY id`).all() as any[]
      ).map(mapDecisionAuditRow);
      let previousHash: string | null = null;
      const invalid = entries.find((entry) => {
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
        const broken =
          entry.previousHash !== previousHash || entry.entryHash !== hash;
        previousHash = entry.entryHash;
        return broken;
      });
      return {
        valid: !invalid,
        entries: entries.length,
        invalidEntryId: invalid?.id ?? null,
      };
    },
    schemaMigrations() {
      const rows = db
        .query(
          "SELECT id, name, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY id",
        )
        .all() as any[];
      return rows.map((row) => ({
        ...row,
        expected: SCHEMA_MIGRATIONS.some(
          (migration) =>
            migration.id === row.id &&
            migration.name === row.name &&
            migration.checksum === row.checksum,
        ),
      }));
    },
    databaseBackup() {
      const bytes = db.serialize();
      return {
        bytes,
        metadata: {
          sizeBytes: bytes.byteLength,
          sha256: hashBytes(bytes),
          createdAt: new Date().toISOString(),
          migrations: SCHEMA_MIGRATIONS.length,
        },
      };
    },
    observabilityExport(limit = 500) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000)
        throw new Error("Observability export limit is out of range");
      const spans = this.events(limit, "otel.span").map(
        (event) => event.payload,
      );
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
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
        throw new Error("Incident packet limit is out of range");
      const patterns = [
        /error/i,
        /failed/i,
        /rejected/i,
        /kill_switch/i,
        /blocked/i,
        /incident/i,
        /stale/i,
      ];
      const recentEvents = this.events(Math.min(limit * 2, 1_000))
        .filter((event) => patterns.some((pattern) => pattern.test(event.type)))
        .slice(0, limit);
      return {
        generatedAt: new Date().toISOString(),
        severity: recentEvents.some((event) =>
          /error|failed|rejected|kill_switch/i.test(event.type),
        )
          ? "review"
          : "normal",
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
    close() {
      db.close();
    },
  };
}
