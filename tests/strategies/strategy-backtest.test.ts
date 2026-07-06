import { expect, test } from "bun:test";
import { breakoutMomentumStrategy, btcEthRelativeStrengthStrategy, buildReturnUncertainty, buyAndHoldStrategy, cashStrategy, evaluateStrategyPlugin, meanReversionStrategy, movingAverageTrendStrategy, orderBookLiquidityScoutStrategy, parseStrategyParams, runBacktest, STRATEGY_IDS, strategyFromId, strategyPluginFromId, timeSlicedAccumulationStrategy, volatilityFilterStrategy, walkForwardWindows } from "../../backend/features/strategies/strategy-backtest";

const bars = [
  { timestamp: "2026-01-01T00:00:00Z", close: 100 },
  { timestamp: "2026-01-02T00:00:00Z", close: 110 },
  { timestamp: "2026-01-03T00:00:00Z", close: 105 },
  { timestamp: "2026-01-04T00:00:00Z", close: 120 },
];

test("backtests cash and buy-and-hold baselines with costs", () => {
  const cash = runBacktest({ strategyId: "cash", bars, strategy: cashStrategy, initialCash: 1000 });
  expect(cash).toMatchObject({
    finalEquity: 1000,
    totalReturnPercent: 0,
    turnover: 0,
    exposureTimePercent: 0,
    tradeMetrics: {
      tradeCount: 0,
      positionEpisodeCount: 0,
      roundTripCount: 0,
      grossReturnPercent: 0,
      netReturnPercent: 0,
      hitRatePercent: null,
    },
    uncertainty: {
      status: "insufficient_data",
      method: "moving_block_bootstrap",
      sampleSize: 4,
      minimumSampleSize: 20,
      totalReturnPercent: null,
      maxDrawdownPercent: null,
      rankingUse: "not_rankable",
    },
  });

  const hold = runBacktest({ strategyId: "buy-and-hold", bars, strategy: buyAndHoldStrategy, initialCash: 1000, feeBps: 10, slippageBps: 0 });
  expect(hold.finalEquity).toBeCloseTo(1198.907947);
  expect(hold.totalCost).toBeCloseTo(1);
  expect(hold.turnoverPercent).toBeCloseTo(100.1001);
  expect(hold.maxDrawdownPercent).toBeGreaterThan(0);
  expect(hold.tradeMetrics).toMatchObject({
    tradeCount: 2,
    positionEpisodeCount: 1,
    roundTripCount: 0,
    hitRatePercent: null,
    netReturnPercent: hold.totalReturnPercent,
    turnoverPercent: hold.turnoverPercent,
    exposureTimePercent: 100,
    capacityWarnings: ["high_exposure_capacity_risk"],
  });
  expect(hold.tradeMetrics.grossReturnPercent).toBeGreaterThan(
    hold.tradeMetrics.netReturnPercent,
  );
  expect(hold.tradeMetrics.averageHoldingBars).toBe(4);
  expect(hold.tradeMetrics.averageHoldingDays).toBe(3);
});

test("backtest uncertainty ranges use deterministic moving-block bootstrap", () => {
  const trend = Array.from({ length: 30 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    close: 100 + index + (index % 5 === 0 ? -3 : 2),
  }));
  const result = runBacktest({
    strategyId: "buy-and-hold",
    bars: trend,
    strategy: buyAndHoldStrategy,
    initialCash: 1_000,
    feeBps: 0,
    slippageBps: 0,
  });

  expect(result.uncertainty).toMatchObject({
    status: "available",
    method: "moving_block_bootstrap",
    confidenceLevel: 0.9,
    lowerPercentile: 5,
    upperPercentile: 95,
    sampleSize: 30,
    minimumSampleSize: 20,
    resamples: 500,
    blockLength: 6,
    rankingUse: "not_rankable",
  });
  expect(result.uncertainty.totalReturnPercent?.pointEstimate).toBeCloseTo(
    result.totalReturnPercent,
  );
  expect(result.uncertainty.totalReturnPercent!.lowerPercentile).toBeLessThanOrEqual(
    result.uncertainty.totalReturnPercent!.median,
  );
  expect(result.uncertainty.totalReturnPercent!.median).toBeLessThanOrEqual(
    result.uncertainty.totalReturnPercent!.upperPercentile,
  );
  expect(result.uncertainty.maxDrawdownPercent?.pointEstimate).toBeCloseTo(
    result.maxDrawdownPercent,
  );

  expect(buildReturnUncertainty([0.01, -0.02])).toMatchObject({
    status: "insufficient_data",
    sampleSize: 2,
    blockLength: null,
    totalReturnPercent: null,
    maxDrawdownPercent: null,
  });
});

