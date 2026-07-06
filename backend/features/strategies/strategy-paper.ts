/**
 * Converts target exposure into bounded paper orders and enforces the approval,
 * budget, loss, drawdown, turnover, spread, and cooldown policy.
 */
import { validDate } from "../../shared/values";

export type StrategyPaperApproval = {
  approvedAt: string;
  approvedBy: string;
  expiresAt: string;
  budget: number;
  maxPositionNotional: number;
  maxOrderNotional: number;
  minOrderNotional: number;
  maxSpreadBps: number;
  timeInForce: "gtc" | "ioc";
  riskPolicy: StrategyPaperRiskPolicy;
  experimentProtocol?: {
    version: number;
    protocolHash: string;
    startAt: string;
    stopAt: string;
    minimumObservations: number;
    maximumBudget: number;
    reviewCadenceDays: number;
  };
  killSwitch?: { activatedAt: string; reason: string };
};
export type StrategyPaperOrder = {
  symbol: string;
  side: "buy" | "sell";
  notional: number;
  qty: number;
  timeInForce: "gtc" | "ioc";
  type: "market";
  reason: string;
};
export type StrategyPaperRiskPolicy = {
  session: "crypto_24_7";
  requireCashAndBuyingPower: true;
  maxDailyLossPercent: number;
  maxDrawdownPercent: number;
  maxDailyTurnoverPercent: number;
  errorCooldownMinutes: number;
};
type StrategyPaperStoredOrder = {
  status: string;
  payload: any;
  createdAt?: string;
  updatedAt?: string;
};
type StrategyPaperStoredDecision = {
  createdAt?: string;
  riskChecks?: any;
  reason?: string;
};

const defaultRiskPolicy = (
  input: Record<string, unknown>,
): StrategyPaperRiskPolicy => ({
  session: "crypto_24_7",
  requireCashAndBuyingPower: true,
  maxDailyLossPercent: numberInRange(
    input.maxDailyLossPercent ?? 5,
    0.1,
    100,
    "Max daily loss percent",
  ),
  maxDrawdownPercent: numberInRange(
    input.maxDrawdownPercent ?? 10,
    0.1,
    100,
    "Max drawdown percent",
  ),
  maxDailyTurnoverPercent: numberInRange(
    input.maxDailyTurnoverPercent ?? 50,
    1,
    1_000,
    "Max daily turnover percent",
  ),
  errorCooldownMinutes: numberInRange(
    input.errorCooldownMinutes ?? 30,
    1,
    24 * 60,
    "Error cooldown minutes",
  ),
});

function numberInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    throw new Error(`${label} must be ${min} to ${max}`);
  return number;
}

export function parseStrategyPaperApproval(
  input: Record<string, unknown>,
  actor: string,
  now = new Date(),
): StrategyPaperApproval {
  const budget = numberInRange(input.budget, 1, 100_000, "Budget");
  const maxPositionNotional = numberInRange(
    input.maxPositionNotional ?? budget,
    1,
    budget,
    "Max position notional",
  );
  const maxOrderNotional = numberInRange(
    input.maxOrderNotional ?? maxPositionNotional,
    1,
    maxPositionNotional,
    "Max order notional",
  );
  const minOrderNotional = numberInRange(
    input.minOrderNotional ?? 5,
    1,
    maxOrderNotional,
    "Min order notional",
  );
  const maxSpreadBps = numberInRange(
    input.maxSpreadBps ?? 100,
    1,
    2_000,
    "Max spread bps",
  );
  const expiresHours = numberInRange(
    input.expiresHours ?? 24,
    1,
    24 * 30,
    "Approval expiry hours",
  );
  const timeInForce = input.timeInForce === "ioc" ? "ioc" : "gtc";
  return {
    approvedAt: now.toISOString(),
    approvedBy: actor,
    expiresAt: new Date(
      now.getTime() + expiresHours * 60 * 60_000,
    ).toISOString(),
    budget,
    maxPositionNotional,
    maxOrderNotional,
    minOrderNotional,
    maxSpreadBps,
    timeInForce,
    riskPolicy: defaultRiskPolicy(input),
  };
}

export function strategyPaperState(
  orders: { status: string; payload: unknown }[],
) {
  const active = new Set([
    "new",
    "accepted",
    "pending_new",
    "partially_filled",
    "filled",
  ]);
  return orders.reduce(
    (state, order) => {
      if (!active.has(String(order.status))) return state;
      const payload = order.payload as {
        side?: string;
        notional?: number;
        qty?: number;
        referencePrice?: number;
      };
      const notional = Number(
        payload.notional ??
          Number(payload.qty) * Number(payload.referencePrice),
      );
      if (!Number.isFinite(notional) || notional <= 0) return state;
      return {
        netNotional:
          state.netNotional + (payload.side === "sell" ? -notional : notional),
      };
    },
    { netNotional: 0 },
  );
}

