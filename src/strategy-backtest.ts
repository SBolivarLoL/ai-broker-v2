export type BacktestBar = { timestamp: Date | string | number; close: number };
export type BacktestDecision = { targetExposure: number; reason: string; features?: Record<string, number | null> };
export type BacktestStrategy = (history: BacktestBar[], index: number) => BacktestDecision;
export type BacktestPoint = { timestamp: string; equity: number; cash: number; units: number; price: number; targetExposure: number; reason: string; tradeNotional: number; cost: number; features?: Record<string, number | null> };
export type BacktestResult = {
  strategyId: string;
  initialCash: number;
  finalEquity: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  turnover: number;
  turnoverPercent: number;
  totalCost: number;
  exposureTimePercent: number;
  points: BacktestPoint[];
  assumptions: { feeBps: number; slippageBps: number; execution: "close" };
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function normalizeBars(bars: BacktestBar[]) {
  return bars.map(bar => ({ timestamp: new Date(bar.timestamp), close: Number(bar.close) }))
    .filter(bar => Number.isFinite(bar.timestamp.getTime()) && Number.isFinite(bar.close) && bar.close > 0)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function maxDrawdown(equity: number[]) {
  let peak = equity[0] ?? 0, drawdown = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - value) / peak);
  }
  return drawdown * 100;
}

export function runBacktest(input: { strategyId: string; bars: BacktestBar[]; strategy: BacktestStrategy; initialCash?: number; feeBps?: number; slippageBps?: number }): BacktestResult {
  const bars = normalizeBars(input.bars);
  const initialCash = input.initialCash ?? 10_000, feeBps = input.feeBps ?? 0, slippageBps = input.slippageBps ?? 5;
  if (bars.length < 2) throw new Error("At least two valid bars are required");
  if (!Number.isFinite(initialCash) || initialCash <= 0 || !Number.isFinite(feeBps) || feeBps < 0 || !Number.isFinite(slippageBps) || slippageBps < 0) throw new Error("Invalid backtest assumptions");
  let cash = initialCash, units = 0, turnover = 0, totalCost = 0, exposed = 0;
  const points: BacktestPoint[] = [];
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]!;
    const equityBefore = cash + units * bar.close;
    const decision = input.strategy(bars, index);
    const targetExposure = clamp(Number(decision.targetExposure));
    const targetNotional = equityBefore * targetExposure;
    const currentNotional = units * bar.close;
    const tradeNotional = targetNotional - currentNotional;
    const cost = Math.abs(tradeNotional) * (feeBps + slippageBps) / 10_000;
    units += tradeNotional / bar.close;
    cash -= tradeNotional + cost;
    turnover += Math.abs(tradeNotional);
    totalCost += cost;
    const equity = cash + units * bar.close;
    if (targetExposure > 0.01) exposed++;
    points.push({ timestamp: bar.timestamp.toISOString(), equity, cash, units, price: bar.close, targetExposure, reason: decision.reason, tradeNotional, cost, features: decision.features });
  }
  const finalEquity = points.at(-1)!.equity;
  return {
    strategyId: input.strategyId,
    initialCash,
    finalEquity,
    totalReturnPercent: (finalEquity / initialCash - 1) * 100,
    maxDrawdownPercent: maxDrawdown(points.map(point => point.equity)),
    turnover,
    turnoverPercent: turnover / initialCash * 100,
    totalCost,
    exposureTimePercent: exposed / points.length * 100,
    points,
    assumptions: { feeBps, slippageBps, execution: "close" },
  };
}

export const cashStrategy: BacktestStrategy = () => ({ targetExposure: 0, reason: "cash baseline" });
export const buyAndHoldStrategy: BacktestStrategy = (_history, index) => ({ targetExposure: 1, reason: index === 0 ? "enter buy-and-hold baseline" : "hold buy-and-hold baseline" });

export function walkForwardWindows<T>(values: T[], trainSize: number, testSize: number) {
  if (!Number.isInteger(trainSize) || !Number.isInteger(testSize) || trainSize < 2 || testSize < 1) throw new Error("Invalid walk-forward window sizes");
  const windows: { train: T[]; test: T[]; trainStart: number; testStart: number }[] = [];
  for (let trainStart = 0; trainStart + trainSize + testSize <= values.length; trainStart += testSize) {
    const testStart = trainStart + trainSize;
    windows.push({ train: values.slice(trainStart, testStart), test: values.slice(testStart, testStart + testSize), trainStart, testStart });
  }
  return windows;
}
