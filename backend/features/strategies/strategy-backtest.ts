/**
 * Strategy plugin definitions and a deterministic, fee-aware backtest engine
 * that evaluates each bar using only information available at that index.
 */
import { z } from "zod";

export type BacktestBar = { timestamp: Date | string | number; open?: number | null; high?: number | null; low?: number | null; close: number; volume?: number | null; vwap?: number | null; tradeCount?: number | null };
export type StrategyFeatureMap = Record<string, number | null>;
export type StrategyThresholdMap = Record<string, string | number | boolean | null>;
export type BacktestDecision = {
  targetExposure: number;
  reason: string;
  features?: StrategyFeatureMap;
  weights?: StrategyFeatureMap;
  thresholds?: StrategyThresholdMap;
};
export type BacktestStrategy = (history: BacktestBar[], index: number) => BacktestDecision;
export type BacktestPoint = { timestamp: string; equity: number; cash: number; units: number; price: number; targetExposure: number; reason: string; tradeNotional: number; cost: number; features?: StrategyFeatureMap; weights?: StrategyFeatureMap; thresholds?: StrategyThresholdMap };
export type BacktestTradeMetrics = {
  tradeCount: number;
  positionEpisodeCount: number;
  roundTripCount: number;
  averageHoldingBars: number | null;
  averageHoldingDays: number | null;
  grossReturnPercent: number;
  netReturnPercent: number;
  downsideDeviationPercent: number;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  profitFactor: number | null;
  hitRatePercent: number | null;
  averageWinPercent: number | null;
  averageLossPercent: number | null;
  turnoverPercent: number;
  exposureTimePercent: number;
  capacityWarnings: string[];
};
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
  tradeMetrics: BacktestTradeMetrics;
  points: BacktestPoint[];
  assumptions: { feeBps: number; slippageBps: number; execution: "close" };
};
export type StrategyOrderIntent = { type: "target_exposure"; targetExposure: number; reason: string };
export type StrategyAttributionPlan = { windows: ("1h" | "1d" | "7d")[]; baselines: ("cash" | "buy-and-hold")[] };
export type StrategyRiskAdjustment = {
  allowed: boolean;
  targetExposure: number;
  rawTargetExposure: number;
  riskAdjustedSignal: number;
  reasons: string[];
};
export type StrategyMarketContext = { histories?: Record<string, BacktestBar[]>; snapshots?: Record<string, any> };
export type StrategyPluginContext = { history: BacktestBar[]; index: number; symbol?: string; market?: StrategyMarketContext };
export type StrategyPluginEvaluation = BacktestDecision & {
  weights: StrategyFeatureMap;
  thresholds: StrategyThresholdMap;
  risk: StrategyRiskAdjustment;
  orders: StrategyOrderIntent[];
  attribution: StrategyAttributionPlan;
};
export type StrategyPlugin<Prepared = Record<string, unknown>> = {
  id: string;
  version: string;
  prepare(context: StrategyPluginContext): Prepared;
  features(context: StrategyPluginContext & { prepared: Prepared }): StrategyFeatureMap;
  decide(context: StrategyPluginContext & { prepared: Prepared; features: StrategyFeatureMap }): BacktestDecision;
  riskAdjust(context: StrategyPluginContext & { prepared: Prepared; features: StrategyFeatureMap; decision: BacktestDecision }): StrategyRiskAdjustment;
  orders(context: StrategyPluginContext & { prepared: Prepared; features: StrategyFeatureMap; decision: BacktestDecision; risk: StrategyRiskAdjustment }): StrategyOrderIntent[];
  attribution(context: StrategyPluginContext & { prepared: Prepared; features: StrategyFeatureMap; decision: BacktestDecision; risk: StrategyRiskAdjustment; orders: StrategyOrderIntent[] }): StrategyAttributionPlan;
};

export const STRATEGY_IDS = [
  "cash",
  "buy-and-hold",
  "time-sliced-accumulation",
  "moving-average-trend",
  "breakout-momentum",
  "volatility-filter",
  "mean-reversion",
  "btc-eth-relative-strength",
  "order-book-liquidity-scout",
] as const;
export type StrategyId = typeof STRATEGY_IDS[number];

