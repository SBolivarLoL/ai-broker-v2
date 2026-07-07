import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createMarketService } from "../../backend/features/markets/service";
import { createStore } from "../../backend/persistence/store";

function fakeMarketService(allow = () => true) {
  let clockCalls = 0,
    multiAssetCalls = 0;
  const stockStream = {
    onStateChange() {},
    onConnect() {},
    onDisconnect() {},
    onError() {},
    onQuote() {},
    onBar() {},
    subscribeForQuotes() {},
    subscribeForBars() {},
    unsubscribeFromQuotes() {},
    unsubscribeFromBars() {},
    connect() {},
  };
  const alpaca = {
    marketData: {
      stockStream: () => stockStream,
      getLatestPrice: async () => 123.45,
      indices: {
        indexLatestValues: async () => {
          multiAssetCalls++;
          return {
            values: { SPX: { v: 6000, t: "2026-06-22T20:00:00Z" } },
          };
        },
      },
      forex: {
        latestRates: async () => ({
          rates: {
            "EUR/USD": {
              bp: 1.1,
              ap: 1.1002,
              mp: 1.1001,
              t: "2026-06-22T20:00:01Z",
            },
          },
        }),
      },
      crypto: {
        cryptoSnapshots: async () => ({
          snapshots: {
            "BTC/USD": {
              latestQuote: { bp: 99, ap: 101, t: "2026-06-22T20:00:02Z" },
              dailyBar: { c: 105, h: 110, l: 90, v: 12 },
              prevDailyBar: { c: 100 },
            },
          },
        }),
      },
    },
    trading: {
      calendar: {
        clock: async () => {
          clockCalls++;
          return { clocks: [] };
        },
      },
    },
  } as unknown as Alpaca;
  return {
    service: createMarketService({
      alpaca,
      store: createStore(":memory:"),
      allow,
    }),
    clockCalls: () => clockCalls,
    multiAssetCalls: () => multiAssetCalls,
  };
}

test("market service owns quote validation and clock caching", async () => {
  const { service, clockCalls } = fakeMarketService();
  const other = new Request("http://localhost/api/research/metrics");
  expect(
    await service.handleRequest(other, new URL(other.url), "test"),
  ).toBeNull();

  const invalid = new Request("http://localhost/api/quote?symbol=not-a-symbol");
  expect(
    (await service.handleRequest(invalid, new URL(invalid.url), "test"))
      ?.status,
  ).toBe(400);

  const quote = new Request("http://localhost/api/quote?symbol=aapl");
  const response = await service.handleRequest(
    quote,
    new URL(quote.url),
    "test",
  );
  expect(await response?.json()).toMatchObject({
    symbol: "AAPL",
    price: 123.45,
  });

  await service.getClock();
  await service.getClock();
  expect(clockCalls()).toBe(1);
});

test("market service preserves stream limits before opening subscriptions", async () => {
  const { service } = fakeMarketService(() => false);
  const request = new Request(
    "http://localhost/api/market/stream?symbols=AAPL",
  );
  const response = await service.handleRequest(
    request,
    new URL(request.url),
    "test",
  );
  expect(response?.status).toBe(429);
});

test("multi-asset route preserves provider retrieval time across cached responses", async () => {
  const { service, multiAssetCalls } = fakeMarketService();
  const request = new Request("http://localhost/api/market/multi-asset");
  const first = await service.handleRequest(
    request,
    new URL(request.url),
    "test",
  );
  const firstBody = await first?.json();
  await Bun.sleep(5);
  const second = await service.handleRequest(
    request,
    new URL(request.url),
    "test",
  );
  const secondBody = await second?.json();

  expect(firstBody).toMatchObject({
    indices: [
      {
        symbol: "SPX",
        observedAt: "2026-06-22T20:00:00.000Z",
      },
    ],
    forex: [
      {
        symbol: "EUR/USD",
        observedAt: "2026-06-22T20:00:01.000Z",
      },
    ],
    crypto: [
      {
        symbol: "BTC/USD",
        observedAt: "2026-06-22T20:00:02.000Z",
      },
    ],
    observedAt: "2026-06-22T20:00:02.000Z",
  });
  expect(secondBody.retrievedAt).toBe(firstBody.retrievedAt);
  expect(secondBody.time.retrievalTime).toBe(firstBody.retrievedAt);
  expect(new Date(secondBody.serverRespondedAt).getTime()).toBeGreaterThan(
    new Date(firstBody.serverRespondedAt).getTime(),
  );
  expect(secondBody.asOf).toBe(secondBody.serverRespondedAt);
  expect(multiAssetCalls()).toBe(1);
});
