export type Position = { symbol: string; qty: string | number; marketValue: string | number; unrealizedPl?: string | number };

export type RiskSnapshot = {
  equity: number;
  cash: number;
  cashPercent: number;
  unrealizedPl: number;
  largestPositionPercent: number;
  topThreePercent: number;
  hhi: number;
  weights: { symbol: string; percent: number }[];
};

export type TradeSimulation = {
  allowed: boolean;
  estimatedNotional: number;
  resultingCash: number;
  resultingPositionPercent: number;
  turnoverPercent: number;
  reasons: string[];
};

export type FilledOrder = { filledAt?: Date | string | null; filledQty?: string | number; filledAvgPrice?: string | number | null };

const finite = (value: string | number) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Portfolio contains a non-finite number");
  return number;
};

export function rollingTurnover(orders: FilledOrder[], now = Date.now()) {
  const since = now - 24 * 60 * 60 * 1_000;
  // ponytail: rolling 24h is conservative around market-day boundaries; use Alpaca calendar sessions for multi-market accounts.
  return orders.reduce((sum, order) => {
    const filledAt = order.filledAt ? new Date(order.filledAt).getTime() : 0;
    if (!Number.isFinite(filledAt) || filledAt < since || filledAt > now || order.filledQty === undefined || order.filledAvgPrice == null) return sum;
    return sum + finite(order.filledQty) * finite(order.filledAvgPrice);
  }, 0);
}

export function riskSnapshot(equityValue: string | number, cashValue: string | number, positions: Position[]): RiskSnapshot {
  const equity = finite(equityValue);
  const cash = finite(cashValue);
  if (equity <= 0) throw new Error("Equity must be greater than zero");
  const weights = positions.map(position => ({ symbol: position.symbol, percent: finite(position.marketValue) / equity * 100 })).sort((a, b) => b.percent - a.percent);
  return {
    equity,
    cash,
    cashPercent: cash / equity * 100,
    unrealizedPl: positions.reduce((sum, position) => sum + finite(position.unrealizedPl ?? 0), 0),
    largestPositionPercent: weights[0]?.percent ?? 0,
    topThreePercent: weights.slice(0, 3).reduce((sum, position) => sum + position.percent, 0),
    hhi: weights.reduce((sum, position) => sum + (position.percent / 100) ** 2, 0),
    weights,
  };
}

export function simulateTrade(input: {
  snapshot: RiskSnapshot;
  positions: Position[];
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  dailyTurnover?: number;
}): TradeSimulation {
  const { snapshot, positions, symbol, side, qty, price, dailyTurnover = 0 } = input;
  if (![qty, price].every(value => Number.isFinite(value) && value > 0)) throw new Error("Quantity and price must be positive finite numbers");
  const estimatedNotional = qty * price;
  const current = positions.find(position => position.symbol === symbol);
  const currentValue = current ? finite(current.marketValue) : 0;
  const ownedQty = current ? finite(current.qty) : 0;
  const resultingValue = currentValue + (side === "buy" ? estimatedNotional : -estimatedNotional);
  const resultingCash = snapshot.cash + (side === "buy" ? -estimatedNotional : estimatedNotional);
  const resultingPositionPercent = Math.max(0, resultingValue) / snapshot.equity * 100;
  const turnoverPercent = (dailyTurnover + estimatedNotional) / snapshot.equity * 100;
  const reasons: string[] = [];
  const maxNotional = Math.min(2_500, snapshot.equity * 0.025);
  if (side === "sell" && qty > ownedQty) reasons.push("Sell quantity exceeds owned quantity");
  if (side === "buy" && estimatedNotional > snapshot.cash) reasons.push("Insufficient cash");
  if (estimatedNotional > maxNotional) reasons.push(`Order exceeds $${maxNotional.toFixed(2)} limit`);
  if (resultingPositionPercent > 20) reasons.push("Resulting position exceeds 20% concentration limit");
  if (turnoverPercent > 10) reasons.push("Daily turnover exceeds 10% limit");
  return { allowed: reasons.length === 0, estimatedNotional, resultingCash, resultingPositionPercent, turnoverPercent, reasons };
}