test("backtest strategy records decisions, features and bounded exposure", () => {
  const result = runBacktest({
    strategyId: "threshold",
    bars,
    initialCash: 1000,
    slippageBps: 0,
    strategy(history, index) {
      const price = history[index]!.close;
      return { targetExposure: price < 108 ? 2 : 0, reason: price < 108 ? "risk on" : "risk off", features: { price } };
    },
  });
  expect(result.points[0]).toMatchObject({ targetExposure: 1, reason: "risk on", features: { price: 100 } });
  expect(result.points[1]).toMatchObject({ targetExposure: 0, reason: "risk off" });
});

test("regression: backtest sorts valid bars and ignores malformed bars", () => {
  const result = runBacktest({
    strategyId: "data-hygiene",
    initialCash: 1_000,
    bars: [
      { timestamp: "not-a-date", close: 999 },
      { timestamp: "2026-01-03T00:00:00Z", close: 120 },
      { timestamp: "2026-01-01T00:00:00Z", close: 100 },
      { timestamp: "2026-01-02T00:00:00Z", close: -5 },
      { timestamp: "2026-01-02T00:00:00Z", close: 110 },
    ],
    strategy(history, index) {
      return { targetExposure: 0, reason: `bar-${index}`, features: { close: history[index]!.close } };
    },
  });

  expect(result.points.map(point => point.timestamp)).toEqual([
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
    "2026-01-03T00:00:00.000Z",
  ]);
  expect(result.points.map(point => point.features?.close)).toEqual([100, 110, 120]);
  expect(result).toMatchObject({ finalEquity: 1_000, turnover: 0 });
});

test("rejects invalid backtest inputs instead of producing metrics", () => {
  expect(() => runBacktest({ strategyId: "too-short", bars: [{ timestamp: "2026-01-01T00:00:00Z", close: 100 }], strategy: cashStrategy })).toThrow("At least two valid bars are required");
  expect(() => runBacktest({ strategyId: "bad-cash", bars, strategy: cashStrategy, initialCash: 0 })).toThrow("Invalid backtest assumptions");
  expect(() => runBacktest({ strategyId: "bad-costs", bars, strategy: cashStrategy, feeBps: -1 })).toThrow("Invalid backtest assumptions");
});

test("walk-forward windows split ordered samples without overlap inside a fold", () => {
  expect(walkForwardWindows([1, 2, 3, 4, 5, 6], 3, 1)).toEqual([
    { train: [1, 2, 3], test: [4], trainStart: 0, testStart: 3 },
    { train: [2, 3, 4], test: [5], trainStart: 1, testStart: 4 },
    { train: [3, 4, 5], test: [6], trainStart: 2, testStart: 5 },
  ]);
});

test("backtest evaluation warmup exposes history without scoring train bars", () => {
  const history = [100, 101, 102, 103, 104].map((close, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    close,
  }));
  const result = runBacktest({
    strategyId: "moving-average-trend",
    bars: history,
    strategy: movingAverageTrendStrategy({ fast: 2, slow: 3 }),
    initialCash: 1_000,
    feeBps: 0,
    slippageBps: 0,
    evaluationStartIndex: 3,
  });
  expect(result.points).toHaveLength(2);
  expect(result.points[0]).toMatchObject({
    timestamp: "2026-01-04T00:00:00.000Z",
    features: { fastAverage: 102.5, slowAverage: 102 },
  });
  expect(() =>
    runBacktest({
      strategyId: "cash",
      bars: history,
      strategy: cashStrategy,
      evaluationStartIndex: 5,
    }),
  ).toThrow("evaluation start");
});

