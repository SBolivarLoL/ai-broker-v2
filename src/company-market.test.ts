import { expect, test } from "bun:test";
import { companyMarketSnapshot } from "./company-market";

const asset = { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", status: "active", tradable: true, fractionable: true, shortable: true, marginable: true };
const bars = [
  { timestamp: new Date("2026-01-01"), open: 98, high: 102, low: 97, close: 100, volume: 1_000, vwap: 100 },
  { timestamp: new Date("2026-01-02"), open: 100, high: 112, low: 99, close: 110, volume: 2_000, vwap: 108 },
];

test("normalizes company price, spread, volume and news", () => {
  const result = companyMarketSnapshot(asset, { latestTrade: { p: 111, t: new Date("2026-01-02T20:00:00Z") }, latestQuote: { bp: 110.9, ap: 111.1, bs: 2, as: 3, t: new Date("2026-01-02T20:00:00Z") }, dailyBar: { v: 3_000 }, prevDailyBar: { c: 100 } }, bars, [{ id: 1, headline: "News", summary: "Summary", source: "Wire", author: "A", createdAt: new Date("2026-01-02"), updatedAt: new Date("2026-01-02"), url: "https://example.com" }], { clocks: [{ market: { acronym: "NASDAQ" }, phase: "open", timestamp: new Date("2026-01-02T20:00:30Z"), nextMarketClose: new Date("2026-01-02T21:00:00Z") }] }, "1M");
  expect(result.quote).toMatchObject({ price: 111, midpoint: 111, quality: "healthy" });
  expect(result.quote.spreadBps).toBeCloseTo(18.018);
  expect(result.stats).toMatchObject({ periodHigh: 112, periodLow: 97, relativeVolume: 2 });
  expect(result.stats.dayChangePercent).toBeCloseTo(11);
  expect(result.stats.periodReturnPercent).toBeCloseTo(10);
  expect(result.news[0]).toMatchObject({ headline: "News", source: "Wire" });
});

test("distinguishes closed markets from stale open-market quotes", () => {
  const snapshot = { latestTrade: { p: 110, t: new Date("2026-01-02") }, latestQuote: { bp: 109, ap: 111, t: new Date("2026-01-02") } };
  expect(companyMarketSnapshot(asset, snapshot, bars, [], { clocks: [{ market: { acronym: "NASDAQ" }, phase: "closed", timestamp: new Date("2026-01-04") }] }, "1M").quote.quality).toBe("market_closed");
  expect(companyMarketSnapshot(asset, snapshot, bars, [], { clocks: [{ market: { acronym: "NASDAQ" }, phase: "open", timestamp: new Date("2026-01-04") }] }, "1M").quote.quality).toBe("stale");
});
