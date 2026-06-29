import { expect, test } from "bun:test";
import { buyAndHoldStrategy, cashStrategy, meanReversionStrategy, movingAverageTrendStrategy, runBacktest, strategyFromId, timeSlicedAccumulationStrategy, walkForwardWindows } from "./strategy-backtest";

const bars = [
  { timestamp: "2026-01-01T00:00:00Z", close: 100 },
  { timestamp: "2026-01-02T00:00:00Z", close: 110 },
  { timestamp: "2026-01-03T00:00:00Z", close: 105 },
  { timestamp: "2026-01-04T00:00:00Z", close: 120 },
];

test("backtests cash and buy-and-hold baselines with costs", () => {
  const cash = runBacktest({ strategyId: "cash", bars, strategy: cashStrategy, initialCash: 1000 });
  expect(cash).toMatchObject({ finalEquity: 1000, totalReturnPercent: 0, turnover: 0, exposureTimePercent: 0 });

  const hold = runBacktest({ strategyId: "buy-and-hold", bars, strategy: buyAndHoldStrategy, initialCash: 1000, feeBps: 10, slippageBps: 0 });
  expect(hold.finalEquity).toBeCloseTo(1198.907947);
  expect(hold.totalCost).toBeCloseTo(1);
  expect(hold.turnoverPercent).toBeCloseTo(100.1001);
  expect(hold.maxDrawdownPercent).toBeGreaterThan(0);
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

test("walk-forward windows split ordered samples without overlap inside a fold", () => {
  expect(walkForwardWindows([1, 2, 3, 4, 5, 6], 3, 1)).toEqual([
    { train: [1, 2, 3], test: [4], trainStart: 0, testStart: 3 },
    { train: [2, 3, 4], test: [5], trainStart: 1, testStart: 4 },
    { train: [3, 4, 5], test: [6], trainStart: 2, testStart: 5 },
  ]);
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

test("strategy factory exposes the initial crypto strategy catalog", () => {
  expect(strategyFromId("time-sliced-accumulation", { slices: 2 })(bars, 0).targetExposure).toBe(0.5);
  expect(typeof strategyFromId("moving-average-trend", { fast: 2, slow: 3 })).toBe("function");
  expect(typeof strategyFromId("mean-reversion", { lookback: 3 })).toBe("function");
  expect(() => strategyFromId("unknown")).toThrow("Unknown strategyId");
});