export function draftStrategyPaperOrder(input: {
  approval: StrategyPaperApproval;
  symbol: string;
  targetExposure: number;
  currentNotional: number;
  referencePrice: number;
  spreadBps: number | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  if (input.approval.killSwitch) reasons.push("kill_switch");
  if (new Date(input.approval.expiresAt).getTime() <= now.getTime())
    reasons.push("approval_expired");
  const protocol = input.approval.experimentProtocol;
  if (protocol) {
    const start = new Date(protocol.startAt),
      stop = new Date(protocol.stopAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(stop.getTime()))
      reasons.push("protocol_window_invalid");
    else if (now.getTime() < start.getTime())
      reasons.push("protocol_not_started");
    else if (now.getTime() > stop.getTime())
      reasons.push("protocol_expired");
    if (input.approval.budget > protocol.maximumBudget)
      reasons.push("protocol_budget_limit");
  }
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0)
    reasons.push("invalid_reference_price");
  if (input.spreadBps === null || !Number.isFinite(input.spreadBps))
    reasons.push("spread_unavailable");
  else if (input.spreadBps > input.approval.maxSpreadBps)
    reasons.push("spread_limit");
  if (reasons.length) return { allowed: false, reasons, order: null };

  const targetExposure = Math.max(0, Math.min(1, Number(input.targetExposure)));
  const targetNotional = Math.min(
    input.approval.maxPositionNotional,
    input.approval.budget * targetExposure,
  );
  const currentNotional = Math.max(0, Number(input.currentNotional));
  const delta = targetNotional - currentNotional;
  if (Math.abs(delta) < input.approval.minOrderNotional)
    return { allowed: true, reasons: ["target_within_band"], order: null };

  const side = delta > 0 ? "buy" : "sell";
  const remainingBudget = Math.max(0, input.approval.budget - currentNotional);
  const notional =
    side === "buy"
      ? Math.min(delta, input.approval.maxOrderNotional, remainingBudget)
      : Math.min(
          Math.abs(delta),
          input.approval.maxOrderNotional,
          currentNotional,
        );
  if (notional < input.approval.minOrderNotional)
    return { allowed: true, reasons: ["order_below_minimum"], order: null };
  const order: StrategyPaperOrder = {
    symbol: input.symbol,
    side,
    notional,
    qty: notional / input.referencePrice,
    timeInForce: input.approval.timeInForce,
    type: "market",
    reason:
      side === "buy"
        ? "raise strategy exposure toward approved target"
        : "reduce strategy exposure toward approved target",
  };
  return { allowed: true, reasons: [], order };
}

export function strategyPaperApprovalActive(
  approval: StrategyPaperApproval | null | undefined,
  now = new Date(),
) {
  return Boolean(
    approval &&
    !approval.killSwitch &&
    new Date(approval.expiresAt).getTime() > now.getTime(),
  );
}

function orderNotional(order: StrategyPaperStoredOrder | StrategyPaperOrder) {
  const payload = "payload" in order ? (order.payload ?? {}) : order;
  const notional = Number(
    payload.notional ?? Number(payload.qty) * Number(payload.referencePrice),
  );
  return Number.isFinite(notional) && notional > 0 ? notional : null;
}

function recentOrders(orders: StrategyPaperStoredOrder[], now: Date) {
  const since = now.getTime() - 24 * 60 * 60_000;
  const active = new Set([
    "new",
    "accepted",
    "pending_new",
    "partially_filled",
    "filled",
  ]);
  return orders.filter((order) => {
    if (!active.has(String(order.status))) return false;
    const at = validDate(order.createdAt ?? order.updatedAt);
    return at && at.getTime() >= since && at.getTime() <= now.getTime();
  });
}

