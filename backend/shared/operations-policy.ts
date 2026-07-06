/**
 * Global operational guardrails shared by manual, basket, option, crypto, and
 * approved strategy paper orders.
 */
import { z } from "zod";
import type { PendingOrder, Position } from "./risk";

export const DEFAULT_OPERATIONS_POLICY = {
  schemaVersion: "operations-policy-v1",
  globalKillSwitch: { active: false, reason: "", activatedAt: null as string | null, activatedBy: null as string | null },
  maxOrderNotional: 2_500,
  maxSymbolExposureNotional: 10_000,
  maxPortfolioExposurePercent: 20,
  maxSectorExposurePercent: 40,
  maxDrawdownPercent: 20,
  maxDailyTurnoverPercent: 10,
} as const;

const optionalPositive = z.preprocess(value => value === "" || value === null || value === undefined ? undefined : value, z.coerce.number().positive().finite().optional());
const optionalPercent = z.preprocess(value => value === "" || value === null || value === undefined ? undefined : value, z.coerce.number().positive().finite().max(100).optional());

export const OperationsPolicy = z.object({
  schemaVersion: z.literal("operations-policy-v1").default(DEFAULT_OPERATIONS_POLICY.schemaVersion),
  globalKillSwitch: z.object({
    active: z.boolean().default(false),
    reason: z.string().trim().max(500).default(""),
    activatedAt: z.string().datetime().nullable().default(null),
    activatedBy: z.string().trim().max(120).nullable().default(null),
  }).default(DEFAULT_OPERATIONS_POLICY.globalKillSwitch),
  maxOrderNotional: optionalPositive.default(DEFAULT_OPERATIONS_POLICY.maxOrderNotional),
  maxSymbolExposureNotional: optionalPositive.default(DEFAULT_OPERATIONS_POLICY.maxSymbolExposureNotional),
  maxPortfolioExposurePercent: optionalPercent.default(DEFAULT_OPERATIONS_POLICY.maxPortfolioExposurePercent),
  maxSectorExposurePercent: optionalPercent.default(DEFAULT_OPERATIONS_POLICY.maxSectorExposurePercent),
  maxDrawdownPercent: optionalPercent.default(DEFAULT_OPERATIONS_POLICY.maxDrawdownPercent),
  maxDailyTurnoverPercent: optionalPercent.default(DEFAULT_OPERATIONS_POLICY.maxDailyTurnoverPercent),
}).superRefine((policy, context) => {
  if (policy.globalKillSwitch.active && !policy.globalKillSwitch.reason.trim()) {
    context.addIssue({ code: "custom", path: ["globalKillSwitch", "reason"], message: "A kill-switch reason is required" });
  }
});
export type OperationsPolicy = z.infer<typeof OperationsPolicy>;

export type OperationOrderIntent = {
  symbol: string;
  side: "buy" | "sell";
  qty?: number | string | null;
  price?: number | string | null;
  notional?: number | string | null;
  assetClass: "equity" | "crypto" | "strategy_crypto" | "option" | "basket";
};

export type OperationsPolicyEvaluation = {
  allowed: boolean;
  reasons: string[];
  runbook: string[];
  evidence: {
    schemaVersion: string;
    killSwitch: OperationsPolicy["globalKillSwitch"];
    assetClass: OperationOrderIntent["assetClass"];
    symbol: string;
    side: "buy" | "sell";
    estimatedNotional: number;
    currentSymbolExposure: number;
    pendingSymbolExposure: number;
    resultingSymbolExposure: number;
    resultingPortfolioExposurePercent: number;
    dailyTurnoverPercent: number;
    reducesExposure: boolean;
    limits: Pick<OperationsPolicy, "maxOrderNotional" | "maxSymbolExposureNotional" | "maxPortfolioExposurePercent" | "maxSectorExposurePercent" | "maxDrawdownPercent" | "maxDailyTurnoverPercent">;
  };
};

export type PortfolioPolicyPosition = { symbol: string; marketValue: string | number; sector?: string | null };
export type PortfolioPolicySector = { label: string; grossPercent?: string | number | null; grossValue?: string | number | null };
export type PortfolioPolicyEvaluation = {
  allowed: boolean;
  reasons: string[];
  runbook: string[];
  evidence: {
    schemaVersion: string;
    equity: number;
    largestPositionPercent: number;
    largestPositionSymbol: string | null;
    largestSectorPercent: number;
    largestSector: string | null;
    drawdownPercent: number | null;
    dailyTurnoverPercent: number | null;
    limits: Pick<OperationsPolicy, "maxPortfolioExposurePercent" | "maxSectorExposurePercent" | "maxDrawdownPercent" | "maxDailyTurnoverPercent">;
  };
};

