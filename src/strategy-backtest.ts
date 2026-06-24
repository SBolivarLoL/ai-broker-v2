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

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const closesThrough = (history: BacktestBar[], index: number) => history.slice(0, index + 1).map(bar => Number(bar.close)).filter(value => Number.isFinite(value) && value > 0);
const stdev = (values: number[]) => {
  if (values.length < 2) return null;
  const mean = average(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
};

export function timeSlicedAccumulationStrategy(params: { slices?: number; maxExposure?: number } = {}): BacktestStrategy {
  const slices = Math.max(1, Math.floor(params.slices ?? 10));
  const maxExposure = clamp(params.maxExposure ?? 1);
  return (_history, index) => {
    const targetExposure = Math.min(maxExposure, (index + 1) / slices * maxExposure);
    return { targetExposure, reason: targetExposure >= maxExposure ? "accumulation complete" : "scheduled accumulation", features: { slice: index + 1, slices } };
  };
}

export function movingAverageTrendStrategy(params: { fast?: number; slow?: number; exposure?: number } = {}): BacktestStrategy {
  const fast = Math.max(2, Math.floor(params.fast ?? 5));
  const slow = Math.max(fast + 1, Math.floor(params.slow ?? 20));
  const exposure = clamp(params.exposure ?? 1);
  return (history, index) => {
    const closes = closesThrough(history, index);
    const fastAverage = closes.length >= fast ? average(closes.slice(-fast)) : null;
    const slowAverage = closes.length >= slow ? average(closes.slice(-slow)) : null;
    const riskOn = fastAverage !== null && slowAverage !== null && fastAverage > slowAverage;
    return { targetExposure: riskOn ? exposure : 0, reason: riskOn ? "fast average above slow average" : "trend confirmation unavailable or bearish", features: { fastAverage, slowAverage } };
  };
}

export function meanReversionStrategy(params: { lookback?: number; entryZScore?: number; exitZScore?: number; exposure?: number } = {}): BacktestStrategy {
  const lookback = Math.max(3, Math.floor(params.lookback ?? 20));
  const entryZScore = Number.isFinite(params.entryZScore) ? params.entryZScore! : -2;
  const exitZScore = Number.isFinite(params.exitZScore) ? params.exitZScore! : -0.25;
  const exposure = clamp(params.exposure ?? 1);
  let active = false;
  return (history, index) => {
    const closes = closesThrough(history, index);
    const window = closes.slice(-lookback);
    const mean = window.length >= lookback ? average(window) : null;
    const deviation = window.length >= lookback ? stdev(window) : null;
    const price = closes.at(-1) ?? null;
    const zScore = mean !== null && deviation && price !== null ? (price - mean) / deviation : null;
    if (zScore !== null && zScore <= entryZScore) active = true;
    else if (zScore !== null && zScore >= exitZScore) active = false;
    return { targetExposure: active ? exposure : 0, reason: active ? "mean reversion entry active" : "waiting for oversold setup", features: { price, mean, zScore } };
  };
}

export function strategyFromId(strategyId: string, params: Record<string, unknown> = {}): BacktestStrategy {
  if (strategyId === "cash") return cashStrategy;
  if (strategyId === "buy-and-hold") return buyAndHoldStrategy;
  if (strategyId === "time-sliced-accumulation") return timeSlicedAccumulationStrategy({ slices: Number(params.slices), maxExposure: Number(params.maxExposure ?? 1) });
  if (strategyId === "moving-average-trend") return movingAverageTrendStrategy({ fast: Number(params.fast), slow: Number(params.slow), exposure: Number(params.exposure ?? 1) });
  if (strategyId === "mean-reversion") return meanReversionStrategy({ lookback: Number(params.lookback), entryZScore: Number(params.entryZScore), exitZScore: Number(params.exitZScore), exposure: Number(params.exposure ?? 1) });
  throw new Error("Unknown strategyId");
}

export function walkForwardWindows<T>(values: T[], trainSize: number, testSize: number) {
  if (!Number.isInteger(trainSize) || !Number.isInteger(testSize) || trainSize < 2 || testSize < 1) throw new Error("Invalid walk-forward window sizes");
  const windows: { train: T[]; test: T[]; trainStart: number; testStart: number }[] = [];
  for (let trainStart = 0; trainStart + trainSize + testSize <= values.length; trainStart += testSize) {
    const testStart = trainStart + trainSize;
    windows.push({ train: values.slice(trainStart, testStart), test: values.slice(testStart, testStart + testSize), trainStart, testStart });
  }
  return windows;
}
