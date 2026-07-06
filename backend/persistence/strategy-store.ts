/**
 * Persistence boundary for strategy runs and their reproducibility evidence.
 *
 * A run can only reference a clean, comparable backtest with matching code,
 * data, feature schema, plugin, and policy provenance.
 */
import type { Database } from "bun:sqlite";
import { hashAuditEntry } from "./audit";
import {
  canonicalHash,
  parseStrategyProvenance,
  type StrategyProvenance,
} from "../features/strategies/strategy-provenance";
import {
  cryptoDatasetHash,
  type CryptoDatasetStats,
} from "../features/strategies/strategy-datasets";
import {
  normalizeCryptoBar,
  type NormalizedCryptoBar,
} from "../features/strategies/crypto-strategy-data";

export type StrategyRunStatus =
  | "backtest"
  | "shadow"
  | "paper"
  | "paused"
  | "completed"
  | "retired"
  | "failed";
export type StrategyDecisionKind =
  "hold" | "enter" | "increase" | "reduce" | "exit" | "pause" | "block";
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
export type StrategyBarDatasetInput = {
  id: string;
  actor: string;
  provider: "Alpaca Market Data API";
  feed: "us";
  timezone: "UTC";
  timeframe: string;
  symbols: string[];
  start: string;
  end: string;
  datasetHash: string;
  previousDatasetId: string | null;
  stats: CryptoDatasetStats;
  bars: NormalizedCryptoBar[];
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
    comparable: Boolean(
      row.backtestId && provenance && !provenance.workingTreeDirty,
    ),
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

function mapStrategyBarRow(row: any): NormalizedCryptoBar & {
  contentHash: string;
} {
  return {
    symbol: row.symbol,
    timestamp: row.timestamp,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    vwap: row.vwap,
    tradeCount: row.tradeCount,
    contentHash: row.contentHash,
  };
}

function mapStrategyBarDatasetRow(row: any, bars: ReturnType<typeof mapStrategyBarRow>[] = []) {
  if (!row) return null;
  return {
    ...row,
    symbols: JSON.parse(row.symbols),
    stats: JSON.parse(row.stats),
    bars,
  };
}

function mapStrategyDecisionRow(row: any) {
  const draftOrder = row.draftOrder ? JSON.parse(row.draftOrder) : null;
  const provenance = row.provenance ? JSON.parse(row.provenance) : null;
  const order = row.orderId
    ? {
        id: row.orderId,
        paperOrderId: row.orderPaperOrderId,
        status: row.orderStatus,
        payload: row.orderPayload ? JSON.parse(row.orderPayload) : null,
        createdAt: row.orderCreatedAt,
        updatedAt: row.orderUpdatedAt,
      }
    : null;
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
    orderOutcome:
      order?.status ??
      (row.paperOrderId ? "linked" : draftOrder ? "drafted" : "none"),
  };
}

