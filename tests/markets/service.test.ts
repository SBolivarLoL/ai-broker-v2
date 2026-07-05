import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createMarketService } from "../../backend/features/markets/service";
import { createStore } from "../../backend/persistence/store";

function fakeMarketService(allow = () => true) {
  let clockCalls = 0;
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
