import { describe, expect, test } from "bun:test";
import { portfolioExposureDto } from "../../backend/features/portfolio/exposure-response";
import { buildPortfolioExposureReport } from "../../backend/features/portfolio/portfolio-exposure";

const bars = (count = 70) =>
  Array.from({ length: count }, (_, index) => {
    const observedAt = new Date(Date.UTC(2026, 0, index + 1));
    return {
      date: observedAt.toISOString().slice(0, 10),
      close: 100 + index,
      observedAt,
    };
  });

describe("portfolio exposure response", () => {
  test("separates current state, market history, SEC classification, cache, and response times", () => {
    const positionBars = bars();
    const benchmarkBars = bars();
    const report = buildPortfolioExposureReport({
      equity: 10_000,
      cash: 4_000,
      positions: [
        {
          symbol: "AAPL",
          marketValue: 6_000,
          assetClass: "us_equity",
          bars: positionBars,
          classification: {
            sic: "3571",
            industry: "Electronic Computers",
            sourceUrl: "https://data.sec.gov/submissions/example.json",
          },
          marketDataSource: "alpaca:iex",
        },
      ],
      benchmarkBars,
      asOf: "2026-03-12T20:00:03Z",
    });
    const response = portfolioExposureDto({
      report,
      positionEvidence: [
        {
          symbol: "AAPL",
          assetClass: "us_equity",
          bars: positionBars,
          rejectedMarketBars: 0,
          marketDataQueried: true,
          marketDataRetrievedAt: "2026-03-12T20:00:02Z",
          classificationQueried: true,
          classificationAvailable: true,
          classificationRetrievedAt: "2026-03-12T20:00:02.500Z",
          classificationSourceUrl:
            "https://data.sec.gov/submissions/example.json",
        },
      ],
      accountRetrievedAt: "2026-03-12T20:00:01Z",
      benchmarkBars,
      benchmarkQueried: true,
      benchmarkRejectedBars: 0,
      benchmarkRetrievedAt: "2026-03-12T20:00:02Z",
      omittedPositionCount: 0,
      cacheHit: false,
      cacheExpiresAt: "2026-03-12T20:05:02Z",
      serverRespondedAt: "2026-03-12T20:00:03Z",
    });

    expect(response).toMatchObject({
      schemaVersion: "portfolio-exposure-v2",
      observedAt: "2026-03-11T00:00:00.000Z",
      publishedAt: null,
      retrievedAt: "2026-03-12T20:00:02.500Z",
      serverRespondedAt: "2026-03-12T20:00:03.000Z",
      asOf: "2026-03-12T20:00:03.000Z",
      effectivePeriod: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-03-11T00:00:00.000Z",
      },
      assetClasses: [
        {
          observedAt: null,
          retrievedAt: "2026-03-12T20:00:01.000Z",
        },
        {
          observedAt: null,
          retrievedAt: "2026-03-12T20:00:01.000Z",
        },
      ],
      sectors: [
        {
          observedAt: null,
          retrievedAt: "2026-03-12T20:00:02.500Z",
        },
      ],
      factors: [
        {
          observedAt: "2026-03-11T00:00:00.000Z",
          retrievedAt: "2026-03-12T20:00:02.000Z",
        },
        { observedAt: "2026-03-11T00:00:00.000Z" },
        { observedAt: "2026-03-11T00:00:00.000Z" },
      ],
      positions: [
        {
          symbol: "AAPL",
          observedAt: "2026-03-11T00:00:00.000Z",
          retrievedAt: "2026-03-12T20:00:02.500Z",
        },
      ],
      quality: {
        status: "complete",
        expected: {
          account: 1,
          positions: 1,
          positionHistories: 1,
          classifications: 1,
          benchmarkHistories: 1,
        },
        received: {
          account: 1,
          positions: 1,
          positionHistories: 1,
          classifications: 1,
          benchmarkHistories: 1,
        },
        omitted: {
          account: 0,
          positions: 0,
          positionHistories: 0,
          classifications: 0,
          benchmarkHistories: 0,
        },
        freshness: {
          status: "observed",
          expectedObservations: 2,
          receivedObservations: 2,
          latestObservedAt: "2026-03-11T00:00:00.000Z",
          evaluatedAt: "2026-03-12T20:00:03.000Z",
        },
        missing: [],
        omittedPositions: 0,
        cache: {
          hit: false,
          externalEvidenceExpiresAt: "2026-03-12T20:05:02.000Z",
        },
      },
      inputs: {
        account: {
          observedAt: null,
          retrievedAt: "2026-03-12T20:00:01.000Z",
        },
        benchmark: {
          available: true,
          observedAt: "2026-03-11T00:00:00.000Z",
          retrievedAt: "2026-03-12T20:00:02.000Z",
        },
        positionEvidence: [
          {
            symbol: "AAPL",
            marketHistory: {
              queried: true,
              available: true,
              observedAt: "2026-03-11T00:00:00.000Z",
              retrievedAt: "2026-03-12T20:00:02.000Z",
            },
            classification: {
              queried: true,
              available: true,
              observedAt: null,
              retrievedAt: "2026-03-12T20:00:02.500Z",
            },
          },
        ],
      },
      sources: [
        {
          provider: "SEC",
          observedAt: null,
          retrievedAt: "2026-03-12T20:00:02.500Z",
        },
      ],
    });
  });

  test("keeps failed and unqueried provider reads explicit", () => {
    const report = buildPortfolioExposureReport({
      equity: 10_000,
      cash: 4_000,
      positions: [
        {
          symbol: "AAPL",
          marketValue: 5_000,
          assetClass: "us_equity",
          bars: [],
          classification: null,
        },
        {
          symbol: "BTC/USD",
          marketValue: 1_000,
          assetClass: "crypto",
        },
      ],
      benchmarkBars: [],
      asOf: "2026-03-12T20:00:03Z",
    });
    const response = portfolioExposureDto({
      report,
      positionEvidence: [
        {
          symbol: "AAPL",
          assetClass: "us_equity",
          bars: [],
          rejectedMarketBars: 0,
          marketDataQueried: true,
          marketDataRetrievedAt: null,
          classificationQueried: true,
          classificationAvailable: false,
          classificationRetrievedAt: null,
          classificationSourceUrl: null,
        },
        {
          symbol: "BTC/USD",
          assetClass: "crypto",
          bars: [],
          rejectedMarketBars: 0,
          marketDataQueried: false,
          marketDataRetrievedAt: null,
          classificationQueried: false,
          classificationAvailable: false,
          classificationRetrievedAt: null,
          classificationSourceUrl: null,
        },
      ],
      accountRetrievedAt: "2026-03-12T20:00:01Z",
      benchmarkBars: [],
      benchmarkQueried: true,
      benchmarkRejectedBars: 0,
      benchmarkRetrievedAt: null,
      omittedPositionCount: 2,
      cacheHit: false,
      cacheExpiresAt: "2026-03-12T20:05:02Z",
      serverRespondedAt: "2026-03-12T20:00:03Z",
    });

    expect(response.observedAt).toBeNull();
    expect(response.retrievedAt).toBe("2026-03-12T20:00:01.000Z");
    expect(response.inputs.benchmark).toMatchObject({
      queried: true,
      available: false,
      retrievedAt: null,
      time: { retrievalTime: null },
    });
    expect(response.inputs.positionEvidence).toMatchObject([
      {
        marketHistory: { queried: true, retrievedAt: null },
        classification: { queried: true, retrievedAt: null },
      },
      {
        marketHistory: { queried: false, retrievedAt: null },
        classification: { queried: false, retrievedAt: null },
      },
    ]);
    expect(response.quality).toMatchObject({
      status: "partial",
      omittedPositions: 2,
      received: {
        positionHistories: 0,
        classifications: 0,
        benchmarkHistories: 0,
      },
      missing: [
        "AAPL:market_history",
        "AAPL:market_observation_time",
        "AAPL:sec_sic_classification",
        "BTC/USD:market_history_not_supported",
        "SPY:benchmark_history",
        "SPY:benchmark_observation_time",
        "portfolio:omitted_positions:2",
      ],
    });
  });
});