test("backtest trade metrics summarize episodes, downside risk and capacity warnings", () => {
  const choppyBars = [100, 110, 90, 90, 100, 95].map((close, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    close,
  }));
  const result = runBacktest({
    strategyId: "episode-metrics",
    bars: choppyBars,
    initialCash: 1_000,
    feeBps: 0,
    slippageBps: 0,
    strategy(_history, index) {
      return {
        targetExposure: [1, 1, 0, 1, 1, 0][index]!,
        reason: "test exposure schedule",
      };
    },
  });

  expect(result.tradeMetrics).toMatchObject({
    tradeCount: 4,
    positionEpisodeCount: 2,
    roundTripCount: 2,
    hitRatePercent: 50,
    averageHoldingBars: 3,
    averageHoldingDays: 2,
    turnoverPercent: result.turnoverPercent,
    exposureTimePercent: result.exposureTimePercent,
    capacityWarnings: ["high_turnover_capacity_risk", "high_trade_frequency_capacity_risk"],
  });
  expect(result.tradeMetrics.averageWinPercent).toBeCloseTo(5.555555);
  expect(result.tradeMetrics.averageLossPercent).toBeCloseTo(-10);
  expect(result.tradeMetrics.profitFactor).toBeCloseTo(0.555555);
  expect(result.tradeMetrics.downsideDeviationPercent).toBeGreaterThan(0);
  expect(result.tradeMetrics.sortinoRatio).toBeLessThan(1);
  expect(result.tradeMetrics.calmarRatio).not.toBeNull();
});

test("time-sliced accumulation ramps exposure deterministically", () => {
  const result = runBacktest({ strategyId: "time-sliced-accumulation", bars, strategy: timeSlicedAccumulationStrategy({ slices: 4 }), initialCash: 1000, slippageBps: 0 });
  expect(result.points.map(point => point.targetExposure)).toEqual([0.25, 0.5, 0.75, 1]);
  expect(result.points[0]?.reason).toBe("scheduled accumulation");
});

test("moving-average trend waits for confirmation then follows the trend", () => {
  const trendBars = [1, 2, 3, 4, 5, 6].map((close, index) => ({ timestamp: `2026-01-0${index + 1}T00:00:00Z`, close }));
  const strategy = movingAverageTrendStrategy({ fast: 2, slow: 3 });
  const decisions = trendBars.map((_, index) => strategy(trendBars, index));
  expect(decisions.slice(0, 2).map(decision => decision.targetExposure)).toEqual([0, 0]);
  expect(decisions.at(-1)).toMatchObject({ targetExposure: 1, reason: "fast average above slow average" });
});

test("mean reversion enters on oversold z-score and exits near mean", () => {
  const reversionBars = [100, 100, 100, 90, 100].map((close, index) => ({ timestamp: `2026-01-0${index + 1}T00:00:00Z`, close }));
  const strategy = meanReversionStrategy({ lookback: 3, entryZScore: -1, exitZScore: -0.1 });
  const decisions = reversionBars.map((_, index) => strategy(reversionBars, index));
  expect(decisions[3]?.targetExposure).toBe(1);
  expect(decisions[4]?.targetExposure).toBe(0);
});

test("breakout momentum requires prior high and volume confirmation", () => {
  const breakoutBars = [
    { timestamp: "2026-01-01T00:00:00Z", high: 100, close: 95, volume: 100 },
    { timestamp: "2026-01-02T00:00:00Z", high: 101, close: 100, volume: 100 },
    { timestamp: "2026-01-03T00:00:00Z", high: 102, close: 101, volume: 100 },
    { timestamp: "2026-01-04T00:00:00Z", high: 104, close: 103, volume: 220 },
    { timestamp: "2026-01-05T00:00:00Z", high: 104, close: 94, volume: 120 },
  ];
  const strategy = breakoutMomentumStrategy({ lookback: 3, volumeLookback: 3, volumeMultiple: 1.5, stopLossPercent: 5, exposure: 0.8 });
  const decisions = breakoutBars.map((_, index) => strategy(breakoutBars, index));
  expect(decisions[2]).toMatchObject({ targetExposure: 0, reason: "waiting for breakout history" });
  expect(decisions[3]).toMatchObject({ targetExposure: 0.8, reason: "breakout and volume confirmed", features: { priorHigh: 102, volumeRatio: 2.2 }, thresholds: { lookback: 3, volumeMultiple: 1.5 } });
  expect(decisions[4]).toMatchObject({ targetExposure: 0, reason: "breakout stop hit" });
});

