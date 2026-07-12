/** Bounded retention policy and scheduled/manual pruning orchestration. */
import { randomUUID } from "node:crypto";
import type { createStore } from "../../persistence/store";
import type { RetentionCutoffs } from "../../persistence/retention";

type Store = ReturnType<typeof createStore>;
type Trigger = "manual" | "scheduler";

export type RetentionPolicy = {
  policyVersion: "retention-policy-v1";
  strategySnapshotDays: number;
  orderBookDays: number;
  strategyMetricDays: number;
  spanDays: number;
  providerEvidenceDays: number;
  failedResearchDays: number;
  staleRunningResearchHours: number;
  batchLimit: number;
};

export type RetentionRun = {
  schemaVersion: "retention-run-v1";
  runId: string;
  trigger: Trigger;
  actor: string;
  startedAt: string;
  completedAt: string;
  policy: RetentionPolicy;
  cutoffs: RetentionCutoffs;
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
  remainingEligible: ReturnType<Store["retentionInventory"]>;
};

const DAY_MS = 86_400_000;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

export function retentionPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RetentionPolicy {
  return {
    policyVersion: "retention-policy-v1",
    strategySnapshotDays: boundedInteger(
      env.RETENTION_STRATEGY_SNAPSHOT_DAYS,
      30,
      1,
      3_650,
      "RETENTION_STRATEGY_SNAPSHOT_DAYS",
    ),
    orderBookDays: boundedInteger(
      env.RETENTION_ORDER_BOOK_DAYS,
      90,
      1,
      3_650,
      "RETENTION_ORDER_BOOK_DAYS",
    ),
    strategyMetricDays: boundedInteger(
      env.RETENTION_STRATEGY_METRIC_DAYS,
      90,
      1,
      3_650,
      "RETENTION_STRATEGY_METRIC_DAYS",
    ),
    spanDays: boundedInteger(
      env.RETENTION_SPAN_DAYS,
      30,
      1,
      365,
      "RETENTION_SPAN_DAYS",
    ),
    providerEvidenceDays: boundedInteger(
      env.RETENTION_PROVIDER_EVIDENCE_DAYS,
      365,
      30,
      3_650,
      "RETENTION_PROVIDER_EVIDENCE_DAYS",
    ),
    failedResearchDays: boundedInteger(
      env.RETENTION_FAILED_RESEARCH_DAYS,
      30,
      1,
      365,
      "RETENTION_FAILED_RESEARCH_DAYS",
    ),
    staleRunningResearchHours: boundedInteger(
      env.RETENTION_STALE_RUNNING_RESEARCH_HOURS,
      24,
      1,
      720,
      "RETENTION_STALE_RUNNING_RESEARCH_HOURS",
    ),
    batchLimit: boundedInteger(
      env.RETENTION_BATCH_LIMIT,
      5_000,
      100,
      10_000,
      "RETENTION_BATCH_LIMIT",
    ),
  };
}

export function retentionCutoffs(
  policy: RetentionPolicy,
  now: Date,
): RetentionCutoffs {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new Error("Retention run time is invalid");
  const beforeDays = (days: number) =>
    new Date(at - days * DAY_MS).toISOString();
  return {
    strategySnapshotsBefore: beforeDays(policy.strategySnapshotDays),
    orderBooksBefore: beforeDays(policy.orderBookDays),
    strategyMetricsBefore: beforeDays(policy.strategyMetricDays),
    spansBefore: beforeDays(policy.spanDays),
    providerEvidenceBefore: beforeDays(policy.providerEvidenceDays),
    failedResearchBefore: beforeDays(policy.failedResearchDays),
    staleRunningResearchBefore: new Date(
      at - policy.staleRunningResearchHours * 60 * 60_000,
    ).toISOString(),
    batchLimit: policy.batchLimit,
  };
}

export function retentionReport(
  store: Store,
  policy: RetentionPolicy,
  now = new Date(),
) {
  const cutoffs = retentionCutoffs(policy, now);
  return {
    reportVersion: "retention-report-v1" as const,
    generatedAt: now.toISOString(),
    policy,
    cutoffs,
    inventory: store.retentionInventory(cutoffs),
    latest:
      store.events(1, "operations.retention.completed")[0]?.payload ?? null,
    evidence: {
      completedRuns: store.events(1_000, "operations.retention.completed").length,
      failedRuns: store.events(1_000, "operations.retention.failed").length,
    },
    protections: [
      "Decision-linked strategy snapshots retain normalized evidence; aged raw order-book depth is replaced by an explicit hash-bound pruning record.",
      "The newest snapshot per symbol remains available for shadow, paper, and paused runs.",
      "The newest metric per run and metric name is retained.",
      "A historical valuation parent remains while a retained scenario child references it.",
      "Decision and strategy audit chains, orders, receipts, notes, backtests, and immutable bar datasets are outside automatic pruning.",
    ],
  };
}

export function createRetentionService({
  store,
  policy,
  now = () => new Date(),
}: {
  store: Store;
  policy: RetentionPolicy;
  now?: () => Date;
}) {
  let activeRun: Promise<RetentionRun> | null = null;

  async function execute(trigger: Trigger, actor: string) {
    const startedAt = now();
    const startedAtIso = startedAt.toISOString();
    const runId = randomUUID();
    try {
      const cutoffs = retentionCutoffs(policy, startedAt);
      const result = store.pruneRetention(cutoffs, startedAtIso);
      const completedAt = now().toISOString();
      const run: RetentionRun = {
        schemaVersion: "retention-run-v1",
        runId,
        trigger,
        actor,
        startedAt: startedAtIso,
        completedAt,
        policy,
        cutoffs,
        ...result,
      };
      store.event("operations.retention.completed", actor, run);
      return run;
    } catch (error) {
      store.event("operations.retention.failed", actor, {
        schemaVersion: "retention-failure-v1",
        runId,
        trigger,
        startedAt: startedAtIso,
        failedAt: now().toISOString(),
        reason: "retention_pruning_failed",
      });
      throw error;
    }
  }

  return {
    run(trigger: Trigger, actor: string) {
      activeRun ??= execute(trigger, actor).finally(() => {
        activeRun = null;
      });
      return activeRun;
    },
    report() {
      return retentionReport(store, policy, now());
    },
  };
}
