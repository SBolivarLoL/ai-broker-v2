import { describe, expect, test } from "bun:test";
import { portfolioRiskDto } from "../../backend/features/portfolio/risk-response";

const source = {
  provider: "alpaca" as const,
  feed: "iex" as const,
  delayed: false,
  fallback: false,
  attempts: ["iex"],
  warning: null,
};

const times = {
  accountRetrievedAt: "2026-01-03T22:00:01Z",
  marketRetrievedAt: "2026-01-03T22:00:02Z",
  serverRespondedAt: "2026-01-03T22:00:03Z",
};

describe("portfolio risk response", () => {
  test("separates current-state, historical, quote, benchmark, and response times", () => {
    const response = portfolioRiskDto({
      account: { equity: "10000", cash: "4000" },
      positions: [
        { symbol: "AAPL", qty: "50", marketValue: "6000", unrealizedPl: "500" },
      ],
      positionData: [
        {
          position: {
            symbol: "AAPL",
            qty: "50",
            marketValue: "6000",
            unrealizedPl: "500",
          },
          bars: [
            { timestamp: "2026-01-01T21:00:00Z", close: 100, volume: 10_000 },
            { timestamp: "2026-01-02T21:00:00Z", close: 105, volume: 12_000 },
            { timestamp: "2026-01-03T21:00:00Z", close: 103, volume: 11_000 },
          ],
          barSource: source,
          marketSnapshot: {
            latestQuote: {
              bp: 102.9,
              ap: 103.1,
              t: "2026-01-03T21:01:00Z",
            },
          },
        },
      ],
      benchmarkBars: [
        { timestamp: "2026-01-01T21:00:00Z", close: 500, volume: 1_000_000 },
        { timestamp: "2026-01-02T21:00:00Z", close: 502, volume: 1_100_000 },
        { timestamp: "2026-01-03T21:00:00Z", close: 501, volume: 1_050_000 },
      ],
      benchmarkSource: source,
      ...times,
    });

    expect(response).toMatchObject({
      schemaVersion: "portfolio-risk-v2",
      observedAt: "2026-01-03T21:01:00.000Z",
      publishedAt: null,
      retrievedAt: "2026-01-03T22:00:02.000Z",
      serverRespondedAt: "2026-01-03T22:00:03.000Z",
      asOf: "2026-01-03T22:00:03.000Z",
      effectivePeriod: {
        start: "2026-01-01T21:00:00.000Z",
        end: "2026-01-03T21:00:00.000Z",
      },
      weights: [
        {
          symbol: "AAPL",
          observedAt: null,
          retrievedAt: "2026-01-03T22:00:01.000Z",
        },
      ],
      inputs: {
        account: {
          observedAt: null,
          retrievedAt: "2026-01-03T22:00:01.000Z",
        },
        positions: {
          count: 1,
          observedAt: null,
          retrievedAt: "2026-01-03T22:00:01.000Z",
        },
        positionMarketData: [
          {
            symbol: "AAPL",
            historicalBars: {
              observedAt: "2026-01-03T21:00:00.000Z",
              retrievedAt: "2026-01-03T22:00:02.000Z",
            },
            quote: {
              observedAt: "2026-01-03T21:01:00.000Z",
              retrievedAt: "2026-01-03T22:00:02.000Z",
            },
          },
        ],
        benchmark: {
          symbol: "SPY",
          observedAt: "2026-01-03T21:00:00.000Z",
          retrievedAt: "2026-01-03T22:00:02.000Z",
        },
      },
      advanced: {
        observedAt: "2026-01-03T21:00:00.000Z",
        benchmark: {
          symbol: "SPY",
          observedAt: "2026-01-03T21:00:00.000Z",
        },
        riskContribution: [
          { symbol: "AAPL", observedAt: "2026-01-03T21:00:00.000Z" },
        ],
      },
      liquidity: [
        {
          symbol: "AAPL",
          observedAt: "2026-01-03T21:01:00.000Z",
        },
      ],
      diversification: {
        observedAt: null,
        retrievedAt: "2026-01-03T22:00:01.000Z",
      },
      quality: { status: "complete", missing: [], warnings: [] },
    });
    expect(response.stressTests[0]).toMatchObject({
      observedAt: null,
      retrievedAt: "2026-01-03T22:00:01.000Z",
    });
  });

  test("reports missing observations and insufficient provider inputs explicitly", () => {
    const response = portfolioRiskDto({
      account: { equity: 1000, cash: 500 },
      positions: [{ symbol: "AAPL", qty: 5, marketValue: 500 }],
      positionData: [
        {
          position: { symbol: "AAPL", qty: 5, marketValue: 500 },
          bars: [{ close: 100, volume: 0 }],
          barSource: { ...source, warning: "Fallback feed was used." },
          marketSnapshot: {},
        },
      ],
      benchmarkBars: [],
      benchmarkSource: source,
      ...times,
    });

    expect(response.observedAt).toBeNull();
    expect(response.inputs.positionMarketData[0]?.quote).toMatchObject({
      available: false,
      observedAt: null,
    });
    expect(response.quality).toMatchObject({
      status: "partial",
      received: {
        positionHistories: 0,
        positionQuotes: 0,
        benchmarkHistories: 0,
      },
      missing: [
        "AAPL:historical_bars",
        "AAPL:historical_bar_observation_time",
        "AAPL:quote",
        "AAPL:quote_observation_time",
        "SPY:benchmark_bars",
        "SPY:benchmark_observation_time",
      ],
    });
    expect(response.quality.warnings).toContain("Fallback feed was used.");
  });

  test("keeps a cash-only portfolio explicit instead of inventing position evidence", () => {
    const response = portfolioRiskDto({
      account: { equity: 1000, cash: 1000 },
      positions: [],
      positionData: [],
      benchmarkBars: [
        { timestamp: "2026-01-02T21:00:00Z", close: 500, volume: 1_000 },
        { timestamp: "2026-01-03T21:00:00Z", close: 501, volume: 1_000 },
      ],
      benchmarkSource: source,
      ...times,
    });

    expect(response).toMatchObject({
      weights: [],
      liquidity: [],
      quality: {
        status: "empty",
        missing: [],
        expected: { positions: 0, positionHistories: 0, positionQuotes: 0 },
      },
      inputs: { positions: { count: 0 }, positionMarketData: [] },
    });
  });
});