const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const symbolKey = (symbol: string) => symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");

function positionValue(positions: Position[], symbol: string) {
  const key = symbolKey(symbol);
  const position = positions.find(item => symbolKey(String(item.symbol)) === key);
  return finite(position?.marketValue) ?? 0;
}

function pendingValue(pendingOrders: PendingOrder[], symbol: string) {
  const key = symbolKey(symbol);
  return pendingOrders
    .filter(order => symbolKey(String(order.symbol)) === key)
    .reduce((sum, order) => sum + (order.side === "buy" ? 1 : -1) * Math.abs(Number(order.qty)) * Math.abs(Number(order.price)), 0);
}

function pendingTurnover(pendingOrders: PendingOrder[]) {
  return pendingOrders.reduce((sum, order) => sum + Math.abs(Number(order.qty)) * Math.abs(Number(order.price)), 0);
}

function estimatedNotional(order: OperationOrderIntent) {
  const notional = finite(order.notional);
  if (notional !== null && notional > 0) return notional;
  const qty = finite(order.qty), price = finite(order.price);
  if (qty !== null && price !== null && qty > 0 && price > 0) return qty * price;
  return null;
}

function runbookFor(reasons: string[]) {
  const steps = new Set<string>();
  if (reasons.includes("global_kill_switch")) {
    steps.add("Leave submissions blocked, review open orders, and record the incident reason before re-enabling trading.");
    steps.add("Check the latest order receipts, strategy audit trail, alerts, and broker reconciliation state.");
  }
  if (reasons.some(reason => reason.startsWith("max_") || reason.endsWith("_limit"))) {
    steps.add("Reduce the order size or exposure, then rerun preview with fresh account and market data.");
    steps.add("Escalate only after documenting why the cap should change and who approved it.");
  }
  if (reasons.includes("account_unavailable")) steps.add("Refresh account equity and buying-power data before accepting any new order.");
  if (!steps.size) steps.add("Operational policy passed; keep the signed preview and receipt with the order evidence.");
  return [...steps];
}

export function parseOperationsPolicy(input: unknown): OperationsPolicy {
  const merged = { ...DEFAULT_OPERATIONS_POLICY, ...(input && typeof input === "object" ? input : {}) };
  return OperationsPolicy.parse(merged);
}

export function evaluateOperationsPolicy(input: {
  policy?: unknown;
  order: OperationOrderIntent;
  account?: { equity?: number | string | null } | null;
  positions?: Position[];
  dailyTurnover?: number;
  pendingOrders?: PendingOrder[];
}): OperationsPolicyEvaluation {
  const policy = parseOperationsPolicy(input.policy);
  const positions = input.positions ?? [];
  const pendingOrders = input.pendingOrders ?? [];
  const equity = finite(input.account?.equity);
  const orderNotional = estimatedNotional(input.order);
  const current = positionValue(positions, input.order.symbol);
  const pending = pendingValue(pendingOrders, input.order.symbol);
  const signedCurrent = current + pending;
  const resultingSigned = signedCurrent + (input.order.side === "buy" ? orderNotional ?? 0 : -(orderNotional ?? 0));
  const resultingExposure = Math.abs(resultingSigned);
  // Exposure-reducing orders may cross entry caps so an operator can unwind a
  // breach. The global kill switch and missing account data still fail closed.
  const reducesExposure = orderNotional !== null && Math.abs(resultingSigned) < Math.abs(signedCurrent);
  const turnover = Math.max(0, input.dailyTurnover ?? 0) + pendingTurnover(pendingOrders) + (orderNotional ?? 0);
  const reasons: string[] = [];

  if (policy.globalKillSwitch.active) reasons.push("global_kill_switch");
  if (equity === null || equity <= 0) reasons.push("account_unavailable");
  if (orderNotional === null || orderNotional <= 0) reasons.push("invalid_order_notional");

  const portfolioExposurePercent = equity && equity > 0 ? resultingExposure / equity * 100 : 0;
  const turnoverPercent = equity && equity > 0 ? turnover / equity * 100 : 0;
  if (!reducesExposure && orderNotional !== null && orderNotional > policy.maxOrderNotional) reasons.push("max_order_notional");
  if (!reducesExposure && resultingExposure > policy.maxSymbolExposureNotional) reasons.push("max_symbol_exposure");
  if (!reducesExposure && portfolioExposurePercent > policy.maxPortfolioExposurePercent) reasons.push("max_portfolio_exposure");
  if (!reducesExposure && turnoverPercent > policy.maxDailyTurnoverPercent) reasons.push("max_daily_turnover");

  const uniqueReasons = [...new Set(reasons)];
  return {
    allowed: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    runbook: runbookFor(uniqueReasons),
    evidence: {
      schemaVersion: policy.schemaVersion,
      killSwitch: policy.globalKillSwitch,
      assetClass: input.order.assetClass,
      symbol: input.order.symbol,
      side: input.order.side,
      estimatedNotional: orderNotional ?? 0,
      currentSymbolExposure: Math.abs(current),
      pendingSymbolExposure: Math.abs(pending),
      resultingSymbolExposure: resultingExposure,
      resultingPortfolioExposurePercent: portfolioExposurePercent,
      dailyTurnoverPercent: turnoverPercent,
      reducesExposure,
      limits: {
        maxOrderNotional: policy.maxOrderNotional,
        maxSymbolExposureNotional: policy.maxSymbolExposureNotional,
        maxPortfolioExposurePercent: policy.maxPortfolioExposurePercent,
        maxSectorExposurePercent: policy.maxSectorExposurePercent,
        maxDrawdownPercent: policy.maxDrawdownPercent,
        maxDailyTurnoverPercent: policy.maxDailyTurnoverPercent,
      },
    },
  };
}

