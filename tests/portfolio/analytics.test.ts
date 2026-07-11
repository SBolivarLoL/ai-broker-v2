import { describe, expect, test } from "bun:test";
import {
  benchmarkAttribution,
  diversificationScore,
  diversificationScopes,
  moneyWeightedReturn,
  performancePoints,
  portfolioPerformanceDto,
  performanceSummary,
  stressTests,
  timeWeightedReturn,
  valueAtRisk95,
} from "../../backend/features/portfolio/analytics";

describe("portfolio analytics", () => {
  const points = performancePoints({
    timestamp: [1, 2, 3],
    equity: [100, 110, 99],
    profitLoss: [0, 10, -1],
    profitLossPct: [0, 0.1, -0.01],
  });

  test("normalizes broker history and summarizes performance", () => {
    expect(points.at(-1)).toMatchObject({
      timestamp: 3000,
      equity: 99,
      profitLossPercent: -1,
      externalCashFlow: 0,
    });
    const summary = performanceSummary(points);
    expect(summary).toMatchObject({
      totalProfitLoss: -1,
      totalReturnPercent: -1,
      positiveDaysPercent: 50,
    });
    expect(summary.bestDayPercent).toBeCloseTo(10);
    expect(summary.worstDayPercent).toBeCloseTo(-10);
  });

  test("cashflow-adjusts TWR and calculates annualized money-weighted return", () => {
    const halfYear = 182 * 86_400;
    const funded = performancePoints({
      timestamp: [1, halfYear, halfYear * 2],
      equity: [100, 210, 231],
      profitLoss: [0, 10, 31],
      profitLossPct: [0, 0.1, 0.21],
      cashflow: { JNLC: [0, 100, 0] },
    });
    expect(timeWeightedReturn(funded)).toBeCloseTo(0.21);
    expect(performanceSummary(funded).timeWeightedReturnPercent).toBeCloseTo(
      21,
    );
    expect(moneyWeightedReturn(funded)).not.toBeNull();
  });

  test("attributes cashflow-adjusted portfolio return against a benchmark", () => {
    const day = 86_400;
    const funded = performancePoints({
      timestamp: [day, day * 2, day * 3],
      equity: [100, 210, 231],
      profitLoss: [0, 10, 31],
      profitLossPct: [0, 0.1, 0.21],
      cashflow: { JNLC: [0, 100, 0] },
    });
    const benchmark = benchmarkAttribution(
      funded,
      [
        { timestamp: day * 1_000, close: 100 },
        { timestamp: day * 3_000, close: 110 },
      ],
      "SPY",
    );
    expect(benchmark).toMatchObject({ observations: 2, quality: "complete" });
    expect(benchmark.returnPercent).toBeCloseTo(10);
    expect(benchmark.activeReturnPercent).toBeCloseTo(11);
    expect(benchmarkAttribution(funded, [], "SPY").quality).toBe(
      "insufficient",
    );
  });

  test("normalizes portfolio, benchmark, position, and response times", () => {
    const dayOne = Date.parse("2026-01-01T00:00:00Z");
    const dayTwo = Date.parse("2026-01-02T00:00:00Z");
    const normalized = portfolioPerformanceDto({
      period: "1M",
      points: [
        {
          timestamp: dayOne,
          equity: 100,
          profitLoss: 0,
          profitLossPercent: 0,
          externalCashFlow: 0,
        },
        {
          timestamp: dayTwo,
          equity: 110,
          profitLoss: 10,
          profitLossPercent: 10,
          externalCashFlow: 0,
        },
      ],
      benchmarkBars: [
        { timestamp: "2026-01-01T20:00:00Z", close: 200 },
        { timestamp: "2026-01-02T20:00:00Z", close: 210 },
      ],
      benchmarkSymbol: "SPY",
      benchmarkSource: { provider: "alpaca", feed: "iex" },
      positions: [
        {
          symbol: "AAPL",
          marketValue: "100",
          unrealizedPl: "10",
          unrealizedPlpc: "0.1",
        },
      ],
      portfolioRetrievedAt: "2026-01-02T20:00:01Z",
      benchmarkRetrievedAt: "2026-01-02T20:00:02Z",
      serverRespondedAt: "2026-01-02T20:00:03Z",
    });

    expect(normalized).toMatchObject({
      observedAt: "2026-01-02T20:00:00.000Z",
      retrievedAt: "2026-01-02T20:00:02.000Z",
      serverRespondedAt: "2026-01-02T20:00:03.000Z",
      effectivePeriod: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-02T00:00:00.000Z",
      },
      summary: {
        observedAt: "2026-01-02T00:00:00.000Z",
        retrievedAt: "2026-01-02T20:00:01.000Z",
      },
      benchmark: {
        observedAt: "2026-01-02T20:00:00.000Z",
        retrievedAt: "2026-01-02T20:00:02.000Z",
        serverRespondedAt: "2026-01-02T20:00:03.000Z",
      },
      points: [
        {
          observedAt: "2026-01-01T00:00:00.000Z",
          retrievedAt: "2026-01-02T20:00:01.000Z",
        },
        { observedAt: "2026-01-02T00:00:00.000Z" },
      ],
      attribution: [
        {
          symbol: "AAPL",
          observedAt: null,
          retrievedAt: "2026-01-02T20:00:01.000Z",
        },
      ],
      quality: {
        observedAt: "2026-01-02T20:00:00.000Z",
        retrievedAt: "2026-01-02T20:00:02.000Z",
      },
    });
  });

  test("keeps an unqueried benchmark retrieval explicitly unavailable", () => {
    const normalized = portfolioPerformanceDto({
      period: "1M",
      points: [],
      benchmarkBars: [],
      benchmarkSymbol: "SPY",
      benchmarkSource: null,
      positions: [],
      portfolioRetrievedAt: "2026-01-02T20:00:01Z",
      benchmarkRetrievedAt: null,
      serverRespondedAt: "2026-01-02T20:00:02Z",
    });

    expect(normalized.benchmark).toMatchObject({
      quality: "insufficient",
      observedAt: null,
      retrievedAt: null,
      serverRespondedAt: "2026-01-02T20:00:02.000Z",
      time: {
        observationTime: null,
        retrievalTime: null,
        serverResponseTime: "2026-01-02T20:00:02.000Z",
      },
    });
  });

  test("reconciles delayed opening funding to the first funded equity point", () => {
    const halfYear = 182 * 86_400;
    const delayed = performancePoints({
      timestamp: [1, 86_400, 86_400 + halfYear, 86_400 + halfYear * 2],
      equity: [0, 100, 101, 102],
      profitLoss: [0, 0, 1, 2],
      profitLossPct: [0, 0, 0.01, 0.02],
      cashflow: { JNLC: [0, 0, 0, 100] },
    });
    expect(delayed.map((point) => point.externalCashFlow)).toEqual([100, 0, 0]);
    expect(timeWeightedReturn(delayed)).toBeCloseTo(0.02);
    expect(moneyWeightedReturn(delayed)).not.toBeNull();
  });

  test("ignores broker placeholders from before an account was funded", () => {
    expect(
      performancePoints({
        timestamp: [1, 2],
        equity: [0, 100],
        profitLoss: [0, 0],
        profitLossPct: [0, 0],
      }),
    ).toHaveLength(1);
  });

  test("calculates historical value at risk", () => {
    const result = valueAtRisk95(10_000, [1, 1.02, 0.969]);
    expect(result.valueAtRisk95Percent).toBeCloseTo(5);
    expect(result.valueAtRisk95).toBeCloseTo(500);
    expect(valueAtRisk95(10_000, [])).toEqual({
      valueAtRisk95Percent: 0,
      valueAtRisk95: 0,
    });
  });

  test("builds transparent stress scenarios and diversification score", () => {
    const scenarios = stressTests(10_000, 2_000, [
      { symbol: "AAPL", percent: 30 },
    ]);
    expect(scenarios[0]).toMatchObject({
      estimatedLoss: 800,
      resultingEquity: 9_200,
    });
    expect(scenarios[2]).toMatchObject({
      estimatedLoss: 750,
      resultingEquity: 9_250,
    });
    expect(diversificationScore(0.1, 20)).toEqual({
      score: 75,
      label: "Well diversified",
    });
    expect(diversificationScopes(0.01, 7, [7_000, 4_000, 1_000])).toEqual({
      score: 99,
      label: "Well diversified",
      wholeAccount: { score: 99, label: "Well diversified" },
      investedAssets: {
        score: 0,
        label: "Highly concentrated",
        grossInvested: 12_000,
        positionCount: 3,
      },
    });
  });
});
