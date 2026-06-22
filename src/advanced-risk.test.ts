import { expect, test } from "bun:test";
import { advancedPortfolioRisk, positionLiquidity } from "./advanced-risk";

test("calculates tail risk, correlations, contribution and benchmark diagnostics", () => {
  const result = advancedPortfolioRisk(100_000, [
    { symbol: "A", weight: .6, closes: [100, 101, 99, 102, 98, 103] },
    { symbol: "B", weight: .4, closes: [50, 50.5, 49.7, 51, 49, 52] },
  ], [400, 402, 398, 405, 395, 410]);
  expect(result.observations).toBe(5);
  expect(result.expectedShortfall95).toBeGreaterThanOrEqual(result.historicalVar95);
  expect(result.parametricVar95).toBeGreaterThan(0);
  expect(result.correlation[0]?.values[0]?.correlation).toBeCloseTo(1);
  expect(result.riskContribution.reduce((sum, item) => sum + item.percent, 0)).toBeCloseTo(100);
  expect(result.benchmark.beta).not.toBeNull();
});

test("calculates spread and liquidation time from Alpaca liquidity data", () => {
  expect(positionLiquidity({ symbol: "A", qty: 1000, marketValue: 100_000 }, { latestQuote: { bp: 99, ap: 101 } }, [{ volume: 5000 }, { volume: 15000 }])).toMatchObject({ spreadBps: 200, averageDailyVolume: 10000, daysAtTenPercentAdv: 1 });
});