test("volatility filter enters only when realized volatility is inside the configured band", () => {
  const calmBars = [100, 101, 102, 103].map((close, index) => ({ timestamp: `2026-01-0${index + 1}T00:00:00Z`, close }));
  const jumpyBars = [100, 120, 90, 130].map((close, index) => ({ timestamp: `2026-02-0${index + 1}T00:00:00Z`, close }));
  const calm = volatilityFilterStrategy({ lookback: 3, maxVolatilityPercent: 2, exposure: 0.6 });
  const jumpy = volatilityFilterStrategy({ lookback: 3, maxVolatilityPercent: 2, exposure: 0.6 });

  expect(calm(calmBars, 2)).toMatchObject({ targetExposure: 0, reason: "waiting for volatility history" });
  expect(calm(calmBars, 3)).toMatchObject({ targetExposure: 0.6, reason: "realized volatility inside risk band" });
  expect(jumpy(jumpyBars, 3)).toMatchObject({ targetExposure: 0, reason: "realized volatility outside risk band" });
});

test("BTC/ETH relative strength compares primary and peer returns", () => {
  const btcBars = [100, 105, 120].map((close, index) => ({ timestamp: `2026-01-0${index + 1}T00:00:00Z`, close }));
  const ethBars = [100, 102, 104].map((close, index) => ({ timestamp: `2026-01-0${index + 1}T00:00:00Z`, close }));
  const strategy = btcEthRelativeStrengthStrategy({ lookback: 2, minRelativeStrengthPercent: 5, exposure: 0.7 }, { histories: { "BTC/USD": btcBars, "ETH/USD": ethBars } }, "BTC/USD");

  const strong = strategy(btcBars, 2);
  expect(strong).toMatchObject({
    targetExposure: 0.7,
    reason: "primary crypto outperforming BTC/ETH peer",
    thresholds: { lookback: 2, minRelativeStrengthPercent: 5, primarySymbol: "BTC/USD", peerSymbol: "ETH/USD" },
  });
  expect(strong.features?.primaryReturnPercent).toBeCloseTo(20);
  expect(strong.features?.peerReturnPercent).toBeCloseTo(4);
  expect(strong.features?.relativeStrengthPercent).toBeCloseTo(16);

  const weak = btcEthRelativeStrengthStrategy({ lookback: 2, minRelativeStrengthPercent: 5 }, { histories: { "BTC/USD": ethBars, "ETH/USD": btcBars } }, "BTC/USD");
  expect(weak(ethBars, 2)).toMatchObject({ targetExposure: 0, reason: "BTC/ETH peer stronger or edge below threshold" });
});

test("order-book liquidity scout requires tight spread and visible depth", () => {
  const scoutBars = [{ timestamp: "2026-01-01T00:00:00Z", close: 100 }];
  const liquid = orderBookLiquidityScoutStrategy({ exposure: 0.5, maxSpreadBps: 250, minVisibleAskNotional: 100, minVisibleBidNotional: 100 }, {
    snapshots: {
      "BTC/USD": {
        payload: {
          orderbook: {
            bids: [{ p: 99, s: 2 }],
            asks: [{ p: 101, s: 2 }],
          },
        },
      },
    },
  }, "BTC/USD");
  expect(liquid(scoutBars, 0)).toMatchObject({
    targetExposure: 0.5,
    reason: "order-book liquidity meets scout thresholds",
    features: { bid: 99, ask: 101, visibleAskNotional: 202, visibleBidNotional: 198 },
  });

  const thin = orderBookLiquidityScoutStrategy({ minVisibleAskNotional: 1_000, minVisibleBidNotional: 100 }, {
    snapshots: { "BTC/USD": { payload: { orderbook: { b: [{ p: 99, s: 2 }], a: [{ p: 101, s: 2 }] } } } },
  }, "BTC/USD");
  expect(thin(scoutBars, 0)).toMatchObject({ targetExposure: 0, reason: "order-book liquidity below scout thresholds" });

  expect(orderBookLiquidityScoutStrategy({}, {}, "BTC/USD")(scoutBars, 0)).toMatchObject({ targetExposure: 0, reason: "waiting for order-book liquidity snapshot" });
});

test("strategy factory exposes the initial crypto strategy catalog", () => {
  expect(strategyFromId("time-sliced-accumulation", { slices: 2 })(bars, 0).targetExposure).toBe(0.5);
  expect(typeof strategyFromId("moving-average-trend", { fast: 2, slow: 3 })).toBe("function");
  expect(typeof strategyFromId("mean-reversion", { lookback: 3 })).toBe("function");
  expect(typeof strategyFromId("breakout-momentum", { lookback: 3 })).toBe("function");
  expect(typeof strategyFromId("volatility-filter", { lookback: 3 })).toBe("function");
  expect(typeof strategyFromId("btc-eth-relative-strength", { lookback: 2 })).toBe("function");
  expect(typeof strategyFromId("order-book-liquidity-scout", { maxSpreadBps: 100 })).toBe("function");
  expect(() => strategyFromId("unknown")).toThrow("Unknown strategyId");
});

