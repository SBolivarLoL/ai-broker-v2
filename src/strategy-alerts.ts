import type { StrategyDecisionKind, StrategyRunStatus } from "./store";

export type StrategyAlertSeverity = "info" | "warning" | "critical";
export type StrategyAlert = {
  id: string;
  runId: string;
  severity: StrategyAlertSeverity;
  code: string;
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  createdAt: string;
};

type AlertRun = {
  id: string;
  strategyId: string;
  status: StrategyRunStatus;
  symbols: string[];
  budget: number;
  config?: any;
};
type AlertDecision = {
  traceId: string;
  decision: StrategyDecisionKind;
  reason: string;
  riskChecks: any;
  orderOutcome?: string | null;
  createdAt: string;
};
type AlertTrace = {
  traceId: string;
  snapshots?: { stale: boolean; observedAt?: string | null; latencyMs?: number | null }[];
};
type AlertOrder = {
  paperOrderId: string;
  status: string;
  payload: any;
  createdAt: string;
  updatedAt: string;
};
type AlertMetric = { name: string; value: number; unit: string; asOf: string };

export type StrategyAlertConfig = {
  staleDataRate?: number;
  drawdownPercent?: number;
  dailyTurnoverPercent?: number;
  slippageBps?: number;
  repeatedSlippageCount?: number;
  reconciliationAgeMs?: number;
};

const workingStatuses = new Set(["new", "accepted", "pending_new", "pending_replace", "accepted_for_bidding", "partially_filled", "held", "calculated", "stopped"]);

const finiteNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const parseTime = (value: unknown) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const metricValues = (metrics: AlertMetric[], name: string) => metrics.filter(metric => metric.name === name).map(metric => finiteNumber(metric.value)).filter((value): value is number => value !== null);
const latestMetric = (metrics: AlertMetric[], name: string) => metrics.filter(metric => metric.name === name).sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf))[0] ?? null;

function alert(input: Omit<StrategyAlert, "id">) {
  const key = JSON.stringify(input.evidence);
  return { ...input, id: `${input.runId}:${input.code}:${Math.abs(hashCode(key)).toString(36)}` };
}

function hashCode(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return hash;
}

function decisionReasons(decision: AlertDecision) {
  return Array.isArray(decision.riskChecks?.reasons) ? decision.riskChecks.reasons.map(String) : [];
}

function orderNotional(order: AlertOrder) {
  const payload = order.payload ?? {};
  const direct = finiteNumber(payload.notional);
  if (direct !== null) return direct;
  const qty = finiteNumber(payload.qty ?? payload.broker?.qty);
  const price = finiteNumber(payload.referencePrice ?? payload.broker?.filledAvgPrice ?? payload.broker?.limitPrice);
  return qty !== null && price !== null ? qty * price : null;
}

function orderSlippageBps(order: AlertOrder) {
  const payload = order.payload ?? {};
  const broker = payload.broker ?? {};
  const referencePrice = finiteNumber(payload.referencePrice);
  const filledAvgPrice = finiteNumber(broker.filledAvgPrice ?? payload.filledAvgPrice);
  const side = String(payload.side ?? broker.side ?? "").toLowerCase();
  if (referencePrice === null || filledAvgPrice === null || referencePrice <= 0 || !["buy", "sell"].includes(side)) return null;
  return side === "buy" ? (filledAvgPrice - referencePrice) / referencePrice * 10_000 : (referencePrice - filledAvgPrice) / referencePrice * 10_000;
}

function alertThresholds(run: AlertRun, config: StrategyAlertConfig) {
  const saved = run.config?.alerts ?? {};
  return {
    staleDataRate: finiteNumber(config.staleDataRate ?? saved.staleDataRate) ?? 0.25,
    drawdownPercent: finiteNumber(config.drawdownPercent ?? saved.drawdownPercent) ?? 10,
    dailyTurnoverPercent: finiteNumber(config.dailyTurnoverPercent ?? saved.dailyTurnoverPercent) ?? 50,
    slippageBps: finiteNumber(config.slippageBps ?? saved.slippageBps) ?? 50,
    repeatedSlippageCount: Math.max(1, Math.floor(finiteNumber(config.repeatedSlippageCount ?? saved.repeatedSlippageCount) ?? 2)),
    reconciliationAgeMs: finiteNumber(config.reconciliationAgeMs ?? saved.reconciliationAgeMs) ?? 15 * 60_000,
  };
}

