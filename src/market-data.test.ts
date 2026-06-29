import { expect, test } from "bun:test";
import { getStockBarsWithFallback } from "./market-data";

test("falls back from unavailable SIP bars to IEX bars", async () => {
  const calls: any[] = [];
  const marketData = {
    async getStockBarsFor(_symbol: string, options: Record<string, unknown>) {
      calls.push(options);
      if (options.feed === "sip") throw new Error("subscription does not permit querying recent SIP data");
      return [{ timestamp: "2026-06-24T00:00:00Z", close: 100 }];
    },
  };
  const result = await getStockBarsWithFallback(marketData, "SPY", { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-24T12:00:00Z"), now: new Date("2026-06-24T12:30:00Z") });
  expect(result.bars).toHaveLength(1);
  expect(result.source).toMatchObject({ provider: "alpaca", feed: "iex", delayed: false, fallback: true, attempts: ["sip", "iex"] });
  expect(calls.map(call => call.feed)).toEqual(["sip", "iex"]);
});

test("falls back to delayed SIP when current SIP and IEX are unavailable", async () => {
  const calls: any[] = [];
  const marketData = {
    async getStockBarsFor(_symbol: string, options: Record<string, unknown>) {
      calls.push(options);
      if (calls.length < 3) throw new Error("SIP entitlement unavailable");
      return [{ timestamp: "2026-06-24T00:00:00Z", close: 100 }];
    },
  };
  const now = new Date("2026-06-24T12:30:00Z");
  const result = await getStockBarsWithFallback(marketData, "SPY", { start: new Date("2026-06-01T00:00:00Z"), end: now, now });
  expect(result.source).toMatchObject({ feed: "sip", delayed: true, fallback: true, attempts: ["sip", "iex", "sip:delayed"] });
  expect(calls[2].end).toEqual(new Date("2026-06-24T12:14:00Z"));
});