const boundedInteger = (minimum: number, maximum: number, defaultValue: number) => z.number().finite().int().min(minimum).max(maximum).default(defaultValue);
const exposure = z.number().finite().min(0).max(1).default(1);
const STRATEGY_PARAMETER_SCHEMAS = {
  cash: z.object({}).strict(),
  "buy-and-hold": z.object({}).strict(),
  "time-sliced-accumulation": z.object({
    slices: boundedInteger(1, 10_000, 10),
    maxExposure: exposure,
  }).strict(),
  "moving-average-trend": z.object({
    fast: boundedInteger(2, 10_000, 5),
    slow: boundedInteger(3, 10_000, 20),
    exposure,
  }).strict().refine(params => params.slow > params.fast, { message: "slow must be greater than fast", path: ["slow"] }),
  "mean-reversion": z.object({
    lookback: boundedInteger(3, 10_000, 20),
    entryZScore: z.number().finite().min(-20).max(20).default(-2),
    exitZScore: z.number().finite().min(-20).max(20).default(-0.25),
    exposure,
  }).strict().refine(params => params.entryZScore < params.exitZScore, { message: "entryZScore must be less than exitZScore", path: ["exitZScore"] }),
  "breakout-momentum": z.object({
    lookback: boundedInteger(2, 10_000, 20),
    volumeLookback: z.number().finite().int().min(2).max(10_000).optional(),
    volumeMultiple: z.number().finite().min(0.01).max(100).default(1.25),
    stopLossPercent: z.number().finite().min(0).max(100).default(8),
    exposure,
  }).strict().transform(params => ({ ...params, volumeLookback: params.volumeLookback ?? params.lookback })),
  "volatility-filter": z.object({
    lookback: boundedInteger(2, 10_000, 20),
    minVolatilityPercent: z.number().finite().min(0).max(1_000).default(0),
    maxVolatilityPercent: z.number().finite().min(0).max(1_000).default(6),
    exposure,
  }).strict().refine(params => params.maxVolatilityPercent >= params.minVolatilityPercent, { message: "maxVolatilityPercent must be at least minVolatilityPercent", path: ["maxVolatilityPercent"] }),
  "btc-eth-relative-strength": z.object({
    lookback: boundedInteger(1, 10_000, 20),
    minRelativeStrengthPercent: z.number().finite().min(-1_000).max(1_000).default(0),
    exposure,
  }).strict(),
  "order-book-liquidity-scout": z.object({
    exposure,
    maxSpreadBps: z.number().finite().min(1).max(10_000).default(100),
    minVisibleAskNotional: z.number().finite().min(0).max(1_000_000_000_000).default(500),
    minVisibleBidNotional: z.number().finite().min(0).max(1_000_000_000_000).default(500),
    maxDepthLevels: boundedInteger(1, 100, 25),
  }).strict(),
} as const;

