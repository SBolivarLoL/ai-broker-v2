import { expect, test } from "bun:test";
import {
  CRYPTO_LOOKBACK_DAYS,
  cryptoBarsDto,
  cryptoSnapshotDto,
  normalizeCryptoBar,
  parseCryptoLookbackDays,
  parseCryptoSymbols,
  parseCryptoTimeframe,
} from "../../backend/features/strategies/crypto-strategy-data";

test("validates bounded crypto strategy data inputs", () => {
  expect(parseCryptoSymbols("BTC/USD,ETH/USD,BTC/USD")).toEqual([
    "BTC/USD",
    "ETH/USD",
  ]);
  for (const timeframe of ["1Min", "5Min", "15Min", "1Hour", "4Hour", "1Day"])
    expect(parseCryptoTimeframe(timeframe)).toBe(timeframe);
  expect(parseCryptoLookbackDays(undefined)).toBe(
    CRYPTO_LOOKBACK_DAYS.defaultValue,
  );
  expect(parseCryptoLookbackDays(CRYPTO_LOOKBACK_DAYS.minimum)).toBe(
    CRYPTO_LOOKBACK_DAYS.minimum,
  );
  expect(parseCryptoLookbackDays(CRYPTO_LOOKBACK_DAYS.maximum)).toBe(
    CRYPTO_LOOKBACK_DAYS.maximum,
  );
  expect(parseCryptoLookbackDays("30")).toBe(30);
  expect(() => parseCryptoSymbols("DOGE/USD")).toThrow("Crypto symbols");
  expect(() => parseCryptoTimeframe("2Hour")).toThrow("Timeframe");
  expect(() => parseCryptoLookbackDays("365")).toThrow("Lookback days");
});

test("regression: Strategy Lab exposes the server lookback bounds", async () => {
  const html = await Bun.file(
    new URL("../../frontend/index.html", import.meta.url),
  ).text();
  const input = html.match(/<input[^>]+id="strategy-days"[^>]*>/)?.[0];
  expect(input).toBeDefined();
  expect(input).toContain(`min="${CRYPTO_LOOKBACK_DAYS.minimum}"`);
  expect(input).toContain(`max="${CRYPTO_LOOKBACK_DAYS.maximum}"`);
});

test("normalizes historical crypto bars with provenance", () => {
  const start = new Date("2026-06-24T00:00:00Z"),
    end = new Date("2026-06-24T02:00:00Z");
  const dto = cryptoBarsDto({
    symbols: ["BTC/USD"],
    timeframe: "1Hour",
    start,
    end,
    retrievedAt: new Date("2026-06-24T02:00:10Z"),
    serverRespondedAt: new Date("2026-06-24T02:00:11Z"),
    bars: {
      "BTC/USD": [
        {
          timestamp: "2026-06-24T01:00:00Z",
          open: 100,
          high: 110,
          low: 90,
          close: 105,
          volume: 12,
          tradeCount: 4,
        },
      ],
    },
  });
  expect(dto).toMatchObject({
    source: "Alpaca crypto historical bars",
    feed: "us",
    timeframe: "1Hour",
    symbols: ["BTC/USD"],
    observedStart: "2026-06-24T01:00:00.000Z",
    observedEnd: "2026-06-24T01:00:00.000Z",
    retrievedAt: "2026-06-24T02:00:10.000Z",
    serverRespondedAt: "2026-06-24T02:00:11.000Z",
  });
  expect(dto.time).toMatchObject({
    observationTime: "2026-06-24T01:00:00.000Z",
    retrievalTime: "2026-06-24T02:00:10.000Z",
    serverResponseTime: "2026-06-24T02:00:11.000Z",
  });
  expect(dto.bars["BTC/USD"][0]).toMatchObject({
    close: 105,
    tradeCount: 4,
    observedAt: "2026-06-24T01:00:00.000Z",
    time: {
      observationTime: "2026-06-24T01:00:00.000Z",
      retrievalTime: "2026-06-24T02:00:10.000Z",
      serverResponseTime: "2026-06-24T02:00:11.000Z",
    },
  });
});

test("rejects malformed and internally inconsistent historical bars", () => {
  const valid = {
    t: "2026-06-24T01:00:00Z",
    o: 100,
    h: 110,
    l: 90,
    c: 105,
    v: 12,
  };
  expect(normalizeCryptoBar("BTC/USD", valid)).not.toBeNull();
  for (const invalid of [
    { ...valid, t: "not-a-date" },
    { ...valid, h: 99 },
    { ...valid, l: 106 },
    { ...valid, v: -1 },
    { ...valid, n: 1.5 },
  ])
    expect(normalizeCryptoBar("BTC/USD", invalid)).toBeNull();
});

test("normalizes latest crypto snapshots and flags stale data", () => {
  const dto = cryptoSnapshotDto({
    symbols: ["BTC/USD"],
    receivedAt: new Date("2026-06-24T10:02:00Z"),
    snapshots: {
      "BTC/USD": {
        latestQuote: {
          bp: 99,
          bs: 1.2,
          ap: 101,
          as: 1.3,
          t: "2026-06-24T10:01:30Z",
        },
        latestTrade: { p: 100, s: 0.5, t: "2026-06-24T10:01:20Z", tks: "B" },
        latestBar: {
          o: 98,
          h: 102,
          l: 97,
          c: 100,
          v: 10,
          t: "2026-06-24T10:01:00Z",
        },
      },
    },
    orderbooks: {
      "BTC/USD": { bids: [{ p: 99, s: 1 }], asks: [{ p: 101, s: 1 }] },
    },
  });
  expect(dto.records[0]).toMatchObject({
    symbol: "BTC/USD",
    source: "Alpaca crypto snapshot",
    feed: "us",
    observedAt: "2026-06-24T10:01:30.000Z",
    retrievedAt: "2026-06-24T10:02:00.000Z",
    time: {
      observationTime: "2026-06-24T10:01:30.000Z",
      retrievalTime: "2026-06-24T10:02:00.000Z",
      serverResponseTime: "2026-06-24T10:02:00.000Z",
    },
    stale: false,
    payload: {
      quote: { bid: 99, ask: 101 },
      trade: { price: 100, takerSide: "B" },
      bar: { close: 100 },
    },
  });

  const stale = cryptoSnapshotDto({
    symbols: ["BTC/USD"],
    receivedAt: new Date("2026-06-24T10:05:00Z"),
    snapshots: {
      "BTC/USD": {
        latestQuote: { bp: 99, ap: 101, t: "2026-06-24T10:01:30Z" },
      },
    },
  });
  expect(stale.records[0]?.stale).toBe(true);
});
