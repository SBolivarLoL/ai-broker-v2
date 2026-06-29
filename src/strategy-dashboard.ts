import type { StrategyDecisionKind, StrategyRunStatus } from "./store";
import { strategyPaperState } from "./strategy-paper";

type StrategyRunDashboardInput = {
  id: string;
  strategyId: string;
  strategyVersion: string;
  status: StrategyRunStatus;
  configHash: string;
  policyVersion: string;
  symbols: string[];
  budget: number;
  config: any;
  createdAt: string;
  updatedAt: string;
};
type StrategyDashboardDecision = {
  id: string;
  traceId: string;
  symbol: string;
  decision: StrategyDecisionKind;
  reason: string;
  riskChecks: any;
  targetPosition: number | null;
  orderOutcome?: string;
  createdAt: string;
};
type StrategyDashboardTrace = StrategyDashboardDecision & {
  snapshots: { id: string; symbol: string; stale: boolean; latencyMs?: number | null; observedAt: string }[];
};
type StrategyDashboardOrder = {
  id: string;
  paperOrderId: string;
  status: string;
  payload: any;
  createdAt: string;
  updatedAt: string;
};

const countBy = <T>(values: T[], key: (value: T) => string | null | undefined) => values.reduce<Record<string, number>>((counts, value) => {
  const item = key(value);
  if (item) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}, {});

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const finiteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const latestIso = (values: (string | null | undefined)[]) => values
  .map(value => value ? Date.parse(value) : NaN)
  .filter(Number.isFinite)
  .sort((a, b) => b - a)[0];

function blockReasons(decision: StrategyDashboardDecision) {
  return Array.isArray(decision.riskChecks?.reasons) ? decision.riskChecks.reasons.map(String) : [];
}

function fillQualitySample(order: StrategyDashboardOrder) {
  const payload = order.payload ?? {};
  const broker = payload.broker ?? {};
  const referencePrice = finiteNumber(payload.referencePrice);
  const filledAvgPrice = finiteNumber(broker.filledAvgPrice ?? payload.filledAvgPrice);
  const side = String(payload.side ?? broker.side ?? "").toLowerCase();
  if (!referencePrice || !filledAvgPrice || !["buy", "sell"].includes(side)) return null;
  const slippageBps = side === "buy"
    ? (filledAvgPrice - referencePrice) / referencePrice * 10_000
    : (referencePrice - filledAvgPrice) / referencePrice * 10_000;
  return {
    paperOrderId: order.paperOrderId,
    side,
    referencePrice,
    filledAvgPrice,
    slippageBps,
    status: order.status,
  };
}

export function buildStrategyDashboard(input: {
  run: StrategyRunDashboardInput;
  decisions: StrategyDashboardDecision[];
  traces: StrategyDashboardTrace[];
  orders: StrategyDashboardOrder[];
  generatedAt?: string;
}) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const snapshots = input.traces.flatMap(trace => trace.snapshots ?? []);
  const staleSnapshotCount = snapshots.filter(snapshot => snapshot.stale).length;
  const reasons = input.decisions.flatMap(blockReasons);
  const paperState = strategyPaperState(input.orders);
  const approval = input.run.config?.paperApproval ?? null;
  const budget = finiteNumber(approval?.budget ?? input.run.budget);
  const maxPositionNotional = finiteNumber(approval?.maxPositionNotional);
  const orderStatuses = countBy(input.orders, order => order.status);
  const filledOrders = input.orders.filter(order => String(order.status) === "filled").length;
  const fillSamples = input.orders.map(fillQualitySample).filter((sample): sample is NonNullable<typeof sample> => Boolean(sample));
  const slippages = fillSamples.map(sample => sample.slippageBps);
  const latestDecisionMs = latestIso(input.decisions.map(decision => decision.createdAt));
  const latestOrderMs = latestIso(input.orders.map(order => order.updatedAt ?? order.createdAt));
  const staleDataRate = snapshots.length ? staleSnapshotCount / snapshots.length : null;
  const blockDecisionCount = input.decisions.filter(decision => decision.decision === "block").length;
  const warnings = [
    input.decisions.length ? null : "No strategy decisions have been recorded for this run yet.",
    snapshots.length ? null : "No persisted market-data snapshots are attached to this run yet.",
    input.run.status === "paper" && !approval ? "Run is marked paper but has no saved paper approval." : null,
    input.orders.length ? null : "No strategy paper orders have been submitted for this run yet.",
    fillSamples.length ? null : "No filled strategy paper orders have fill-quality evidence yet.",
  ].filter(Boolean) as string[];

  return {
    dashboardVersion: "strategy-dashboard-v1",
    generatedAt,
    run: {
      id: input.run.id,
      strategyId: input.run.strategyId,
      strategyVersion: input.run.strategyVersion,
      status: input.run.status,
      symbols: input.run.symbols,
      budget: input.run.budget,
      configHash: input.run.configHash,
      policyVersion: input.run.policyVersion,
      createdAt: input.run.createdAt,
      updatedAt: input.run.updatedAt,
    },
    dataCoverage: {
      decisionCount: input.decisions.length,
      snapshotCount: snapshots.length,
      staleSnapshotCount,
      staleDataRate,
      averageLatencyMs: average(snapshots.map(snapshot => finiteNumber(snapshot.latencyMs)).filter((value): value is number => value !== null)),
      latestDecisionAt: Number.isFinite(latestDecisionMs) ? new Date(latestDecisionMs).toISOString() : null,
      latestOrderAt: Number.isFinite(latestOrderMs) ? new Date(latestOrderMs).toISOString() : null,
    },
    decisions: {
      decisionCounts: countBy(input.decisions, decision => decision.decision),
      blockedDecisionCount: blockDecisionCount,
      blockedDecisionRate: input.decisions.length ? blockDecisionCount / input.decisions.length : null,
      blockReasons: countBy(reasons, reason => reason),
      orderOutcomes: countBy(input.decisions, decision => decision.orderOutcome ?? "none"),
    },
    exposure: {
      netNotional: paperState.netNotional,
      budget,
      maxPositionNotional,
      budgetUtilization: budget && budget > 0 ? paperState.netNotional / budget : null,
      maxPositionUtilization: maxPositionNotional && maxPositionNotional > 0 ? Math.abs(paperState.netNotional) / maxPositionNotional : null,
      targetPosition: input.decisions.find(decision => Number.isFinite(Number(decision.targetPosition)))?.targetPosition ?? null,
    },
    orderExecution: {
      submittedOrders: input.orders.length,
      filledOrders,
      fillRatio: input.orders.length ? filledOrders / input.orders.length : null,
      orderStatuses,
    },
    fillQuality: {
      sampleCount: fillSamples.length,
      averageSlippageBps: average(slippages),
      bestSlippageBps: slippages.length ? Math.min(...slippages) : null,
      worstSlippageBps: slippages.length ? Math.max(...slippages) : null,
      samples: fillSamples.slice(0, 10),
    },
    warnings,
  };
}
