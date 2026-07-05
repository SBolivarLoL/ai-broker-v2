import type { StrategyDecisionKind, StrategyRunStatus } from "./store";
import type { StrategyProvenance } from "./strategy-provenance";

type StrategyRunReportInput = {
  id: string;
  backtestId?: string | null;
  strategyId: string;
  strategyVersion: string;
  status: StrategyRunStatus;
  configHash: string;
  policyVersion: string;
  symbols: string[];
  budget: number;
  config: any;
  notes?: string | null;
  provenance?: StrategyProvenance | null;
  comparable?: boolean;
  createdAt: string;
  updatedAt: string;
};
type StrategyDecisionReportInput = {
  id: string;
  traceId: string;
  symbol: string;
  decision: StrategyDecisionKind;
  reason: string;
  riskChecks: any;
  targetPosition: number | null;
  rawSignal: number | null;
  riskAdjustedSignal: number | null;
  orderOutcome?: string;
  provenance?: StrategyProvenance | null;
  comparable?: boolean;
  createdAt: string;
};
type StrategyTraceReportInput = StrategyDecisionReportInput & {
  features: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  snapshots: { id: string; symbol: string; source: string; feed: string; stale: boolean; observedAt: string; datasetHash?: string | null }[];
};

const countBy = <T>(values: T[], key: (value: T) => string | null | undefined) => values.reduce<Record<string, number>>((counts, value) => {
  const item = key(value);
  if (item) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}, {});

const unique = (values: (string | null | undefined)[]) => [...new Set(values.filter(Boolean) as string[])].sort();

export function buildStrategyExperimentReport(input: {
  run: StrategyRunReportInput;
  decisions: StrategyDecisionReportInput[];
  traces: StrategyTraceReportInput[];
  orders: { id: string; paperOrderId: string; status: string; payload: any; createdAt: string; updatedAt: string }[];
  metrics: { name: string; value: number; unit: string; asOf: string }[];
  notes: { actor: string; note: string; createdAt: string }[];
  attribution?: unknown;
  performance?: unknown;
  executionReplay?: unknown;
  auditTrail?: unknown;
  auditVerification?: unknown;
  generatedAt?: string;
}) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const snapshots = input.traces.flatMap(trace => trace.snapshots ?? []);
  const blockReasons = input.decisions.flatMap(decision => Array.isArray(decision.riskChecks?.reasons) ? decision.riskChecks.reasons.map(String) : []);
  const notableDecisions = input.decisions
    .filter(decision => decision.decision === "block" || decision.orderOutcome && decision.orderOutcome !== "none")
    .slice(0, 25)
    .map(decision => ({
      traceId: decision.traceId,
      symbol: decision.symbol,
      decision: decision.decision,
      reason: decision.reason,
      orderOutcome: decision.orderOutcome ?? "none",
      riskReasons: Array.isArray(decision.riskChecks?.reasons) ? decision.riskChecks.reasons.map(String) : [],
      createdAt: decision.createdAt,
    }));
  const firstDecisionAt = input.decisions.at(-1)?.createdAt ?? null;
  const lastDecisionAt = input.decisions[0]?.createdAt ?? null;
  const submittedOrders = input.orders.filter(order => !["rejected", "canceled", "expired"].includes(String(order.status))).length;
  const filledOrders = input.orders.filter(order => String(order.status) === "filled").length;

  return {
    reportVersion: "strategy-experiment-v1",
    generatedAt,
    run: {
      id: input.run.id,
      backtestId: input.run.backtestId ?? null,
      strategyId: input.run.strategyId,
      strategyVersion: input.run.strategyVersion,
      status: input.run.status,
      symbols: input.run.symbols,
      configHash: input.run.configHash,
      policyVersion: input.run.policyVersion,
      budget: input.run.budget,
      createdAt: input.run.createdAt,
      updatedAt: input.run.updatedAt,
      comparable: input.run.comparable ?? false,
    },
    provenance: {
      run: input.run.provenance ?? null,
      decisionDatasetHashes: unique(input.decisions.map(decision => decision.provenance?.datasetHash)),
      snapshotDatasetHashes: unique(snapshots.map(snapshot => snapshot.datasetHash)),
    },
    config: input.run.config,
    assumptions: {
      executionMode: input.run.status === "paper" ? "paper" : "shadow",
      paperApproval: input.run.config?.paperApproval ?? null,
      schedule: input.run.config?.schedule ?? null,
      notes: "Backtests use close-price execution; paper strategy orders use bounded Alpaca paper crypto market orders when approved.",
    },
    dataCoverage: {
      decisionCount: input.decisions.length,
      firstDecisionAt,
      lastDecisionAt,
      snapshotCount: snapshots.length,
      staleSnapshotCount: snapshots.filter(snapshot => snapshot.stale).length,
      symbols: unique([...input.run.symbols, ...snapshots.map(snapshot => snapshot.symbol)]),
      sources: unique(snapshots.map(snapshot => snapshot.source)),
      feeds: unique(snapshots.map(snapshot => snapshot.feed)),
    },
    metrics: {
      decisionCounts: countBy(input.decisions, decision => decision.decision),
      orderOutcomes: countBy(input.decisions, decision => decision.orderOutcome ?? "none"),
      blockReasons: countBy(blockReasons, reason => reason),
      submittedOrders,
      filledOrders,
      fillRatio: submittedOrders ? filledOrders / submittedOrders : null,
      storedMetrics: input.metrics,
    },
    orders: input.orders.map(order => ({
      id: order.id,
      paperOrderId: order.paperOrderId,
      status: order.status,
      side: order.payload?.side ?? null,
      notional: order.payload?.notional ?? null,
      qty: order.payload?.qty ?? null,
      timeInForce: order.payload?.timeInForce ?? null,
      referencePrice: order.payload?.referencePrice ?? null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    })),
    notableDecisions,
    reasonCodedFailures: countBy(blockReasons, reason => reason),
    postFillAttribution: input.attribution ?? null,
    paperRunExecutionReplay: input.executionReplay ?? (input.attribution && typeof input.attribution === "object" ? (input.attribution as any).executionReplay ?? null : null),
    activeRunPerformance: input.performance ?? null,
    auditTrail: input.auditTrail ?? [],
    auditVerification: input.auditVerification ?? null,
    reviews: Array.isArray(input.run.config?.reviewHistory) ? input.run.config.reviewHistory : [],
    notes: input.notes,
  };
}
