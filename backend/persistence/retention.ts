/** Transactional retention repository for bounded high-volume evidence. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export type RetentionCutoffs = {
  strategySnapshotsBefore: string;
  orderBooksBefore: string;
  strategyMetricsBefore: string;
  spansBefore: string;
  providerEvidenceBefore: string;
  failedResearchBefore: string;
  staleRunningResearchBefore: string;
  batchLimit: number;
};

export type RetentionInventory = {
  strategySnapshots: {
    total: number;
    eligibleForDeletion: number;
    protectedByDecision: number;
    protectedActiveLatest: number;
    orderBooksEligibleForCompaction: number;
  };
  strategyMetrics: { total: number; eligibleForDeletion: number };
  spans: { total: number; eligibleForDeletion: number };
  providerEvidence: {
    totalResearchRuns: number;
    eligibleResearchRuns: number;
    protectedReplayParents: number;
    eligibleResearchEvents: number;
  };
};

export type RetentionPruneResult = {
  deleted: {
    strategySnapshots: number;
    strategyMetrics: number;
    spans: number;
    researchRuns: number;
    researchEvents: number;
  };
  compacted: {
    strategyOrderBooks: number;
    removedBytes: number;
    removedBidLevels: number;
    removedAskLevels: number;
  };
  remainingEligible: RetentionInventory;
};

const snapshotReference = `EXISTS (
  SELECT 1 FROM strategy_decisions decision, json_each(decision.data_snapshot_ids) reference
  WHERE json_valid(decision.data_snapshot_ids) AND CAST(reference.value AS TEXT) = snapshot.id
)`;

const activeLatestSnapshot = `EXISTS (
  SELECT 1 FROM strategy_runs run
  WHERE run.id = snapshot.run_id
    AND run.status IN ('shadow', 'paper', 'paused')
    AND snapshot.id = (
      SELECT newest.id FROM strategy_data_snapshots newest
      WHERE newest.run_id = snapshot.run_id AND newest.symbol = snapshot.symbol
      ORDER BY datetime(newest.created_at) DESC, newest.id DESC LIMIT 1
    )
)`;

const oldSnapshot = "datetime(snapshot.created_at) < datetime(?)";
const snapshotDeletion = `${oldSnapshot} AND NOT ${snapshotReference} AND NOT ${activeLatestSnapshot}`;

const oldMetric = `datetime(metric.created_at) < datetime(?) AND metric.rowid != (
  SELECT newest.rowid FROM strategy_metrics newest
  WHERE newest.run_id = metric.run_id AND newest.name = metric.name
  ORDER BY datetime(newest.as_of) DESC, datetime(newest.created_at) DESC, newest.rowid DESC LIMIT 1
)`;

const researchDeletion = `(
  (research.status = 'running' AND datetime(research.created_at) < datetime(?)) OR
  (research.status = 'failed' AND datetime(research.created_at) < datetime(?)) OR
  (
    research.status = 'completed' AND datetime(research.created_at) < datetime(?)
    AND NOT EXISTS (
      SELECT 1 FROM research_runs child
      WHERE child.status = 'completed'
        AND json_valid(child.payload)
        AND json_extract(child.payload, '$.parentRunId') = research.id
    )
  )
)`;

function count(db: Database, sql: string, ...params: any[]) {
  return Number((db.query(sql).get(...params) as { value: number }).value);
}

function placeholders(values: unknown[]) {
  return values.map(() => "?").join(",");
}

function deleteTextIds(
  db: Database,
  table: "strategy_data_snapshots" | "research_runs",
  ids: string[],
) {
  if (!ids.length) return 0;
  return db
    .query(`DELETE FROM ${table} WHERE id IN (${placeholders(ids)})`)
    .run(...ids).changes;
}

function deleteRowIds(
  db: Database,
  table: "strategy_metrics" | "events",
  ids: number[],
) {
  if (!ids.length) return 0;
  return db
    .query(`DELETE FROM ${table} WHERE rowid IN (${placeholders(ids)})`)
    .run(...ids).changes;
}

function orderBookLevels(value: unknown, side: "bid" | "ask") {
  if (!value || typeof value !== "object") return 0;
  const book = value as Record<string, unknown>;
  const rows =
    side === "bid"
      ? (book.b ?? book.bids ?? book.bid)
      : (book.a ?? book.asks ?? book.ask);
  return Array.isArray(rows) ? rows.length : 0;
}

function inventory(db: Database, cutoffs: RetentionCutoffs): RetentionInventory {
  const researchParams = [
    cutoffs.staleRunningResearchBefore,
    cutoffs.failedResearchBefore,
    cutoffs.providerEvidenceBefore,
  ];
  return {
    strategySnapshots: {
      total: count(db, "SELECT COUNT(*) AS value FROM strategy_data_snapshots"),
      eligibleForDeletion: count(
        db,
        `SELECT COUNT(*) AS value FROM strategy_data_snapshots snapshot WHERE ${snapshotDeletion}`,
        cutoffs.strategySnapshotsBefore,
      ),
      protectedByDecision: count(
        db,
        `SELECT COUNT(*) AS value FROM strategy_data_snapshots snapshot WHERE ${oldSnapshot} AND ${snapshotReference}`,
        cutoffs.strategySnapshotsBefore,
      ),
      protectedActiveLatest: count(
        db,
        `SELECT COUNT(*) AS value FROM strategy_data_snapshots snapshot WHERE ${oldSnapshot} AND NOT ${snapshotReference} AND ${activeLatestSnapshot}`,
        cutoffs.strategySnapshotsBefore,
      ),
      orderBooksEligibleForCompaction: count(
        db,
        `SELECT COUNT(*) AS value FROM strategy_data_snapshots snapshot
         WHERE datetime(snapshot.created_at) < datetime(?)
           AND json_valid(snapshot.payload)
           AND json_extract(snapshot.payload, '$.orderbook') IS NOT NULL`,
        cutoffs.orderBooksBefore,
      ),
    },
    strategyMetrics: {
      total: count(db, "SELECT COUNT(*) AS value FROM strategy_metrics"),
      eligibleForDeletion: count(
        db,
        `SELECT COUNT(*) AS value FROM strategy_metrics metric WHERE ${oldMetric}`,
        cutoffs.strategyMetricsBefore,
      ),
    },
    spans: {
      total: count(
        db,
        "SELECT COUNT(*) AS value FROM events WHERE type = 'otel.span'",
      ),
      eligibleForDeletion: count(
        db,
        "SELECT COUNT(*) AS value FROM events WHERE type = 'otel.span' AND datetime(created_at) < datetime(?)",
        cutoffs.spansBefore,
      ),
    },
    providerEvidence: {
      totalResearchRuns: count(db, "SELECT COUNT(*) AS value FROM research_runs"),
      eligibleResearchRuns: count(
        db,
        `SELECT COUNT(*) AS value FROM research_runs research WHERE ${researchDeletion}`,
        ...researchParams,
      ),
      protectedReplayParents: count(
        db,
        `SELECT COUNT(*) AS value FROM research_runs research
         WHERE research.status = 'completed' AND datetime(research.created_at) < datetime(?)
           AND EXISTS (
             SELECT 1 FROM research_runs child
             WHERE child.status = 'completed' AND json_valid(child.payload)
               AND json_extract(child.payload, '$.parentRunId') = research.id
           )`,
        cutoffs.providerEvidenceBefore,
      ),
      eligibleResearchEvents: count(
        db,
        "SELECT COUNT(*) AS value FROM events WHERE type LIKE 'research.%' AND datetime(created_at) < datetime(?)",
        cutoffs.providerEvidenceBefore,
      ),
    },
  };
}

export function createRetentionRepository(db: Database) {
  const prune = db.transaction(
    (cutoffs: RetentionCutoffs, compactedAt: string): RetentionPruneResult => {
      const invalidDecisionReferences = count(
        db,
        "SELECT COUNT(*) AS value FROM strategy_decisions WHERE NOT json_valid(data_snapshot_ids)",
      );
      if (invalidDecisionReferences)
        throw new Error("Strategy snapshot references are malformed");
      const invalidSnapshots = count(
        db,
        `SELECT COUNT(*) AS value FROM strategy_data_snapshots snapshot
         WHERE datetime(snapshot.created_at) < datetime(?) AND NOT json_valid(snapshot.payload)`,
        cutoffs.orderBooksBefore,
      );
      if (invalidSnapshots)
        throw new Error("Strategy snapshot payloads are malformed");
      const invalidScenarioParents = count(
        db,
        `SELECT COUNT(*) AS value FROM research_runs
         WHERE model = 'deterministic-valuation-scenarios-v3'
           AND payload IS NOT NULL AND NOT json_valid(payload)`,
      );
      if (invalidScenarioParents)
        throw new Error("Research replay lineage is malformed");

      const snapshotIds = (
        db
          .query(
            `SELECT snapshot.id FROM strategy_data_snapshots snapshot
             WHERE ${snapshotDeletion}
             ORDER BY datetime(snapshot.created_at), snapshot.id LIMIT ?`,
          )
          .all(cutoffs.strategySnapshotsBefore, cutoffs.batchLimit) as Array<{
          id: string;
        }>
      ).map((row) => row.id);
      const deletedSnapshots = deleteTextIds(
        db,
        "strategy_data_snapshots",
        snapshotIds,
      );

      const books = db
        .query(
          `SELECT id, payload FROM strategy_data_snapshots
           WHERE datetime(created_at) < datetime(?) AND json_valid(payload)
             AND json_extract(payload, '$.orderbook') IS NOT NULL
           ORDER BY datetime(created_at), id LIMIT ?`,
        )
        .all(cutoffs.orderBooksBefore, cutoffs.batchLimit) as Array<{
        id: string;
        payload: string;
      }>;
      let removedBytes = 0,
        removedBidLevels = 0,
        removedAskLevels = 0;
      for (const row of books) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        const orderbook = payload.orderbook;
        const orderbookJson = JSON.stringify(orderbook);
        const bidLevels = orderBookLevels(orderbook, "bid");
        const askLevels = orderBookLevels(orderbook, "ask");
        const bytes = new TextEncoder().encode(orderbookJson).length;
        const originalPayloadHash = `sha256:${createHash("sha256")
          .update(row.payload)
          .digest("hex")}`;
        payload.orderbook = null;
        const existingRetention =
          payload.retention &&
          typeof payload.retention === "object" &&
          !Array.isArray(payload.retention)
            ? (payload.retention as Record<string, unknown>)
            : {};
        payload.retention = {
          ...existingRetention,
          schemaVersion: "strategy-snapshot-retention-v1",
          orderBook: {
            status: "pruned",
            prunedAt: compactedAt,
            originalPayloadHash,
            removedBytes: bytes,
            removedBidLevels: bidLevels,
            removedAskLevels: askLevels,
          },
        };
        db.query("UPDATE strategy_data_snapshots SET payload = ? WHERE id = ?").run(
          JSON.stringify(payload),
          row.id,
        );
        removedBytes += bytes;
        removedBidLevels += bidLevels;
        removedAskLevels += askLevels;
      }

      const metricIds = (
        db
          .query(
            `SELECT metric.rowid AS id FROM strategy_metrics metric
             WHERE ${oldMetric}
             ORDER BY datetime(metric.created_at), metric.rowid LIMIT ?`,
          )
          .all(cutoffs.strategyMetricsBefore, cutoffs.batchLimit) as Array<{
          id: number;
        }>
      ).map((row) => row.id);
      const deletedMetrics = deleteRowIds(
        db,
        "strategy_metrics",
        metricIds,
      );

      const spanIds = (
        db
          .query(
            `SELECT rowid AS id FROM events WHERE type = 'otel.span'
             AND datetime(created_at) < datetime(?) ORDER BY datetime(created_at), rowid LIMIT ?`,
          )
          .all(cutoffs.spansBefore, cutoffs.batchLimit) as Array<{ id: number }>
      ).map((row) => row.id);
      const deletedSpans = deleteRowIds(db, "events", spanIds);

      const researchParams = [
        cutoffs.staleRunningResearchBefore,
        cutoffs.failedResearchBefore,
        cutoffs.providerEvidenceBefore,
      ];
      const researchIds = (
        db
          .query(
            `SELECT research.id FROM research_runs research WHERE ${researchDeletion}
             ORDER BY datetime(research.created_at), research.id LIMIT ?`,
          )
          .all(...researchParams, cutoffs.batchLimit) as Array<{ id: string }>
      ).map((row) => row.id);
      const deletedResearchRuns = deleteTextIds(db, "research_runs", researchIds);

      const researchEventIds = (
        db
          .query(
            `SELECT rowid AS id FROM events WHERE type LIKE 'research.%'
             AND datetime(created_at) < datetime(?) ORDER BY datetime(created_at), rowid LIMIT ?`,
          )
          .all(cutoffs.providerEvidenceBefore, cutoffs.batchLimit) as Array<{
          id: number;
        }>
      ).map((row) => row.id);
      const deletedResearchEvents = deleteRowIds(
        db,
        "events",
        researchEventIds,
      );

      return {
        deleted: {
          strategySnapshots: deletedSnapshots,
          strategyMetrics: deletedMetrics,
          spans: deletedSpans,
          researchRuns: deletedResearchRuns,
          researchEvents: deletedResearchEvents,
        },
        compacted: {
          strategyOrderBooks: books.length,
          removedBytes,
          removedBidLevels,
          removedAskLevels,
        },
        remainingEligible: inventory(db, cutoffs),
      };
    },
  );

  return {
    retentionInventory(cutoffs: RetentionCutoffs) {
      return inventory(db, cutoffs);
    },
    pruneRetention(cutoffs: RetentionCutoffs, compactedAt: string) {
      return prune(cutoffs, compactedAt);
    },
  };
}