function decisionMatchesFilter(
  decision: ReturnType<typeof mapStrategyDecisionRow>,
  filter: StrategyDecisionFilter,
) {
  if (filter.orderOutcome && decision.orderOutcome !== filter.orderOutcome)
    return false;
  if (!filter.blockReason) return true;
  const needle = filter.blockReason.toLowerCase();
  const reasons: string[] = Array.isArray(decision.riskChecks?.reasons)
    ? decision.riskChecks.reasons.map((reason: unknown) => String(reason))
    : [];
  return (
    reasons.some((reason) => reason.toLowerCase().includes(needle)) ||
    String(decision.reason).toLowerCase().includes(needle)
  );
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

/** Persists strategy backtests, runs, evidence, metrics, orders, notes, and audit history. */
export function createStrategyStore(db: Database) {
  const strategyAuditSelect = `SELECT id, run_id AS runId, kind, actor, subject, strategy_id AS strategyId, strategy_version AS strategyVersion,
    policy_version AS policyVersion, config_hash AS configHash, before_payload AS beforePayload, after_payload AS afterPayload,
    metadata, previous_hash AS previousHash, entry_hash AS entryHash, retention_until AS retentionUntil, created_at AS createdAt FROM strategy_audit_log`;
  return {
    strategyBarDataset(input: StrategyBarDatasetInput) {
      const start = new Date(input.start),
        end = new Date(input.end);
      if (
        !input.id ||
        !input.actor ||
        input.provider !== "Alpaca Market Data API" ||
        input.feed !== "us" ||
        input.timezone !== "UTC" ||
        !input.timeframe ||
        !input.symbols.length ||
        input.symbols.some((symbol) => !/^[A-Z0-9/.-]{2,20}$/.test(symbol)) ||
        !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) ||
        start >= end ||
        !/^sha256:[a-f0-9]{64}$/.test(input.datasetHash) ||
        !input.bars.length ||
        input.bars.some(
          (bar) => {
            const timestamp = new Date(bar.timestamp);
            const normalized = normalizeCryptoBar(bar.symbol, bar);
            return (
              !normalized ||
              canonicalHash(normalized) !== canonicalHash(bar) ||
              !input.symbols.includes(bar.symbol) ||
              !Number.isFinite(timestamp.getTime()) ||
              timestamp < start ||
              timestamp > end
            );
          },
        ) ||
        cryptoDatasetHash(input) !== input.datasetHash
      )
        throw new Error("Invalid strategy bar dataset");
      if (
        input.previousDatasetId &&
        !db
          .query(
            `SELECT id FROM strategy_bar_datasets
            WHERE id = ? AND actor = ? AND symbols = ? AND timeframe = ?
            AND query_start = ? AND query_end = ?`,
          )
          .get(
            input.previousDatasetId,
            input.actor,
            JSON.stringify(input.symbols),
            input.timeframe,
            input.start,
            input.end,
          )
      )
        throw new Error("Previous strategy bar dataset not found");
      const insertDataset = db.query(
        `INSERT INTO strategy_bar_datasets
        (id, actor, provider, feed, timezone, timeframe, symbols, query_start, query_end, dataset_hash, previous_dataset_id, stats)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertBar = db.query(
        `INSERT INTO strategy_bars
        (dataset_id, symbol, observed_at, open, high, low, close, volume, vwap, trade_count, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        insertDataset.run(
          input.id,
          input.actor,
          input.provider,
          input.feed,
          input.timezone,
          input.timeframe,
          JSON.stringify(input.symbols),
          input.start,
          input.end,
          input.datasetHash,
          input.previousDatasetId,
          JSON.stringify(input.stats),
        );
        for (const bar of input.bars)
          insertBar.run(
            input.id,
            bar.symbol,
            bar.timestamp,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            bar.vwap,
            bar.tradeCount,
            canonicalHash(bar),
          );
      }).immediate();
      return this.getStrategyBarDataset(input.id);
    },
    getStrategyBarDataset(id: string) {
      const row = db
        .query(
          `SELECT id, actor, provider, feed, timezone, timeframe, symbols,
          query_start AS start, query_end AS end, dataset_hash AS datasetHash,
          previous_dataset_id AS previousDatasetId, stats, created_at AS createdAt
          FROM strategy_bar_datasets WHERE id = ?`,
        )
        .get(id) as any;
      if (!row) return null;
      const bars = (
        db
          .query(
            `SELECT symbol, observed_at AS timestamp, open, high, low, close, volume, vwap,
            trade_count AS tradeCount, content_hash AS contentHash
            FROM strategy_bars WHERE dataset_id = ? ORDER BY symbol, observed_at`,
          )
          .all(id) as any[]
      ).map(mapStrategyBarRow);
      return mapStrategyBarDatasetRow(row, bars);
    },
    strategyBarDatasetByHash(actor: string, datasetHash: string) {
      const row = db
        .query(
          "SELECT id FROM strategy_bar_datasets WHERE actor = ? AND dataset_hash = ?",
        )
        .get(actor, datasetHash) as { id: string } | null;
      return row ? this.getStrategyBarDataset(row.id) : null;
    },
    latestStrategyBarDataset(
      actor: string,
      symbols: string[],
      timeframe: string,
      start: string,
      end: string,
    ) {
      const row = db
        .query(
          `SELECT id FROM strategy_bar_datasets
          WHERE actor = ? AND symbols = ? AND timeframe = ? AND query_start = ? AND query_end = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(actor, JSON.stringify(symbols), timeframe, start, end) as
        | { id: string }
        | null;
      return row ? this.getStrategyBarDataset(row.id) : null;
    },
    strategyBarDatasets(actor: string, limit = 20) {
      if (!actor || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Strategy bar dataset query is out of range");
      return (
        db
          .query(
            `SELECT id, actor, provider, feed, timezone, timeframe, symbols,
            query_start AS start, query_end AS end, dataset_hash AS datasetHash,
            previous_dataset_id AS previousDatasetId, stats, created_at AS createdAt
            FROM strategy_bar_datasets WHERE actor = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(actor, limit) as any[]
      ).map((row) => mapStrategyBarDatasetRow(row));
    },
    strategyBacktest(input: StrategyBacktestInput) {
      const provenance = parseStrategyProvenance(input.provenance);
      if (
        !input.id ||
        !input.actor ||
        !input.strategyId ||
        input.definitionHash !== provenance.definitionHash
      )
        throw new Error("Invalid strategy backtest");
      db.query(
        `INSERT INTO strategy_backtests (id, actor, strategy_id, definition_hash, provenance, request, result)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.actor,
        input.strategyId,
        input.definitionHash,
        JSON.stringify(provenance),
        JSON.stringify(input.request),
        JSON.stringify(input.result),
      );
      return mapStrategyBacktestRow(
        db
          .query(
            `SELECT id, actor, strategy_id AS strategyId, definition_hash AS definitionHash,
        provenance, request, result, created_at AS createdAt FROM strategy_backtests WHERE id = ?`,
          )
          .get(input.id),
      );
    },
    getStrategyBacktest(id: string) {
      return mapStrategyBacktestRow(
        db
          .query(
            `SELECT id, actor, strategy_id AS strategyId, definition_hash AS definitionHash,
        provenance, request, result, created_at AS createdAt FROM strategy_backtests WHERE id = ?`,
          )
          .get(id),
      );
    },
    createStrategyRun(input: StrategyRunInput) {
      const provenance = parseStrategyProvenance(input.provenance);
      const backtest = this.getStrategyBacktest(input.backtestId);
      if (
        !input.id ||
        !input.backtestId ||
        !input.strategyId ||
        !input.strategyVersion ||
        !input.configHash ||
        !input.policyVersion ||
        !input.symbols.length ||
        input.symbols.some((symbol) => !/^[A-Z0-9/.-]{2,20}$/.test(symbol)) ||
        !Number.isFinite(input.budget) ||
        input.budget < 0
      )
        throw new Error("Invalid strategy run");
      if (
        !backtest?.comparable ||
        provenance.workingTreeDirty ||
        backtest.strategyId !== input.strategyId ||
        backtest.definitionHash !== provenance.definitionHash ||
        backtest.provenance.gitCommit !== provenance.gitCommit ||
        backtest.provenance.featureSchemaVersion !==
          provenance.featureSchemaVersion ||
        backtest.provenance.datasetHash !== provenance.datasetHash ||
        provenance.pluginVersion !== input.strategyVersion ||
        provenance.policyVersion !== input.policyVersion
      )
        throw new Error("Strategy run does not match its reviewed backtest");
      // The provenance gate above prevents a reviewed result from being reused
      // after its strategy definition, dataset, code, or policy has changed.
      db.query(
        `INSERT INTO strategy_runs (id, backtest_id, strategy_id, strategy_version, status, config_hash, policy_version, symbols, budget, config, provenance, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.backtestId,
        input.strategyId,
        input.strategyVersion,
        input.status,
        input.configHash,
        input.policyVersion,
        JSON.stringify(input.symbols),
        input.budget,
        JSON.stringify(input.config),
        JSON.stringify(provenance),
        input.notes ?? null,
      );
    },
    updateStrategyRunStatus(
      id: string,
      status: StrategyRunStatus,
      notes?: string | null,
    ) {
      return (
        db
          .query(
            "UPDATE strategy_runs SET status = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
          .run(status, notes ?? null, id).changes === 1
      );
    },
    updateStrategyRunConfig(
      id: string,
      config: unknown,
      configHash?: string | null,
    ) {
      return (
        db
          .query(
            "UPDATE strategy_runs SET config = ?, config_hash = COALESCE(?, config_hash), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
          .run(JSON.stringify(config), configHash ?? null, id).changes === 1
      );
    },
    approveStrategyRunPaper(
      id: string,
      budget: number,
      config: unknown,
      configHash?: string | null,
    ) {
      if (!Number.isFinite(budget) || budget <= 0)
        throw new Error("Invalid paper strategy budget");
      return (
        db
          .query(
            "UPDATE strategy_runs SET status = 'paper', budget = ?, config = ?, config_hash = COALESCE(?, config_hash), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('shadow', 'paused')",
          )
          .run(budget, JSON.stringify(config), configHash ?? null, id)
          .changes === 1
      );
    },
    getStrategyRun(id: string) {
      return mapStrategyRunRow(
        db.query(`${strategyRunSelect} WHERE id = ?`).get(id),
      );
    },
    strategyRuns(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Strategy run limit is out of range");
      return (
        db
          .query(`${strategyRunSelect} ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as any[]
      ).map(mapStrategyRunRow);
    },
    strategyDataSnapshot(input: StrategyDataSnapshotInput) {
      if (
        !input.id ||
        !input.runId ||
        !input.symbol ||
        !input.source ||
        !input.feed ||
        !input.observedAt ||
        !/^sha256:[a-f0-9]{64}$/.test(input.datasetHash) ||
        (input.latencyMs !== null &&
          (!Number.isFinite(input.latencyMs) || input.latencyMs < 0))
      )
        throw new Error("Invalid strategy data snapshot");
      db.query(
        `INSERT INTO strategy_data_snapshots (id, run_id, symbol, source, feed, observed_at, stale, latency_ms, dataset_hash, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.runId,
        input.symbol,
        input.source,
        input.feed,
        input.observedAt,
        input.stale ? 1 : 0,
        input.latencyMs,
        input.datasetHash,
        JSON.stringify(input.payload),
      );
    },
    strategyDecision(input: StrategyDecisionInput) {
      const provenance = parseStrategyProvenance(input.provenance);
      const run = db
        .query(
          "SELECT strategy_version AS strategyVersion, policy_version AS policyVersion FROM strategy_runs WHERE id = ?",
        )
        .get(input.runId) as {
        strategyVersion: string;
        policyVersion: string;
      } | null;
      if (
        !input.id ||
        !input.traceId ||
        !input.runId ||
        !input.symbol ||
        !input.reason ||
        !run ||
        provenance.pluginVersion !== run.strategyVersion ||
        provenance.policyVersion !== run.policyVersion
      )
        throw new Error("Invalid strategy decision");
      db.query(
        `INSERT INTO strategy_decisions (id, trace_id, run_id, symbol, decision, features, weights, thresholds, risk_checks, data_snapshot_ids, raw_signal, risk_adjusted_signal, target_position, reason, provenance, draft_order, paper_order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.traceId,
        input.runId,
        input.symbol,
        input.decision,
        JSON.stringify(input.features),
        JSON.stringify(input.weights),
        JSON.stringify(input.thresholds),
        JSON.stringify(input.riskChecks),
        JSON.stringify(input.dataSnapshotIds),
        input.rawSignal,
        input.riskAdjustedSignal,
        input.targetPosition,
        input.reason,
        JSON.stringify(provenance),
        input.draftOrder === undefined
          ? null
          : JSON.stringify(input.draftOrder),
        input.paperOrderId ?? null,
      );
    },
    strategyDecisions(
      runId: string,
      limit = 50,
      filter: StrategyDecisionFilter = {},
    ) {
      if (!runId || !Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error("Strategy decision query is out of range");
      const clauses = ["sd.run_id = ?"],
        params: (string | number | null)[] = [runId];
      if (filter.symbol) {
        clauses.push("sd.symbol = ?");
        params.push(filter.symbol);
      }
      if (filter.decision) {
        clauses.push("sd.decision = ?");
        params.push(filter.decision);
      }
      if (filter.strategyId) {
        clauses.push("sr.strategy_id = ?");
        params.push(filter.strategyId);
      }
      if (filter.strategyVersion) {
        clauses.push("sr.strategy_version = ?");
        params.push(filter.strategyVersion);
      }
      const rawLimit = filter.blockReason || filter.orderOutcome ? 500 : limit;
      // blockReason and orderOutcome live in JSON-derived DTO fields, so fetch
      // a bounded superset before applying those two filters in memory.
      const rows = db
        .query(
          `SELECT sd.id, sd.trace_id AS traceId, sd.run_id AS runId, sd.symbol, sd.decision, sd.features, sd.weights, sd.thresholds, sd.risk_checks AS riskChecks, sd.data_snapshot_ids AS dataSnapshotIds, sd.provenance,
        sd.raw_signal AS rawSignal, sd.risk_adjusted_signal AS riskAdjustedSignal, sd.target_position AS targetPosition, sd.reason, sd.draft_order AS draftOrder, sd.paper_order_id AS paperOrderId, sd.created_at AS createdAt,
        sr.strategy_id AS strategyId, sr.strategy_version AS strategyVersion,
        so.id AS orderId, so.paper_order_id AS orderPaperOrderId, so.status AS orderStatus, so.payload AS orderPayload, so.created_at AS orderCreatedAt, so.updated_at AS orderUpdatedAt
        FROM strategy_decisions sd
        JOIN strategy_runs sr ON sr.id = sd.run_id
        LEFT JOIN strategy_orders so ON so.decision_id = sd.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY sd.created_at DESC LIMIT ?`,
        )
        .all(...params, rawLimit) as any[];
      return rows
        .map(mapStrategyDecisionRow)
        .filter((decision) => decisionMatchesFilter(decision, filter))
        .slice(0, limit);
    },
    getStrategyDecisionTrace(traceId: string) {
      const row = db
        .query(
          `SELECT sd.id, sd.trace_id AS traceId, sd.run_id AS runId, sd.symbol, sd.decision, sd.features, sd.weights, sd.thresholds, sd.risk_checks AS riskChecks, sd.data_snapshot_ids AS dataSnapshotIds, sd.provenance,
        sd.raw_signal AS rawSignal, sd.risk_adjusted_signal AS riskAdjustedSignal, sd.target_position AS targetPosition, sd.reason, sd.draft_order AS draftOrder, sd.paper_order_id AS paperOrderId, sd.created_at AS createdAt,
        sr.strategy_id AS strategyId, sr.strategy_version AS strategyVersion,
        so.id AS orderId, so.paper_order_id AS orderPaperOrderId, so.status AS orderStatus, so.payload AS orderPayload, so.created_at AS orderCreatedAt, so.updated_at AS orderUpdatedAt
        FROM strategy_decisions sd
        JOIN strategy_runs sr ON sr.id = sd.run_id
        LEFT JOIN strategy_orders so ON so.decision_id = sd.id
        WHERE sd.trace_id = ?`,
        )
        .get(traceId) as any;
      if (!row) return null;
      const decision = mapStrategyDecisionRow(row);
      const dataSnapshotIds = decision.dataSnapshotIds as string[];
      const snapshots = dataSnapshotIds.length
        ? (db
            .query(
              `SELECT id, run_id AS runId, symbol, source, feed, observed_at AS observedAt, stale, latency_ms AS latencyMs, dataset_hash AS datasetHash, payload, created_at AS createdAt
          FROM strategy_data_snapshots WHERE id IN (${dataSnapshotIds.map(() => "?").join(",")})`,
            )
            .all(...dataSnapshotIds) as any[])
        : [];
      return {
        ...decision,
        dataSnapshotIds,
        snapshots: snapshots.map((snapshot) => ({
          ...snapshot,
          stale: Boolean(snapshot.stale),
          payload: JSON.parse(snapshot.payload),
        })),
      };
    },
    strategyOrder(input: StrategyOrderInput) {
      if (
        !input.id ||
        !input.runId ||
        !input.decisionId ||
        !input.paperOrderId ||
        !input.status
      )
        throw new Error("Invalid strategy order");
      db.query(
        `INSERT INTO strategy_orders (id, run_id, decision_id, paper_order_id, status, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=CURRENT_TIMESTAMP`,
      ).run(
        input.id,
        input.runId,
        input.decisionId,
        input.paperOrderId,
        input.status,
        JSON.stringify(input.payload),
      );
    },
    reconcileStrategyOrder(
      paperOrderId: string,
      status: string,
      payloadPatch: Record<string, unknown>,
    ) {
      if (!paperOrderId || !status)
        throw new Error("Invalid strategy order reconciliation");
      const row = db
        .query("SELECT payload FROM strategy_orders WHERE paper_order_id = ?")
        .get(paperOrderId) as { payload: string } | null;
      if (!row) return false;
      const payload = { ...JSON.parse(row.payload), ...payloadPatch };
      return (
        db
          .query(
            "UPDATE strategy_orders SET status = ?, payload = ?, updated_at = CURRENT_TIMESTAMP WHERE paper_order_id = ?",
          )
          .run(status, JSON.stringify(payload), paperOrderId).changes > 0
      );
    },
    strategyOrders(runId: string) {
      if (!runId) throw new Error("Strategy run id is required");
      return (
        db
          .query(
            "SELECT id, run_id AS runId, decision_id AS decisionId, paper_order_id AS paperOrderId, status, payload, created_at AS createdAt, updated_at AS updatedAt FROM strategy_orders WHERE run_id = ? ORDER BY created_at DESC",
          )
          .all(runId) as any[]
      ).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    },
    strategyMetric(input: StrategyMetricInput) {
      if (
        !input.runId ||
        !input.name ||
        !Number.isFinite(input.value) ||
        !input.unit ||
        !input.asOf
      )
        throw new Error("Invalid strategy metric");
      db.query(
        `INSERT INTO strategy_metrics (run_id, name, value, unit, as_of) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, name, as_of) DO UPDATE SET value=excluded.value, unit=excluded.unit, created_at=CURRENT_TIMESTAMP`,
      ).run(input.runId, input.name, input.value, input.unit, input.asOf);
    },
    strategyMetrics(runId: string) {
      return db
        .query(
          "SELECT run_id AS runId, name, value, unit, as_of AS asOf, created_at AS createdAt FROM strategy_metrics WHERE run_id = ? ORDER BY as_of DESC, name",
        )
        .all(runId);
    },
    allStrategyMetrics(limit = 500) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000)
        throw new Error("Strategy metric limit is out of range");
      return db
        .query(
          "SELECT run_id AS runId, name, value, unit, as_of AS asOf, created_at AS createdAt FROM strategy_metrics ORDER BY as_of DESC, created_at DESC, name LIMIT ?",
        )
        .all(limit);
    },
    strategyNote(runId: string, actor: string, note: string) {
      if (!runId || !actor || !note.trim())
        throw new Error("Invalid strategy note");
      db.query(
        "INSERT INTO strategy_notes (run_id, actor, note) VALUES (?, ?, ?)",
      ).run(runId, actor, note.trim());
    },
    strategyNotes(runId: string) {
      if (!runId) throw new Error("Strategy run id is required");
      return db
        .query(
          "SELECT actor, note, created_at AS createdAt FROM strategy_notes WHERE run_id = ? ORDER BY created_at DESC, id DESC",
        )
        .all(runId);
    },
    strategyAudit(input: StrategyAuditInput) {
      if (!input.runId || !input.kind || !input.actor || !input.subject)
        throw new Error("Invalid strategy audit entry");
      const createdAt = input.createdAt ?? new Date().toISOString();
      const createdDate = new Date(createdAt);
      if (!Number.isFinite(createdDate.getTime()))
        throw new Error("Invalid strategy audit timestamp");
      const retentionDays =
        Number.isFinite(input.retentionDays) && input.retentionDays! > 0
          ? input.retentionDays!
          : 365 * 7;
      const retentionUntil = new Date(
        createdDate.getTime() + retentionDays * 86_400_000,
      ).toISOString();
      const previous = db
        .query(
          "SELECT entry_hash AS entryHash FROM strategy_audit_log WHERE run_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(input.runId) as { entryHash: string } | null;
      const beforePayload =
        input.before === undefined ? null : JSON.stringify(input.before);
      const afterPayload =
        input.after === undefined ? null : JSON.stringify(input.after);
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
      // Strategy chains are scoped per run so one damaged run does not prevent
      // independent verification of every other strategy.
      const entryHash = hashAuditEntry(hashInput);
      db.query(
        `INSERT INTO strategy_audit_log (run_id, kind, actor, subject, strategy_id, strategy_version, policy_version, config_hash, before_payload, after_payload, metadata, previous_hash, entry_hash, retention_until, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.runId,
        input.kind,
        input.actor,
        input.subject,
        input.strategyId ?? null,
        input.strategyVersion ?? null,
        input.policyVersion ?? null,
        input.configHash ?? null,
        beforePayload,
        afterPayload,
        metadataPayload,
        previous?.entryHash ?? null,
        entryHash,
        retentionUntil,
        createdAt,
      );
      const row = db
        .query(`${strategyAuditSelect} WHERE entry_hash = ?`)
        .get(entryHash) as any;
      return mapStrategyAuditRow(row);
    },
    strategyAuditTrail(runId: string) {
      if (!runId) throw new Error("Strategy run id is required");
      return (
        db
          .query(`${strategyAuditSelect} WHERE run_id = ? ORDER BY id`)
          .all(runId) as any[]
      ).map(mapStrategyAuditRow);
    },
    verifyStrategyAuditTrail(runId: string) {
      if (!runId) throw new Error("Strategy run id is required");
      const entries = (
        db
          .query(`${strategyAuditSelect} WHERE run_id = ? ORDER BY id`)
          .all(runId) as any[]
      ).map(mapStrategyAuditRow);
      let previousHash: string | null = null;
      const invalid = entries.find((entry) => {
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
  };
}
