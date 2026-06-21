import { describe, expect, test } from "bun:test";
import { diversificationScore, performancePoints, performanceSummary, stressTests, valueAtRisk95 } from "./analytics";

describe("portfolio analytics", () => {
  const points = performancePoints({ timestamp: [1, 2, 3], equity: [100, 110, 99], profitLoss: [0, 10, -1], profitLossPct: [0, .1, -.01] });

  test("normalizes broker history and summarizes performance", () => {
    expect(points.at(-1)).toMatchObject({ timestamp: 3000, equity: 99, profitLossPercent: -1 });
    const summary = performanceSummary(points);
    expect(summary).toMatchObject({ totalProfitLoss: -1, totalReturnPercent: -1, positiveDaysPercent: 50 });
    expect(summary.bestDayPercent).toBeCloseTo(10);
    expect(summary.worstDayPercent).toBeCloseTo(-10);
  });

  test("ignores broker placeholders from before an account was funded", () => {
    expect(performancePoints({ timestamp: [1, 2], equity: [0, 100], profitLoss: [0, 0], profitLossPct: [0, 0] })).toHaveLength(1);
  });

  test("calculates historical value at risk", () => {
    const result = valueAtRisk95(10_000, [1, 1.02, .969]);
    expect(result.valueAtRisk95Percent).toBeCloseTo(5);
    expect(result.valueAtRisk95).toBeCloseTo(500);
    expect(valueAtRisk95(10_000, [])).toEqual({ valueAtRisk95Percent: 0, valueAtRisk95: 0 });
  });

  test("builds transparent stress scenarios and diversification score", () => {
    const scenarios = stressTests(10_000, 2_000, [{ symbol: "AAPL", percent: 30 }]);
    expect(scenarios[0]).toMatchObject({ estimatedLoss: 800, resultingEquity: 9_200 });
    expect(scenarios[2]).toMatchObject({ estimatedLoss: 750, resultingEquity: 9_250 });
    expect(diversificationScore(.1, 20)).toEqual({ score: 75, label: "Well diversified" });
  });
});