test("strategy configuration applies one canonical set of defaults", () => {
  expect(parseStrategyParams("cash")).toEqual({});
  expect(parseStrategyParams("time-sliced-accumulation")).toEqual({ slices: 10, maxExposure: 1 });
  expect(parseStrategyParams("moving-average-trend")).toEqual({ fast: 5, slow: 20, exposure: 1 });
  expect(parseStrategyParams("mean-reversion")).toEqual({ lookback: 20, entryZScore: -2, exitZScore: -0.25, exposure: 1 });
  expect(parseStrategyParams("breakout-momentum", { lookback: 12 })).toEqual({ lookback: 12, volumeLookback: 12, volumeMultiple: 1.25, stopLossPercent: 8, exposure: 1 });
  expect(parseStrategyParams("volatility-filter")).toEqual({ lookback: 20, minVolatilityPercent: 0, maxVolatilityPercent: 6, exposure: 1 });
  expect(parseStrategyParams("btc-eth-relative-strength")).toEqual({ lookback: 20, minRelativeStrengthPercent: 0, exposure: 1 });
  expect(parseStrategyParams("order-book-liquidity-scout")).toEqual({ exposure: 1, maxSpreadBps: 100, minVisibleAskNotional: 500, minVisibleBidNotional: 500, maxDepthLevels: 25 });
  for (const strategyId of STRATEGY_IDS) expect(strategyPluginFromId(strategyId).id).toBe(strategyId);
});

test("strategy configuration rejects malformed and contradictory parameters", () => {
  expect(() => parseStrategyParams("cash", { exposure: 0 })).toThrow("Unrecognized key");
  expect(() => parseStrategyParams("moving-average-trend", { fast: "5", slow: 20 })).toThrow("expected number");
  expect(() => parseStrategyParams("moving-average-trend", { fast: 20, slow: 20 })).toThrow("slow must be greater than fast");
  expect(() => parseStrategyParams("mean-reversion", { entryZScore: 0, exitZScore: -1 })).toThrow("entryZScore must be less than exitZScore");
  expect(() => parseStrategyParams("volatility-filter", { minVolatilityPercent: 10, maxVolatilityPercent: 5 })).toThrow("maxVolatilityPercent must be at least minVolatilityPercent");
  expect(() => parseStrategyParams("breakout-momentum", { volumeMultiple: Number.NaN })).toThrow("expected number");
  expect(() => parseStrategyParams("btc-eth-relative-strength", { peerSymbol: "BTC/USD" })).toThrow("Unrecognized key");
  expect(() => parseStrategyParams("order-book-liquidity-scout", { exposure: 1.1 })).toThrow("Too big");
  expect(() => parseStrategyParams("order-book-liquidity-scout", { maxDepthLevels: 101 })).toThrow("Too big");
  expect(() => parseStrategyParams("unknown", {})).toThrow("Unknown strategyId");
});

test("strategy plugins expose deterministic prepare features decide risk orders and attribution steps", () => {
  const trendBars = [1, 2, 3, 4].map((close, index) => ({ timestamp: `2026-01-0${index + 1}T00:00:00Z`, close }));
  const plugin = strategyPluginFromId("moving-average-trend", { fast: 2, slow: 3, exposure: 0.75 });
  const evaluation = evaluateStrategyPlugin(plugin, trendBars, trendBars.length - 1, "BTC/USD");

  expect(plugin).toMatchObject({ id: "moving-average-trend", version: "strategy-plugin-v1" });
  for (const step of ["prepare", "features", "decide", "riskAdjust", "orders", "attribution"] as const) expect(typeof plugin[step]).toBe("function");
  expect(evaluation).toMatchObject({
    targetExposure: 0.75,
    reason: "fast average above slow average",
    features: { fastAverage: 3.5, slowAverage: 3 },
    weights: { trend: 1 },
    thresholds: { fast: 2, slow: 3, exposure: 0.75 },
    risk: { allowed: true, rawTargetExposure: 0.75, riskAdjustedSignal: 0.75, reasons: [] },
    orders: [{ type: "target_exposure", targetExposure: 0.75 }],
    attribution: { windows: ["1h", "1d", "7d"], baselines: ["cash", "buy-and-hold"] },
  });
});
