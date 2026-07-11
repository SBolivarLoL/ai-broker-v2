import { describe, expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createPortfolioExposureService } from "../../backend/features/portfolio/exposure-service";

const marketBars = () =>
  Array.from({ length: 70 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, index + 1)),
    close: 100 + index,
  }));

const classification = {
  symbol: "AAPL",
  companyName: "Example Corp",
  cik: "0000000001",
  sic: "3571",
  industry: "Electronic Computers",
  sourceUrl: "https://data.sec.gov/submissions/example.json",
  retrievedAt: "2026-03-12T19:59:00.000Z",
  serverRespondedAt: "2026-03-12T20:00:00.000Z",
  time: {
    observationTime: null,
    publicationTime: null,
    effectivePeriod: null,
    retrievalTime: "2026-03-12T19:59:00.000Z",
    serverResponseTime: "2026-03-12T20:00:00.000Z",
  },
  asOf: "2026-03-12T20:00:00.000Z",
};

describe("portfolio exposure service", () => {
  test("reuses external evidence while refreshing current-state and response times", async () => {
    const barRequests: { symbol: string; options: Record<string, unknown> }[] = [];
    let classificationCalls = 0;
    const alpaca = {
      trading: {
        account: {
          getAccount: async () => ({ equity: "10000", cash: "3000" }),
        },
        positions: {
          getAllOpenPositions: async () => [
            {
              symbol: "AAPL",
              assetClass: "us_equity",
              marketValue: "6000",
            },
            {
              symbol: "BTC/USD",
              assetClass: "crypto",
              marketValue: "1000",
            },
          ],
        },
      },
      marketData: {
        getStockBarsFor: async (
          symbol: string,
          options: Record<string, unknown>,
        ) => {
          barRequests.push({ symbol, options });
          return marketBars();
        },
      },
    } as unknown as Alpaca;
    const times = [
      "2026-03-12T20:00:00Z",
      "2026-03-12T20:00:01Z",
      "2026-03-12T20:00:02Z",
      "2026-03-12T20:00:03Z",
      "2026-03-12T20:01:00Z",
      "2026-03-12T20:01:01Z",
      "2026-03-12T20:01:02Z",
    ].map((value) => new Date(value));
    const service = createPortfolioExposureService(alpaca, {
      now: () => times.shift()!,
      getClassification: async () => {
        classificationCalls++;
        return classification;
      },
    });

    const first = await service();
    const second = await service();

    expect(first.report).toMatchObject({
      schemaVersion: "portfolio-exposure-v2",
      retrievedAt: "2026-03-12T20:00:02.000Z",
      serverRespondedAt: "2026-03-12T20:00:03.000Z",
      quality: {
        status: "partial",
        cache: {
          hit: false,
          externalEvidenceExpiresAt: "2026-03-12T20:05:02.000Z",
        },
      },
      inputs: {
        account: { retrievedAt: "2026-03-12T20:00:01.000Z" },
        benchmark: { retrievedAt: "2026-03-12T20:00:02.000Z" },
      },
    });
    expect(second.report).toMatchObject({
      retrievedAt: "2026-03-12T20:01:01.000Z",
      serverRespondedAt: "2026-03-12T20:01:02.000Z",
      quality: { cache: { hit: true } },
      inputs: {
        account: { retrievedAt: "2026-03-12T20:01:01.000Z" },
        benchmark: { retrievedAt: "2026-03-12T20:00:02.000Z" },
        positionEvidence: [
          {
            classification: {
              retrievedAt: "2026-03-12T19:59:00.000Z",
              serverRespondedAt: "2026-03-12T20:01:02.000Z",
            },
          },
          {
            marketHistory: { queried: false, retrievedAt: null },
            classification: { queried: false, retrievedAt: null },
          },
        ],
      },
    });
    expect(barRequests).toHaveLength(2);
    expect(classificationCalls).toBe(1);
    expect(barRequests.map((request) => request.symbol).sort()).toEqual([
      "AAPL",
      "SPY",
    ]);
    expect(
      barRequests.every(
        (request) =>
          request.options.feed === "iex" &&
          (request.options.end as Date).toISOString() ===
            "2026-03-12T20:00:00.000Z",
      ),
    ).toBe(true);
  });

  test("returns explicit partial coverage when market and SEC reads fail", async () => {
    const alpaca = {
      trading: {
        account: {
          getAccount: async () => ({ equity: "10000", cash: "5000" }),
        },
        positions: {
          getAllOpenPositions: async () => [
            {
              symbol: "AAPL",
              assetClass: "us_equity",
              marketValue: "5000",
            },
          ],
        },
      },
      marketData: {
        getStockBarsFor: async () => {
          throw new Error("private provider failure");
        },
      },
    } as unknown as Alpaca;
    const times = [
      "2026-03-12T20:00:00Z",
      "2026-03-12T20:00:01Z",
      "2026-03-12T20:00:02Z",
      "2026-03-12T20:00:03Z",
    ].map((value) => new Date(value));
    const service = createPortfolioExposureService(alpaca, {
      now: () => times.shift()!,
      getClassification: async () => {
        throw new Error("private SEC failure");
      },
    });

    const result = await service();

    expect(result.report).toMatchObject({
      observedAt: null,
      retrievedAt: "2026-03-12T20:00:01.000Z",
      quality: {
        status: "partial",
        received: {
          positionHistories: 0,
          classifications: 0,
          benchmarkHistories: 0,
        },
      },
      inputs: {
        benchmark: { retrievedAt: null },
        positionEvidence: [
          {
            marketHistory: { queried: true, retrievedAt: null },
            classification: { queried: true, retrievedAt: null },
          },
        ],
      },
    });
    expect(JSON.stringify(result.report)).not.toContain("private provider");
    expect(JSON.stringify(result.report)).not.toContain("private SEC");
  });

  test("rejects malformed provider bars and exposes their coverage impact", async () => {
    const alpaca = {
      trading: {
        account: {
          getAccount: async () => ({ equity: "10000", cash: "5000" }),
        },
        positions: {
          getAllOpenPositions: async () => [
            {
              symbol: "AAPL",
              assetClass: "us_equity",
              marketValue: "5000",
            },
          ],
        },
      },
      marketData: {
        getStockBarsFor: async () => [
          ...marketBars(),
          { timestamp: "not-a-date", close: Number.NaN },
        ],
      },
    } as unknown as Alpaca;
    const times = [
      "2026-03-12T20:00:00Z",
      "2026-03-12T20:00:01Z",
      "2026-03-12T20:00:02Z",
      "2026-03-12T20:00:03Z",
    ].map((value) => new Date(value));
    const service = createPortfolioExposureService(alpaca, {
      now: () => times.shift()!,
      getClassification: async () => classification,
    });

    const result = await service();

    expect(result.report).toMatchObject({
      quality: {
        status: "partial",
        rejected: { positionBars: 1, benchmarkBars: 1 },
        missing: [
          "AAPL:malformed_market_bars:1",
          "SPY:malformed_bars:1",
        ],
      },
      inputs: {
        benchmark: { count: 70, rejected: 1 },
        positionEvidence: [
          { marketHistory: { count: 70, rejected: 1 } },
        ],
      },
    });
    expect(
      result.report.warnings.filter((warning) => warning.includes("malformed")),
    ).toHaveLength(2);
  });

  test("does not query an irrelevant equity benchmark for non-equity holdings", async () => {
    let barCalls = 0;
    let classificationCalls = 0;
    const alpaca = {
      trading: {
        account: {
          getAccount: async () => ({ equity: "10000", cash: "9000" }),
        },
        positions: {
          getAllOpenPositions: async () => [
            {
              symbol: "BTC/USD",
              assetClass: "crypto",
              marketValue: "1000",
            },
          ],
        },
      },
      marketData: {
        getStockBarsFor: async () => {
          barCalls++;
          return marketBars();
        },
      },
    } as unknown as Alpaca;
    const times = [
      "2026-03-12T20:00:00Z",
      "2026-03-12T20:00:01Z",
      "2026-03-12T20:00:02Z",
      "2026-03-12T20:00:03Z",
    ].map((value) => new Date(value));
    const service = createPortfolioExposureService(alpaca, {
      now: () => times.shift()!,
      getClassification: async () => {
        classificationCalls++;
        return classification;
      },
    });

    const result = await service();

    expect(result.report).toMatchObject({
      quality: {
        status: "partial",
        expected: { positionHistories: 1, benchmarkHistories: 0 },
        received: { positionHistories: 0, benchmarkHistories: 0 },
        missing: ["BTC/USD:market_history_not_supported"],
      },
      inputs: {
        benchmark: { queried: false, retrievedAt: null },
        positionEvidence: [
          {
            marketHistory: { queried: false, retrievedAt: null },
            classification: { queried: false, retrievedAt: null },
          },
        ],
      },
      factors: [
        { retrievedAt: null },
        { retrievedAt: null },
        { retrievedAt: null },
      ],
    });
    expect(barCalls).toBe(0);
    expect(classificationCalls).toBe(0);
  });
});
