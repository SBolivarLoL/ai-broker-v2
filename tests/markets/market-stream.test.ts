import { expect, test } from "bun:test";
import {
  parseStreamSymbols,
  streamBarDto,
  streamQuoteDto,
} from "../../backend/features/markets/market-stream";

test("validates and deduplicates bounded stream symbols", () => {
  expect(parseStreamSymbols(" aapl,MSFT,AAPL ")).toEqual(["AAPL", "MSFT"]);
  expect(() => parseStreamSymbols("BAD/SYMBOL")).toThrow();
  expect(() => parseStreamSymbols("AAPL,MSFT", 1)).toThrow();
});

test("normalizes live quotes and bars without exposing wire fields", () => {
  expect(
    streamQuoteDto({
      symbol: "AAPL",
      bidPrice: 99,
      askPrice: 101,
      bidSize: 2,
      askSize: 3,
      timestamp: new Date("2026-06-22T14:00:00Z"),
    }, new Date("2026-06-22T14:00:01Z")),
  ).toMatchObject({
    kind: "quote",
    symbol: "AAPL",
    midpoint: 100,
    spreadBps: 200,
    timestamp: "2026-06-22T14:00:00.000Z",
    observedAt: "2026-06-22T14:00:00.000Z",
    retrievedAt: "2026-06-22T14:00:01.000Z",
    serverRespondedAt: "2026-06-22T14:00:01.000Z",
    time: {
      observationTime: "2026-06-22T14:00:00.000Z",
      retrievalTime: "2026-06-22T14:00:01.000Z",
      serverResponseTime: "2026-06-22T14:00:01.000Z",
    },
    feed: "iex",
  });
  expect(
    streamBarDto({
      symbol: "AAPL",
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 1_000,
      vwap: 100.5,
      tradeCount: 42,
      timestamp: new Date("2026-06-22T14:00:00Z"),
    }, new Date("2026-06-22T14:00:01Z")),
  ).toMatchObject({
    kind: "bar",
    close: 101,
    volume: 1_000,
    tradeCount: 42,
    timestamp: "2026-06-22T14:00:00.000Z",
    observedAt: "2026-06-22T14:00:00.000Z",
    retrievedAt: "2026-06-22T14:00:01.000Z",
    serverRespondedAt: "2026-06-22T14:00:01.000Z",
    time: {
      observationTime: "2026-06-22T14:00:00.000Z",
      effectivePeriod: {
        start: "2026-06-22T14:00:00.000Z",
        end: "2026-06-22T14:00:00.000Z",
        label: "IEX stream bar",
      },
      retrievalTime: "2026-06-22T14:00:01.000Z",
    },
  });
});
