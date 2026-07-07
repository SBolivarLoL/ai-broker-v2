import { expect, test } from "bun:test";
import {
  calendarDto,
  discoveryDto,
  orderSessionGuidance,
  parseSymbol,
  parseWatchlistInput,
  watchlistDto,
} from "../../backend/features/markets/market-workspace";

test("validates and normalizes bounded watchlist input", () => {
  expect(
    parseWatchlistInput({
      name: "  Core ideas ",
      symbols: ["aapl", "AAPL", "MSFT"],
    }),
  ).toEqual({ name: "Core ideas", symbols: ["AAPL", "MSFT"] });
  expect(() => parseWatchlistInput({ name: "", symbols: [] })).toThrow();
  expect(() =>
    parseWatchlistInput({ name: "Ideas", symbols: ["bad symbol"] }),
  ).toThrow();
  expect(parseSymbol(" msft ")).toBe("MSFT");
});

test("exposes safe watchlist and market discovery DTOs", () => {
  expect(
    watchlistDto({
      id: "1",
      name: "Core",
      updatedAt: new Date("2026-01-01"),
      assets: [
        { symbol: "AAPL", name: "Apple", exchange: "NASDAQ", tradable: true },
      ],
    }),
  ).toMatchObject({
    id: "1",
    name: "Core",
    assets: [{ symbol: "AAPL", tradable: true }],
  });
  const result = discoveryDto(
    {
      gainers: [{ symbol: "A", price: 2, change: 1, percentChange: 100 }],
      losers: [],
      lastUpdated: "2026-01-01T14:30:00Z",
    },
    {
      mostActives: [{ symbol: "A", volume: 100, tradeCount: 5 }],
      lastUpdated: "2026-01-01T14:31:00Z",
    },
    {
      clocks: [
        {
          market: { acronym: "NASDAQ" },
          phase: "open",
          isMarketDay: true,
          timestamp: new Date("2026-01-01T14:32:00Z"),
          nextMarketClose: new Date("2026-01-01T21:00:00Z"),
        },
      ],
    },
    new Date("2026-01-01T14:32:02Z"),
    new Date("2026-01-01T14:32:03Z"),
  );
  expect(result).toMatchObject({
    gainers: [
      {
        symbol: "A",
        percentChange: 100,
        observedAt: "2026-01-01T14:30:00.000Z",
        retrievedAt: "2026-01-01T14:32:02.000Z",
      },
    ],
    mostActive: [
      {
        symbol: "A",
        volume: 100,
        observedAt: "2026-01-01T14:31:00.000Z",
      },
    ],
    session: {
      phase: "open",
      isMarketDay: true,
      timestamp: "2026-01-01T14:32:00.000Z",
      observedAt: "2026-01-01T14:32:00.000Z",
      retrievedAt: "2026-01-01T14:32:02.000Z",
      serverRespondedAt: "2026-01-01T14:32:03.000Z",
    },
    observedAt: "2026-01-01T14:32:00.000Z",
    retrievedAt: "2026-01-01T14:32:02.000Z",
    serverRespondedAt: "2026-01-01T14:32:03.000Z",
    asOf: "2026-01-01T14:32:03.000Z",
    source: "Alpaca SIP screener and NASDAQ clock",
    screenerAsOf: "2026-01-01T14:31:00.000Z",
  });
  expect(result.time).toMatchObject({
    observationTime: "2026-01-01T14:32:00.000Z",
    retrievalTime: "2026-01-01T14:32:02.000Z",
    serverResponseTime: "2026-01-01T14:32:03.000Z",
  });
});

test("exposes upcoming sessions, early closes and order timing guidance", () => {
  const clock = {
    clocks: [
      {
        market: { acronym: "NASDAQ" },
        phase: "post",
        timestamp: new Date("2026-06-22T20:05:00Z"),
        nextMarketOpen: new Date("2026-06-23T13:30:00Z"),
        nextMarketClose: new Date("2026-06-23T20:00:00Z"),
      },
    ],
  };
  expect(
    orderSessionGuidance(
      clock,
      new Date("2026-06-22T20:05:01Z"),
      new Date("2026-06-22T20:05:02Z"),
    ),
  ).toMatchObject({
    phase: "post",
    coreSession: false,
    observedAt: "2026-06-22T20:05:00.000Z",
    retrievedAt: "2026-06-22T20:05:01.000Z",
    serverRespondedAt: "2026-06-22T20:05:02.000Z",
    nextOpen: "2026-06-23T13:30:00.000Z",
  });
  const result = calendarDto(
    {
      market: {
        name: "Nasdaq",
        acronym: "NASDAQ",
        timezone: "America/New_York",
      },
      calendar: [
        {
          date: new Date("2026-07-03"),
          coreStart: new Date("2026-07-03T13:30:00Z"),
          coreEnd: new Date("2026-07-03T17:00:00Z"),
          settlementDate: new Date("2026-07-07"),
        },
      ],
    },
    clock,
    new Date("2026-06-22T20:05:01Z"),
    new Date("2026-06-22T20:05:02Z"),
  );
  expect(result.sessions[0]).toMatchObject({
    date: "2026-07-03",
    durationMinutes: 210,
    earlyClose: true,
    settlementDate: "2026-07-07",
    observedAt: null,
    retrievedAt: "2026-06-22T20:05:01.000Z",
    serverRespondedAt: "2026-06-22T20:05:02.000Z",
    time: {
      effectivePeriod: {
        start: "2026-07-03T13:30:00.000Z",
        end: "2026-07-03T17:00:00.000Z",
        label: "NASDAQ core session",
      },
      retrievalTime: "2026-06-22T20:05:01.000Z",
      serverResponseTime: "2026-06-22T20:05:02.000Z",
    },
  });
  expect(result).toMatchObject({
    observedAt: "2026-06-22T20:05:00.000Z",
    retrievedAt: "2026-06-22T20:05:01.000Z",
    serverRespondedAt: "2026-06-22T20:05:02.000Z",
    asOf: "2026-06-22T20:05:02.000Z",
  });
});