export function buildStrategyAlerts(input: {
  run: AlertRun;
  decisions?: AlertDecision[];
  traces?: AlertTrace[];
  orders?: AlertOrder[];
  metrics?: AlertMetric[];
  performance?: any;
  config?: StrategyAlertConfig;
  generatedAt?: string;
}) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const nowMs = parseTime(generatedAt) ?? Date.now();
  const decisions = input.decisions ?? [];
  const traces = input.traces ?? [];
  const orders = input.orders ?? [];
  const metrics = input.metrics ?? [];
  const thresholds = alertThresholds(input.run, input.config ?? {});
  const alerts: StrategyAlert[] = [];

  const snapshots = traces.flatMap(trace => trace.snapshots ?? []);
  const staleSnapshotRateFromTraces = snapshots.length ? snapshots.filter(snapshot => snapshot.stale).length / snapshots.length : null;
  const latestStaleMetric = latestMetric(metrics, "strategy_stale_data_rate");
  const staleDataRate = finiteNumber(latestStaleMetric?.value) ?? staleSnapshotRateFromTraces ?? 0;
  const staleDecisionCount = decisions.filter(decision => decisionReasons(decision).includes("stale_data")).length;
  if (staleDataRate >= thresholds.staleDataRate || staleDecisionCount > 0) {
    alerts.push(alert({
      runId: input.run.id,
      severity: staleDataRate >= thresholds.staleDataRate * 2 ? "critical" : "warning",
      code: "stale_feed",
      title: "Stale market data",
      message: "Strategy decisions have stale crypto market-data evidence.",
      evidence: { staleDataRate, threshold: thresholds.staleDataRate, staleDecisionCount, snapshotCount: snapshots.length },
      createdAt: generatedAt,
    }));
  }

  const errorCount = metricValues(metrics, "strategy_error_count").reduce((sum, value) => sum + value, 0);
  if (errorCount > 0) {
    alerts.push(alert({
      runId: input.run.id,
      severity: "critical",
      code: "strategy_exception",
      title: "Strategy exception",
      message: "The scheduler, reconciliation or strategy runtime recorded errors for this run.",
      evidence: { errorCount },
      createdAt: generatedAt,
    }));
  }

  const rejectedOrders = orders.filter(order => String(order.status) === "rejected");
  const rejectedDecisionCount = decisions.filter(decision => decision.orderOutcome === "rejected" || decisionReasons(decision).includes("broker_order_rejected")).length;
  if (rejectedOrders.length || rejectedDecisionCount) {
    alerts.push(alert({
      runId: input.run.id,
      severity: "critical",
      code: "rejected_order",
      title: "Rejected paper order",
      message: "A strategy paper order was rejected or a decision was blocked by broker rejection.",
      evidence: { rejectedOrders: rejectedOrders.map(order => order.paperOrderId), rejectedDecisionCount },
      createdAt: generatedAt,
    }));
  }

  const drawdown = finiteNumber(input.performance?.summary?.maxDrawdownPercent) ?? finiteNumber(latestMetric(metrics, "strategy_active_drawdown_percent")?.value);
  if (drawdown !== null && drawdown >= thresholds.drawdownPercent) {
    alerts.push(alert({
      runId: input.run.id,
      severity: drawdown >= thresholds.drawdownPercent * 2 ? "critical" : "warning",
      code: "drawdown_breach",
      title: "Drawdown breach",
      message: "Active-run drawdown exceeded the configured strategy alert threshold.",
      evidence: { drawdownPercent: drawdown, threshold: thresholds.drawdownPercent },
      createdAt: generatedAt,
    }));
  }

  const budget = finiteNumber(input.run.config?.paperApproval?.budget ?? input.run.budget);
  const turnoverOrders = orders.filter(order => {
    const time = parseTime(order.createdAt);
    return time !== null && nowMs - time <= 24 * 60 * 60_000;
  });
  const turnoverNotional = turnoverOrders.map(orderNotional).filter((value): value is number => value !== null).reduce((sum, value) => sum + value, 0);
  const turnoverPercent = budget && budget > 0 ? turnoverNotional / budget * 100 : null;
  if (turnoverPercent !== null && turnoverPercent >= thresholds.dailyTurnoverPercent) {
    alerts.push(alert({
      runId: input.run.id,
      severity: turnoverPercent >= thresholds.dailyTurnoverPercent * 2 ? "critical" : "warning",
      code: "runaway_turnover",
      title: "Runaway turnover",
      message: "Strategy paper orders over the last 24 hours exceeded the turnover alert threshold.",
      evidence: { turnoverPercent, threshold: thresholds.dailyTurnoverPercent, orderCount: turnoverOrders.length, turnoverNotional, budget },
      createdAt: generatedAt,
    }));
  }

  const slippages = orders.map(order => ({ order, slippageBps: orderSlippageBps(order) })).filter(item => item.slippageBps !== null) as { order: AlertOrder; slippageBps: number }[];
  const poorSlippage = slippages.filter(item => item.slippageBps >= thresholds.slippageBps);
  if (poorSlippage.length >= thresholds.repeatedSlippageCount) {
    const average = poorSlippage.reduce((sum, item) => sum + item.slippageBps, 0) / poorSlippage.length;
    alerts.push(alert({
      runId: input.run.id,
      severity: average >= thresholds.slippageBps * 2 ? "critical" : "warning",
      code: "repeated_slippage",
      title: "Repeated slippage warning",
      message: "Multiple filled strategy paper orders show side-adjusted slippage above the alert threshold.",
      evidence: { count: poorSlippage.length, threshold: thresholds.slippageBps, averageSlippageBps: average, paperOrderIds: poorSlippage.map(item => item.order.paperOrderId) },
      createdAt: generatedAt,
    }));
  }

  const driftOrders = orders.filter(order => {
    const brokerStatus = order.payload?.broker?.status;
    if (brokerStatus && String(brokerStatus) !== String(order.status)) return true;
    const lastReconciledAt = parseTime(order.payload?.brokerReconciledAt ?? order.updatedAt);
    return workingStatuses.has(String(order.status)) && lastReconciledAt !== null && nowMs - lastReconciledAt > thresholds.reconciliationAgeMs;
  });
  if (driftOrders.length) {
    alerts.push(alert({
      runId: input.run.id,
      severity: "warning",
      code: "reconciliation_drift",
      title: "Reconciliation drift",
      message: "Strategy paper order state is stale or disagrees with the last broker payload.",
      evidence: { paperOrderIds: driftOrders.map(order => order.paperOrderId), thresholdMs: thresholds.reconciliationAgeMs },
      createdAt: generatedAt,
    }));
  }

  return {
    alertVersion: "strategy-alerts-v1",
    generatedAt,
    thresholds,
    alerts: alerts.sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 };
      return rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code);
    }),
  };
}
