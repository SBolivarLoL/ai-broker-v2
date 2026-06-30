import { expect, test } from "bun:test";
import { CRYPTO_LOOKBACK_DAYS, cryptoBarsDto, cryptoSnapshotDto, parseCryptoLookbackDays, parseCryptoSymbols, parseCryptoTimeframe } from "./crypto-strategy-data";

test("validates bounded crypto strategy data inputs", () => {
  expect(parseCryptoSymbols("BTC/USD,ETH/USD,BTC/USD")).toEqual(["BTC/USD", "ETH/USD"]);
  expect(parseCryptoTimeframe("1Hour")).toBe("1Hour");
  expect(parseCryptoLookbackDays(undefined)).toBe(CRYPTO_LOOKBACK_DAYS.defaultValue);
  expect(parseCryptoLookbackDays(CRYPTO_LOOKBACK_DAYS.minimum)).toBe(CRYPTO_LOOKBACK_DAYS.minimum);
  expect(parseCryptoLookbackDays(CRYPTO_LOOKBACK_DAYS.maximum)).toBe(CRYPTO_LOOKBACK_DAYS.maximum);
  expect(parseCryptoLookbackDays("30")).toBe(30);
  expect(() => parseCryptoSymbols("DOGE/USD")).toThrow("Crypto symbols");
  expect(() => parseCryptoTimeframe("2Hour")).toThrow("Timeframe");
  expect(() => parseCryptoLookbackDays("365")).toThrow("Lookback days");
});

test("regression: Strategy Lab exposes the server lookback bounds", async () => {
  const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
  const input = html.match(/<input[^>]+id="strategy-days"[^>]*>/)?.[0];
  expect(input).toBeDefined();
  expect(input).toContain(`min="${CRYPTO_LOOKBACK_DAYS.minimum}"`);
  expect(input).toContain(`max="${CRYPTO_LOOKBACK_DAYS.maximum}"`);
});

test("normalizes historical crypto bars with provenance", () => {
  const start = new Date("2026-06-24T00:00:00Z"), end = new Date("2026-06-24T02:00:00Z");
  const dto = cryptoBarsDto({
    symbols: ["BTC/USD"],
    timeframe: "1Hour",
    start,
    end,
    bars: { "BTC/USD": [{ timestamp: "2026-06-24T01:00:00Z", open: 100, high: 110, low: 90, close: 105, volume: 12, tradeCount: 4 }] },
  });
  expect(dto).toMatchObject({ source: "Alpaca crypto historical bars", feed: "us", timeframe: "1Hour", symbols: ["BTC/USD"] });
  expect(dto.bars["BTC/USD"][0]).toMatchObject({ close: 105, tradeCount: 4 });
});

test("normalizes latest crypto snapshots and flags stale data", () => {
  const dto = cryptoSnapshotDto({
    symbols: ["BTC/USD"],
    receivedAt: new Date("2026-06-24T10:02:00Z"),
    snapshots: {
      "BTC/USD": {
        latestQuote: { bp: 99, bs: 1.2, ap: 101, as: 1.3, t: "2026-06-24T10:01:30Z" },
        latestTrade: { p: 100, s: 0.5, t: "2026-06-24T10:01:20Z", tks: "B" },
        latestBar: { o: 98, h: 102, l: 97, c: 100, v: 10, t: "2026-06-24T10:01:00Z" },
      },
    },
    orderbooks: { "BTC/USD": { bids: [{ p: 99, s: 1 }], asks: [{ p: 101, s: 1 }] } },
  });
  expect(dto.records[0]).toMatchObject({
    symbol: "BTC/USD",
    source: "Alpaca crypto snapshot",
    feed: "us",
    stale: false,
    payload: { quote: { bid: 99, ask: 101 }, trade: { price: 100, takerSide: "B" }, bar: { close: 100 } },
  });

  const stale = cryptoSnapshotDto({ symbols: ["BTC/USD"], receivedAt: new Date("2026-06-24T10:05:00Z"), snapshots: { "BTC/USD": { latestQuote: { bp: 99, ap: 101, t: "2026-06-24T10:01:30Z" } } } });
  expect(stale.records[0]?.stale).toBe(true);
});