export function parseStrategyParams<T extends StrategyId>(strategyId: T, params?: unknown): z.infer<(typeof STRATEGY_PARAMETER_SCHEMAS)[T]>;
export function parseStrategyParams(strategyId: string, params?: unknown): Record<string, unknown>;
export function parseStrategyParams(strategyId: string, params: unknown = {}) {
  if (!(STRATEGY_IDS as readonly string[]).includes(strategyId)) throw new Error("Unknown strategyId");
  const result = STRATEGY_PARAMETER_SCHEMAS[strategyId as StrategyId].safeParse(params ?? {});
  if (!result.success) throw new Error(`Invalid ${strategyId} parameters: ${result.error.issues[0]?.message ?? "invalid configuration"}`);
  return result.data;
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const defaultAttribution = (): StrategyAttributionPlan => ({ windows: ["1h", "1d", "7d"], baselines: ["cash", "buy-and-hold"] });
const targetExposureOrder = (targetExposure: number, reason: string): StrategyOrderIntent[] => [{ type: "target_exposure", targetExposure, reason }];

function defaultRiskAdjustment(decision: BacktestDecision): StrategyRiskAdjustment {
  const rawTargetExposure = Number(decision.targetExposure);
  const targetExposure = clamp(rawTargetExposure);
  return { allowed: true, targetExposure, rawTargetExposure, riskAdjustedSignal: targetExposure, reasons: [] };
}

export function evaluateStrategyPlugin(plugin: StrategyPlugin, history: BacktestBar[], index: number, symbol?: string, market?: StrategyMarketContext): StrategyPluginEvaluation {
  const context = { history, index, symbol, market };
  const prepared = plugin.prepare(context);
  const features = plugin.features({ ...context, prepared });
  const decision = plugin.decide({ ...context, prepared, features });
  const risk = plugin.riskAdjust({ ...context, prepared, features, decision });
  const orders = plugin.orders({ ...context, prepared, features, decision, risk });
  const attribution = plugin.attribution({ ...context, prepared, features, decision, risk, orders });
  return {
    ...decision,
    targetExposure: risk.targetExposure,
    features,
    weights: decision.weights ?? {},
    thresholds: decision.thresholds ?? {},
    risk,
    orders,
    attribution,
  };
}

export function strategyFunctionFromPlugin(plugin: StrategyPlugin, market?: StrategyMarketContext, symbol?: string): BacktestStrategy {
  return (history, index) => evaluateStrategyPlugin(plugin, history, index, symbol, market);
}

function normalizeBars(bars: BacktestBar[]) {
  return bars.map(bar => ({
    timestamp: new Date(bar.timestamp),
    open: Number.isFinite(Number(bar.open)) ? Number(bar.open) : null,
    high: Number.isFinite(Number(bar.high)) ? Number(bar.high) : null,
    low: Number.isFinite(Number(bar.low)) ? Number(bar.low) : null,
    close: Number(bar.close),
    volume: Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : null,
    vwap: Number.isFinite(Number(bar.vwap)) ? Number(bar.vwap) : null,
    tradeCount: Number.isFinite(Number(bar.tradeCount)) ? Number(bar.tradeCount) : null,
  }))
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

const finiteOrNull = (value: number) => Number.isFinite(value) ? value : null;

function buildTradeMetrics(input: {
  points: BacktestPoint[];
  initialCash: number;
  finalEquity: number;
  totalCost: number;
  turnoverPercent: number;
  exposureTimePercent: number;
  maxDrawdownPercent: number;
}) {
  const tradeCount = input.points.filter(
    (point) =>
      Math.abs(point.tradeNotional) >= Math.max(1e-6, input.initialCash * 0.001),
  ).length;
  const returns: number[] = [];
  let previousEquity = input.initialCash;
  for (const point of input.points) {
    returns.push(point.equity / previousEquity - 1);
    previousEquity = point.equity;
  }
  const downsideReturns = returns.filter((value) => value < 0);
  const downsideDeviationPercent = downsideReturns.length
    ? Math.sqrt(
        downsideReturns.reduce((sum, value) => sum + value ** 2, 0) /
          downsideReturns.length,
      ) * 100
    : 0;
  const averageReturnPercent = returns.length
    ? (returns.reduce((sum, value) => sum + value, 0) / returns.length) * 100
    : 0;
  const sortinoRatio = downsideDeviationPercent > 0
    ? averageReturnPercent / downsideDeviationPercent
    : null;
  const firstTime = new Date(input.points[0]!.timestamp).getTime();
  const lastTime = new Date(input.points.at(-1)!.timestamp).getTime();
  const years = Math.max(0, lastTime - firstTime) / (365.25 * 86_400_000);
  const annualizedReturnPercent = years > 0 && input.finalEquity > 0
    ? ((input.finalEquity / input.initialCash) ** (1 / years) - 1) * 100
    : input.finalEquity / input.initialCash * 100 - 100;
  const calmarRatio = input.maxDrawdownPercent > 0
    ? annualizedReturnPercent / input.maxDrawdownPercent
    : null;

  const episodes: {
    returnPercent: number;
    bars: number;
    days: number;
    closed: boolean;
  }[] = [];
  let open:
    | {
        startIndex: number;
        startTime: number;
        growth: number;
      }
    | null = null;
  previousEquity = input.initialCash;
  for (let index = 0; index < input.points.length; index++) {
    const point = input.points[index]!;
    const pointReturn = point.equity / previousEquity - 1;
    const exposed = point.targetExposure > 0.01;
    if (!open && exposed)
      open = {
        startIndex: index,
        startTime: new Date(point.timestamp).getTime(),
        growth: 1,
      };
    if (open) open.growth *= 1 + pointReturn;
    if (open && !exposed) {
      const endTime = new Date(point.timestamp).getTime();
      episodes.push({
        returnPercent: (open.growth - 1) * 100,
        bars: index - open.startIndex + 1,
        days: Math.max(0, endTime - open.startTime) / 86_400_000,
        closed: true,
      });
      open = null;
    }
    previousEquity = point.equity;
  }
  if (open) {
    const endTime = new Date(input.points.at(-1)!.timestamp).getTime();
    episodes.push({
      returnPercent: (open.growth - 1) * 100,
      bars: input.points.length - open.startIndex,
      days: Math.max(0, endTime - open.startTime) / 86_400_000,
      closed: false,
    });
  }
  const closedEpisodes = episodes.filter((episode) => episode.closed);
  const wins = closedEpisodes.filter((episode) => episode.returnPercent > 0);
  const losses = closedEpisodes.filter((episode) => episode.returnPercent < 0);
  const grossProfit = wins.reduce((sum, episode) => sum + episode.returnPercent, 0);
  const grossLoss = Math.abs(losses.reduce((sum, episode) => sum + episode.returnPercent, 0));
  const capacityWarnings = [
    ...(input.turnoverPercent > 200 ? ["high_turnover_capacity_risk"] : []),
    ...(tradeCount / input.points.length > 0.5 ? ["high_trade_frequency_capacity_risk"] : []),
    ...(input.exposureTimePercent > 95 ? ["high_exposure_capacity_risk"] : []),
  ];
  return {
    tradeCount,
    positionEpisodeCount: episodes.length,
    roundTripCount: closedEpisodes.length,
    averageHoldingBars: episodes.length
      ? episodes.reduce((sum, episode) => sum + episode.bars, 0) / episodes.length
      : null,
    averageHoldingDays: episodes.length
      ? episodes.reduce((sum, episode) => sum + episode.days, 0) / episodes.length
      : null,
    grossReturnPercent: ((input.finalEquity + input.totalCost) / input.initialCash - 1) * 100,
    netReturnPercent: (input.finalEquity / input.initialCash - 1) * 100,
    downsideDeviationPercent,
    sortinoRatio: finiteOrNull(sortinoRatio ?? Number.NaN),
    calmarRatio: finiteOrNull(calmarRatio ?? Number.NaN),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    hitRatePercent: closedEpisodes.length ? wins.length / closedEpisodes.length * 100 : null,
    averageWinPercent: wins.length
      ? wins.reduce((sum, episode) => sum + episode.returnPercent, 0) / wins.length
      : null,
    averageLossPercent: losses.length
      ? losses.reduce((sum, episode) => sum + episode.returnPercent, 0) / losses.length
      : null,
    turnoverPercent: input.turnoverPercent,
    exposureTimePercent: input.exposureTimePercent,
    capacityWarnings,
  };
}

export function runBacktest(input: { strategyId: string; bars: BacktestBar[]; strategy: BacktestStrategy; initialCash?: number; feeBps?: number; slippageBps?: number; evaluationStartIndex?: number }): BacktestResult {
  const bars = normalizeBars(input.bars);
  const initialCash = input.initialCash ?? 10_000, feeBps = input.feeBps ?? 0, slippageBps = input.slippageBps ?? 5;
  const evaluationStartIndex = input.evaluationStartIndex ?? 0;
  if (bars.length < 2) throw new Error("At least two valid bars are required");
  if (!Number.isFinite(initialCash) || initialCash <= 0 || !Number.isFinite(feeBps) || feeBps < 0 || !Number.isFinite(slippageBps) || slippageBps < 0) throw new Error("Invalid backtest assumptions");
  if (!Number.isInteger(evaluationStartIndex) || evaluationStartIndex < 0 || evaluationStartIndex >= bars.length)
    throw new Error("Invalid backtest evaluation start");
  let cash = initialCash, units = 0, turnover = 0, totalCost = 0, exposed = 0;
  const points: BacktestPoint[] = [];
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]!;
    const equityBefore = cash + units * bar.close;
    const decision = input.strategy(bars, index);
    if (index < evaluationStartIndex) continue;
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
    points.push({ timestamp: bar.timestamp.toISOString(), equity, cash, units, price: bar.close, targetExposure, reason: decision.reason, tradeNotional, cost, features: decision.features, weights: decision.weights, thresholds: decision.thresholds });
  }
  const finalEquity = points.at(-1)!.equity;
  const totalReturnPercent = (finalEquity / initialCash - 1) * 100;
  const maxDrawdownPercent = maxDrawdown(points.map(point => point.equity));
  const turnoverPercent = turnover / initialCash * 100;
  const exposureTimePercent = exposed / points.length * 100;
  return {
    strategyId: input.strategyId,
    initialCash,
    finalEquity,
    totalReturnPercent,
    maxDrawdownPercent,
    turnover,
    turnoverPercent,
    totalCost,
    exposureTimePercent,
    tradeMetrics: buildTradeMetrics({
      points,
      initialCash,
      finalEquity,
      totalCost,
      turnoverPercent,
      exposureTimePercent,
      maxDrawdownPercent,
    }),
    points,
    assumptions: { feeBps, slippageBps, execution: "close" },
  };
}