function latestDailyLoss(
  points: { timestamp?: string; equity?: number | null }[] | undefined,
  now: Date,
) {
  const usable = (points ?? [])
    .map((point) => {
      const at = validDate(point.timestamp);
      const equity = Number(point.equity);
      return at && Number.isFinite(equity) ? { at, equity } : null;
    })
    .filter((point): point is { at: Date; equity: number } => Boolean(point))
    .filter((point) => point.at.getTime() <= now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const current = usable.at(-1);
  if (!current) return null;
  const since = now.getTime() - 24 * 60 * 60_000;
  const start =
    usable.find((point) => point.at.getTime() >= since) ?? usable[0];
  return start ? Math.max(0, start.equity - current.equity) : null;
}

function hasRecentError(input: {
  orders: StrategyPaperStoredOrder[];
  decisions: StrategyPaperStoredDecision[];
  now: Date;
  cooldownMinutes: number;
}) {
  const since = input.now.getTime() - input.cooldownMinutes * 60_000;
  const rejectedOrder = input.orders.find((order) => {
    if (String(order.status).toLowerCase() !== "rejected") return false;
    const at = validDate(order.updatedAt ?? order.createdAt);
    return at && at.getTime() >= since && at.getTime() <= input.now.getTime();
  });
  if (rejectedOrder) return true;
  return input.decisions.some((decision) => {
    const at = validDate(decision.createdAt);
    if (!at || at.getTime() < since || at.getTime() > input.now.getTime())
      return false;
    const reasons = Array.isArray(decision.riskChecks?.reasons)
      ? decision.riskChecks.reasons.map(String)
      : [];
    return (
      Boolean(decision.riskChecks?.paper?.orderError) ||
      reasons.includes("broker_order_rejected") ||
      /broker|error|rejected/i.test(String(decision.reason ?? ""))
    );
  });
}

export function evaluateStrategyPaperRiskPolicy(input: {
  approval: StrategyPaperApproval;
  draftOrder: StrategyPaperOrder | null;
  account?: { cash?: unknown; buyingPower?: unknown } | null;
  orders?: StrategyPaperStoredOrder[];
  decisions?: StrategyPaperStoredDecision[];
  performance?: {
    summary?: { totalPnl?: unknown; maxDrawdownPercent?: unknown };
    points?: { timestamp?: string; equity?: number | null }[];
  } | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const policy = input.approval.riskPolicy ?? defaultRiskPolicy({});
  const reasons: string[] = [];
  const evidence: Record<string, unknown> = {
    session: { venue: policy.session, allowed: Number.isFinite(now.getTime()) },
    thresholds: policy,
  };
  if (!Number.isFinite(now.getTime())) reasons.push("invalid_session_time");
  if (!input.draftOrder)
    return { allowed: reasons.length === 0, reasons, evidence, policy };

  const cash = Number(input.account?.cash);
  const buyingPower = Number(input.account?.buyingPower);
  evidence.account = {
    cash: Number.isFinite(cash) ? cash : null,
    buyingPower: Number.isFinite(buyingPower) ? buyingPower : null,
  };
  if (!Number.isFinite(cash) || !Number.isFinite(buyingPower))
    reasons.push("account_data_unavailable");
  else if (input.draftOrder.side === "buy") {
    if (input.draftOrder.notional > Math.max(0, cash))
      reasons.push("cash_limit");
    if (input.draftOrder.notional > Math.max(0, buyingPower))
      reasons.push("buying_power_limit");
  }

  const orders = input.orders ?? [];
  const turnoverOrders = recentOrders(orders, now);
  const turnoverNotional =
    turnoverOrders
      .map(orderNotional)
      .filter((value): value is number => value !== null)
      .reduce((sum, value) => sum + value, 0) + input.draftOrder.notional;
  const turnoverPercent =
    input.approval.budget > 0
      ? (turnoverNotional / input.approval.budget) * 100
      : null;
  evidence.dailyTurnover = {
    turnoverNotional,
    turnoverPercent,
    orderCount: turnoverOrders.length + 1,
  };
  if (
    turnoverPercent !== null &&
    turnoverPercent > policy.maxDailyTurnoverPercent
  )
    reasons.push("daily_turnover_limit");

  const dailyLoss = latestDailyLoss(input.performance?.points, now);
  const fallbackLoss = Number(input.performance?.summary?.totalPnl);
  const lossNotional =
    dailyLoss ??
    (Number.isFinite(fallbackLoss) && fallbackLoss < 0
      ? Math.abs(fallbackLoss)
      : null);
  const lossPercent =
    lossNotional === null ? null : (lossNotional / input.approval.budget) * 100;
  evidence.dailyLoss = { lossNotional, lossPercent };
  if (
    input.draftOrder.side === "buy" &&
    lossPercent !== null &&
    lossPercent > policy.maxDailyLossPercent
  )
    reasons.push("daily_loss_limit");

  const drawdownPercent = Number(
    input.performance?.summary?.maxDrawdownPercent,
  );
  evidence.drawdown = {
    drawdownPercent: Number.isFinite(drawdownPercent) ? drawdownPercent : null,
  };
  if (
    input.draftOrder.side === "buy" &&
    Number.isFinite(drawdownPercent) &&
    drawdownPercent > policy.maxDrawdownPercent
  )
    reasons.push("drawdown_limit");

  if (
    hasRecentError({
      orders,
      decisions: input.decisions ?? [],
      now,
      cooldownMinutes: policy.errorCooldownMinutes,
    })
  )
    reasons.push("error_cooldown");

  return { allowed: reasons.length === 0, reasons, evidence, policy };
}