export function evaluatePortfolioPolicy(input: {
  policy?: unknown;
  equity: string | number;
  positions: PortfolioPolicyPosition[];
  sectors?: PortfolioPolicySector[];
  drawdownPercent?: string | number | null;
  dailyTurnover?: string | number | null;
}): PortfolioPolicyEvaluation {
  const policy = parseOperationsPolicy(input.policy);
  const equity = finite(input.equity);
  if (equity === null || equity <= 0) throw new Error("Valid portfolio equity is required");
  const positions = input.positions.map(position => ({ ...position, marketValue: finite(position.marketValue) ?? 0 }));
  const largestPosition = positions.reduce<{ symbol: string | null; percent: number }>((largest, position) => {
    const percent = Math.abs(position.marketValue) / equity * 100;
    return percent > largest.percent ? { symbol: position.symbol, percent } : largest;
  }, { symbol: null, percent: 0 });
  const sectors = input.sectors?.length
    ? input.sectors.map(sector => ({ label: sector.label, percent: finite(sector.grossPercent) ?? ((finite(sector.grossValue) ?? 0) / equity * 100) }))
    : [...positions.reduce((groups, position) => {
      if (!position.sector) return groups;
      groups.set(position.sector, (groups.get(position.sector) ?? 0) + Math.abs(position.marketValue));
      return groups;
    }, new Map<string, number>())].map(([label, grossValue]) => ({ label, percent: grossValue / equity * 100 }));
  const largestSector = sectors.reduce<{ label: string | null; percent: number }>((largest, sector) => sector.percent > largest.percent ? { label: sector.label, percent: sector.percent } : largest, { label: null, percent: 0 });
  const drawdown = finite(input.drawdownPercent);
  const dailyTurnover = finite(input.dailyTurnover);
  const dailyTurnoverPercent = dailyTurnover === null ? null : dailyTurnover / equity * 100;
  const reasons: string[] = [];

  if (policy.globalKillSwitch.active) reasons.push("global_kill_switch");
  if (largestPosition.percent > policy.maxPortfolioExposurePercent) reasons.push("max_position_limit");
  if (largestSector.percent > policy.maxSectorExposurePercent) reasons.push("max_sector_limit");
  if (drawdown !== null && drawdown > policy.maxDrawdownPercent) reasons.push("max_drawdown_limit");
  if (dailyTurnoverPercent !== null && dailyTurnoverPercent > policy.maxDailyTurnoverPercent) reasons.push("max_daily_turnover");

  const uniqueReasons = [...new Set(reasons)];
  return {
    allowed: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    runbook: runbookFor(uniqueReasons),
    evidence: {
      schemaVersion: policy.schemaVersion,
      equity,
      largestPositionPercent: largestPosition.percent,
      largestPositionSymbol: largestPosition.symbol,
      largestSectorPercent: largestSector.percent,
      largestSector: largestSector.label,
      drawdownPercent: drawdown,
      dailyTurnoverPercent,
      limits: {
        maxPortfolioExposurePercent: policy.maxPortfolioExposurePercent,
        maxSectorExposurePercent: policy.maxSectorExposurePercent,
        maxDrawdownPercent: policy.maxDrawdownPercent,
        maxDailyTurnoverPercent: policy.maxDailyTurnoverPercent,
      },
    },
  };
}