export const cashStrategy: BacktestStrategy = strategyFunctionFromPlugin(cashStrategyPlugin());
export const buyAndHoldStrategy: BacktestStrategy = strategyFunctionFromPlugin(buyAndHoldStrategyPlugin());

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const closesThrough = (history: BacktestBar[], index: number) => history.slice(0, index + 1).map(bar => Number(bar.close)).filter(value => Number.isFinite(value) && value > 0);
const highsBefore = (history: BacktestBar[], index: number, lookback: number) => history.slice(Math.max(0, index - lookback), index).map(bar => Number(bar.high ?? bar.close)).filter(value => Number.isFinite(value) && value > 0);
const volumesBefore = (history: BacktestBar[], index: number, lookback: number) => history.slice(Math.max(0, index - lookback), index).map(bar => Number(bar.volume)).filter(value => Number.isFinite(value) && value > 0);
const returnsThrough = (history: BacktestBar[], index: number, lookback: number) => {
  const closes = closesThrough(history, index).slice(-(lookback + 1));
  const returns: number[] = [];
  for (let item = 1; item < closes.length; item++) returns.push(closes[item]! / closes[item - 1]! - 1);
  return returns;
};
const stdev = (values: number[]) => {
  if (values.length < 2) return null;
  const mean = average(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
};

export function timeSlicedAccumulationStrategy(params: { slices?: number; maxExposure?: number } = {}): BacktestStrategy {
  return strategyFunctionFromPlugin(timeSlicedAccumulationPlugin(parseStrategyParams("time-sliced-accumulation", params)));
}

export function movingAverageTrendStrategy(params: { fast?: number; slow?: number; exposure?: number } = {}): BacktestStrategy {
  return strategyFunctionFromPlugin(movingAverageTrendPlugin(parseStrategyParams("moving-average-trend", params)));
}

export function meanReversionStrategy(params: { lookback?: number; entryZScore?: number; exitZScore?: number; exposure?: number } = {}): BacktestStrategy {
  return strategyFunctionFromPlugin(meanReversionPlugin(parseStrategyParams("mean-reversion", params)));
}

export function breakoutMomentumStrategy(params: { lookback?: number; volumeLookback?: number; volumeMultiple?: number; exposure?: number; stopLossPercent?: number } = {}): BacktestStrategy {
  return strategyFunctionFromPlugin(breakoutMomentumPlugin(parseStrategyParams("breakout-momentum", params)));
}

export function volatilityFilterStrategy(params: { lookback?: number; minVolatilityPercent?: number; maxVolatilityPercent?: number; exposure?: number } = {}): BacktestStrategy {
  return strategyFunctionFromPlugin(volatilityFilterPlugin(parseStrategyParams("volatility-filter", params)));
}

export function btcEthRelativeStrengthStrategy(params: { lookback?: number; minRelativeStrengthPercent?: number; exposure?: number } = {}, market?: StrategyMarketContext, symbol = "BTC/USD"): BacktestStrategy {
  return strategyFunctionFromPlugin(btcEthRelativeStrengthPlugin(parseStrategyParams("btc-eth-relative-strength", params)), market, symbol);
}

export function orderBookLiquidityScoutStrategy(params: { exposure?: number; maxSpreadBps?: number; minVisibleAskNotional?: number; minVisibleBidNotional?: number; maxDepthLevels?: number } = {}, market?: StrategyMarketContext, symbol = "BTC/USD"): BacktestStrategy {
  return strategyFunctionFromPlugin(orderBookLiquidityScoutPlugin(parseStrategyParams("order-book-liquidity-scout", params)), market, symbol);
}

export function cashStrategyPlugin(): StrategyPlugin {
  return {
    id: "cash",
    version: "strategy-plugin-v1",
    prepare: () => ({}),
    features: () => ({}),
    decide: () => ({ targetExposure: 0, reason: "cash baseline", thresholds: {}, weights: {} }),
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => defaultAttribution(),
  };
}

export function buyAndHoldStrategyPlugin(): StrategyPlugin {
  return {
    id: "buy-and-hold",
    version: "strategy-plugin-v1",
    prepare: () => ({}),
    features: () => ({}),
    decide: ({ index }) => ({ targetExposure: 1, reason: index === 0 ? "enter buy-and-hold baseline" : "hold buy-and-hold baseline", thresholds: {}, weights: {} }),
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => defaultAttribution(),
  };
}

export function timeSlicedAccumulationPlugin(params: { slices?: number; maxExposure?: number } = {}): StrategyPlugin<{ slice: number; targetExposure: number }> {
  const slices = Math.max(1, Math.floor(params.slices ?? 10));
  const maxExposure = clamp(params.maxExposure ?? 1);
  return {
    id: "time-sliced-accumulation",
    version: "strategy-plugin-v1",
    prepare: ({ index }) => {
      const slice = index + 1;
      return { slice, targetExposure: Math.min(maxExposure, slice / slices * maxExposure) };
    },
    features: ({ prepared }) => ({ slice: prepared.slice, slices }),
    decide: ({ prepared, features }) => ({
      targetExposure: prepared.targetExposure,
      reason: prepared.targetExposure >= maxExposure ? "accumulation complete" : "scheduled accumulation",
      features,
      thresholds: { slices, maxExposure },
      weights: { scheduleProgress: maxExposure ? prepared.targetExposure / maxExposure : 0 },
    }),
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => defaultAttribution(),
  };
}

export function movingAverageTrendPlugin(params: { fast?: number; slow?: number; exposure?: number } = {}): StrategyPlugin<{ fastAverage: number | null; slowAverage: number | null }> {
  const fast = Math.max(2, Math.floor(params.fast ?? 5));
  const slow = Math.max(fast + 1, Math.floor(params.slow ?? 20));
  const exposure = clamp(params.exposure ?? 1);
  return {
    id: "moving-average-trend",
    version: "strategy-plugin-v1",
    prepare: ({ history, index }) => {
      const closes = closesThrough(history, index);
      return {
        fastAverage: closes.length >= fast ? average(closes.slice(-fast)) : null,
        slowAverage: closes.length >= slow ? average(closes.slice(-slow)) : null,
      };
    },
    features: ({ prepared }) => ({ fastAverage: prepared.fastAverage, slowAverage: prepared.slowAverage }),
    decide: ({ features }) => {
      const riskOn = features.fastAverage !== null && features.slowAverage !== null && features.fastAverage > features.slowAverage;
      return {
        targetExposure: riskOn ? exposure : 0,
        reason: riskOn ? "fast average above slow average" : "trend confirmation unavailable or bearish",
        features,
        thresholds: { fast, slow, exposure },
        weights: { trend: riskOn ? 1 : 0 },
      };
    },
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => defaultAttribution(),
  };
}

export function meanReversionPlugin(params: { lookback?: number; entryZScore?: number; exitZScore?: number; exposure?: number } = {}): StrategyPlugin<{ price: number | null; mean: number | null; zScore: number | null }> {
  const lookback = Math.max(3, Math.floor(params.lookback ?? 20));
  const entryZScore = Number.isFinite(params.entryZScore) ? params.entryZScore! : -2;
  const exitZScore = Number.isFinite(params.exitZScore) ? params.exitZScore! : -0.25;
  const exposure = clamp(params.exposure ?? 1);
  let active = false;
  return {
    id: "mean-reversion",
    version: "strategy-plugin-v1",
    prepare: ({ history, index }) => {
      const closes = closesThrough(history, index);
      const window = closes.slice(-lookback);
      const mean = window.length >= lookback ? average(window) : null;
      const deviation = window.length >= lookback ? stdev(window) : null;
      const price = closes.at(-1) ?? null;
      return { price, mean, zScore: mean !== null && deviation && price !== null ? (price - mean) / deviation : null };
    },
    features: ({ prepared }) => ({ price: prepared.price, mean: prepared.mean, zScore: prepared.zScore }),
    decide: ({ features }) => {
      if (features.zScore !== null && features.zScore <= entryZScore) active = true;
      else if (features.zScore !== null && features.zScore >= exitZScore) active = false;
      return {
        targetExposure: active ? exposure : 0,
        reason: active ? "mean reversion entry active" : "waiting for oversold setup",
        features,
        thresholds: { lookback, entryZScore, exitZScore, exposure },
        weights: { zScore: features.zScore ?? 0 },
      };
    },
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => defaultAttribution(),
  };
}

export function breakoutMomentumPlugin(params: { lookback?: number; volumeLookback?: number; volumeMultiple?: number; exposure?: number; stopLossPercent?: number } = {}): StrategyPlugin<{ price: number | null; currentHigh: number | null; priorHigh: number | null; currentVolume: number | null; averageVolume: number | null; breakoutPercent: number | null; volumeRatio: number | null }> {
  const lookback = Math.max(2, Math.floor(params.lookback ?? 20));
  const volumeLookback = Math.max(2, Math.floor(params.volumeLookback ?? lookback));
  const volumeMultiple = Math.max(0.1, Number.isFinite(params.volumeMultiple) ? Number(params.volumeMultiple) : 1.25);
  const exposure = clamp(params.exposure ?? 1);
  const stopLossPercent = Math.max(0, Number.isFinite(params.stopLossPercent) ? Number(params.stopLossPercent) : 8);
  let active = false, entryPrice: number | null = null;
  return {
    id: "breakout-momentum",
    version: "strategy-plugin-v1",
    prepare: ({ history, index }) => {
      const bar = history[index]!;
      const price = Number.isFinite(Number(bar.close)) ? Number(bar.close) : null;
      const currentHigh = Number.isFinite(Number(bar.high ?? bar.close)) ? Number(bar.high ?? bar.close) : null;
      const currentVolume = Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : null;
      const priorHighs = highsBefore(history, index, lookback);
      const priorVolumes = volumesBefore(history, index, volumeLookback);
      const priorHigh = priorHighs.length >= lookback ? Math.max(...priorHighs) : null;
      const averageVolume = priorVolumes.length >= volumeLookback ? average(priorVolumes) : null;
      const breakoutPercent = price !== null && priorHigh ? (price / priorHigh - 1) * 100 : null;
      const volumeRatio = currentVolume !== null && averageVolume ? currentVolume / averageVolume : null;
      return { price, currentHigh, priorHigh, currentVolume, averageVolume, breakoutPercent, volumeRatio };
    },
    features: ({ prepared }) => prepared,
    decide: ({ prepared, features }) => {
      const breakoutConfirmed = prepared.price !== null && prepared.priorHigh !== null && prepared.price > prepared.priorHigh;
      const volumeConfirmed = prepared.volumeRatio !== null && prepared.volumeRatio >= volumeMultiple;
      const stopped = active && entryPrice !== null && stopLossPercent > 0 && prepared.price !== null && prepared.price <= entryPrice * (1 - stopLossPercent / 100);
      if (stopped) {
        active = false;
        entryPrice = null;
      } else if (breakoutConfirmed && volumeConfirmed) {
        active = true;
        entryPrice = prepared.price;
      }
      const reason = stopped
        ? "breakout stop hit"
        : active && breakoutConfirmed && volumeConfirmed
          ? "breakout and volume confirmed"
          : active
            ? "holding breakout momentum exposure"
            : prepared.priorHigh === null || prepared.averageVolume === null
              ? "waiting for breakout history"
              : "waiting for breakout and volume confirmation";
      return {
        targetExposure: active ? exposure : 0,
        reason,
        features,
        thresholds: { lookback, volumeLookback, volumeMultiple, exposure, stopLossPercent },
        weights: {
          breakout: prepared.breakoutPercent === null ? 0 : prepared.breakoutPercent,
          volume: prepared.volumeRatio ?? 0,
        },
      };
    },
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => defaultAttribution(),
  };
}

export function volatilityFilterPlugin(params: { lookback?: number; minVolatilityPercent?: number; maxVolatilityPercent?: number; exposure?: number } = {}): StrategyPlugin<{ price: number | null; realizedVolatilityPercent: number | null; returnCount: number }> {
  const lookback = Math.max(2, Math.floor(params.lookback ?? 20));
  const minVolatilityPercent = Math.max(0, Number.isFinite(params.minVolatilityPercent) ? Number(params.minVolatilityPercent) : 0);
  const maxVolatilityPercent = Math.max(minVolatilityPercent, Number.isFinite(params.maxVolatilityPercent) ? Number(params.maxVolatilityPercent) : 6);
  const exposure = clamp(params.exposure ?? 1);
  return {
    id: "volatility-filter",
    version: "strategy-plugin-v1",
    prepare: ({ history, index }) => {
      const returns = returnsThrough(history, index, lookback);
      const realizedVolatilityPercent = returns.length >= lookback ? (stdev(returns) ?? 0) * 100 : null;
      const price = Number.isFinite(Number(history[index]?.close)) ? Number(history[index]!.close) : null;
      return { price, realizedVolatilityPercent, returnCount: returns.length };
    },
    features: ({ prepared }) => prepared,
    decide: ({ prepared, features }) => {
      const enoughHistory = prepared.realizedVolatilityPercent !== null;
      const withinBand = enoughHistory && prepared.realizedVolatilityPercent! >= minVolatilityPercent && prepared.realizedVolatilityPercent! <= maxVolatilityPercent;
      return {
        targetExposure: withinBand ? exposure : 0,
        reason: !enoughHistory ? "waiting for volatility history" : withinBand ? "realized volatility inside risk band" : "realized volatility outside risk band",
        features,
        thresholds: { lookback, minVolatilityPercent, maxVolatilityPercent, exposure },
        weights: { volatility: prepared.realizedVolatilityPercent ?? 0 },
      };
    },
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => defaultAttribution(),
  };
}

function peerSymbolFor(symbol: string | undefined) {
  return symbol === "ETH/USD" ? "BTC/USD" : "ETH/USD";
}

function returnPercent(history: BacktestBar[] | undefined, index: number, lookback: number) {
  if (!history || index < lookback || !history[index] || !history[index - lookback]) return null;
  const current = Number(history[index]!.close), prior = Number(history[index - lookback]!.close);
  return Number.isFinite(current) && Number.isFinite(prior) && current > 0 && prior > 0 ? (current / prior - 1) * 100 : null;
}

export function btcEthRelativeStrengthPlugin(params: { lookback?: number; minRelativeStrengthPercent?: number; exposure?: number } = {}): StrategyPlugin<{ primaryReturnPercent: number | null; peerReturnPercent: number | null; relativeStrengthPercent: number | null; peerSymbol: string }> {
  const lookback = Math.max(1, Math.floor(params.lookback ?? 20));
  const minRelativeStrengthPercent = Number.isFinite(params.minRelativeStrengthPercent) ? Number(params.minRelativeStrengthPercent) : 0;
  const exposure = clamp(params.exposure ?? 1);
  return {
    id: "btc-eth-relative-strength",
    version: "strategy-plugin-v1",
    prepare: ({ history, index, symbol, market }) => {
      const peerSymbol = peerSymbolFor(symbol);
      const primaryReturnPercent = returnPercent(history, index, lookback);
      const peerReturnPercent = returnPercent(market?.histories?.[peerSymbol], index, lookback);
      const relativeStrengthPercent = primaryReturnPercent !== null && peerReturnPercent !== null ? primaryReturnPercent - peerReturnPercent : null;
      return { primaryReturnPercent, peerReturnPercent, relativeStrengthPercent, peerSymbol };
    },
    features: ({ prepared }) => ({
      primaryReturnPercent: prepared.primaryReturnPercent,
      peerReturnPercent: prepared.peerReturnPercent,
      relativeStrengthPercent: prepared.relativeStrengthPercent,
    }),
    decide: ({ prepared, features, symbol }) => {
      const enoughHistory = prepared.relativeStrengthPercent !== null;
      const riskOn = enoughHistory && prepared.relativeStrengthPercent! >= minRelativeStrengthPercent;
      return {
        targetExposure: riskOn ? exposure : 0,
        reason: !enoughHistory ? "waiting for BTC/ETH relative strength history" : riskOn ? "primary crypto outperforming BTC/ETH peer" : "BTC/ETH peer stronger or edge below threshold",
        features,
        thresholds: { lookback, minRelativeStrengthPercent, exposure, primarySymbol: symbol ?? null, peerSymbol: prepared.peerSymbol },
        weights: { relativeStrength: prepared.relativeStrengthPercent ?? 0 },
      };
    },
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => ({ windows: ["1h", "1d", "7d"], baselines: ["cash", "buy-and-hold"] }),
  };
}

type BookLevel = { price: number; size: number };

function normalizeBookLevels(orderbook: any, side: "bid" | "ask", maxDepthLevels: number): BookLevel[] {
  const raw = side === "bid" ? orderbook?.b ?? orderbook?.bids ?? [] : orderbook?.a ?? orderbook?.asks ?? [];
  return raw.map((level: any) => {
    const price = Number(level?.p ?? level?.price ?? level?.[0]);
    const size = Number(level?.s ?? level?.size ?? level?.[1]);
    return Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0 ? { price, size } : null;
  })
    .filter((level: BookLevel | null): level is BookLevel => Boolean(level))
    .sort((a: BookLevel, b: BookLevel) => side === "ask" ? a.price - b.price : b.price - a.price)
    .slice(0, maxDepthLevels);
}

function notional(levels: BookLevel[]) {
  return levels.reduce((sum, level) => sum + level.price * level.size, 0);
}

export function orderBookLiquidityScoutPlugin(params: { exposure?: number; maxSpreadBps?: number; minVisibleAskNotional?: number; minVisibleBidNotional?: number; maxDepthLevels?: number } = {}): StrategyPlugin<{ bid: number | null; ask: number | null; spreadBps: number | null; visibleAskNotional: number | null; visibleBidNotional: number | null; askLevels: number; bidLevels: number }> {
  const exposure = clamp(params.exposure ?? 1);
  const maxSpreadBps = Math.max(1, Number.isFinite(params.maxSpreadBps) ? Number(params.maxSpreadBps) : 100);
  const minVisibleAskNotional = Math.max(0, Number.isFinite(params.minVisibleAskNotional) ? Number(params.minVisibleAskNotional) : 500);
  const minVisibleBidNotional = Math.max(0, Number.isFinite(params.minVisibleBidNotional) ? Number(params.minVisibleBidNotional) : 500);
  const maxDepthLevels = Math.max(1, Math.min(100, Math.floor(Number.isFinite(params.maxDepthLevels) ? Number(params.maxDepthLevels) : 25)));
  return {
    id: "order-book-liquidity-scout",
    version: "strategy-plugin-v1",
    prepare: ({ symbol, market }) => {
      const snapshot = symbol ? market?.snapshots?.[symbol] : null;
      const orderbook = snapshot?.payload?.orderbook ?? snapshot?.orderbook ?? null;
      const bids = normalizeBookLevels(orderbook, "bid", maxDepthLevels);
      const asks = normalizeBookLevels(orderbook, "ask", maxDepthLevels);
      const bid = bids[0]?.price ?? null, ask = asks[0]?.price ?? null;
      const midpoint = bid && ask ? (bid + ask) / 2 : null;
      const spreadBps = midpoint && ask! >= bid! ? (ask! - bid!) / midpoint * 10_000 : null;
      return { bid, ask, spreadBps, visibleAskNotional: asks.length ? notional(asks) : null, visibleBidNotional: bids.length ? notional(bids) : null, askLevels: asks.length, bidLevels: bids.length };
    },
    features: ({ prepared }) => prepared,
    decide: ({ prepared, features }) => {
      const hasBook = prepared.spreadBps !== null && prepared.visibleAskNotional !== null && prepared.visibleBidNotional !== null;
      const liquid = hasBook && prepared.spreadBps! <= maxSpreadBps && prepared.visibleAskNotional! >= minVisibleAskNotional && prepared.visibleBidNotional! >= minVisibleBidNotional;
      return {
        targetExposure: liquid ? exposure : 0,
        reason: !hasBook ? "waiting for order-book liquidity snapshot" : liquid ? "order-book liquidity meets scout thresholds" : "order-book liquidity below scout thresholds",
        features,
        thresholds: { exposure, maxSpreadBps, minVisibleAskNotional, minVisibleBidNotional, maxDepthLevels },
        weights: { spreadBps: prepared.spreadBps ?? 0, visibleAskNotional: prepared.visibleAskNotional ?? 0, visibleBidNotional: prepared.visibleBidNotional ?? 0 },
      };
    },
    riskAdjust: ({ decision }) => defaultRiskAdjustment(decision),
    orders: ({ risk, decision }) => targetExposureOrder(risk.targetExposure, decision.reason),
    attribution: () => defaultAttribution(),
  };
}

export function strategyFromId(strategyId: string, params: unknown = {}): BacktestStrategy {
  return strategyFunctionFromPlugin(strategyPluginFromId(strategyId, params));
}

export function strategyPluginFromId(strategyId: string, params: unknown = {}): StrategyPlugin {
  if (strategyId === "cash") { parseStrategyParams("cash", params); return cashStrategyPlugin(); }
  if (strategyId === "buy-and-hold") { parseStrategyParams("buy-and-hold", params); return buyAndHoldStrategyPlugin(); }
  if (strategyId === "time-sliced-accumulation") return timeSlicedAccumulationPlugin(parseStrategyParams("time-sliced-accumulation", params));
  if (strategyId === "moving-average-trend") return movingAverageTrendPlugin(parseStrategyParams("moving-average-trend", params));
  if (strategyId === "mean-reversion") return meanReversionPlugin(parseStrategyParams("mean-reversion", params));
  if (strategyId === "breakout-momentum") return breakoutMomentumPlugin(parseStrategyParams("breakout-momentum", params));
  if (strategyId === "volatility-filter") return volatilityFilterPlugin(parseStrategyParams("volatility-filter", params));
  if (strategyId === "btc-eth-relative-strength") return btcEthRelativeStrengthPlugin(parseStrategyParams("btc-eth-relative-strength", params));
  if (strategyId === "order-book-liquidity-scout") return orderBookLiquidityScoutPlugin(parseStrategyParams("order-book-liquidity-scout", params));
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
