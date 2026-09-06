import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createStockStreamService } from "../../backend/features/markets/stock-stream";

test("stock stream shares symbol subscriptions and releases them on disconnect", async () => {
  const subscribed: string[][] = [];
  const unsubscribed: string[][] = [];
  const stream = {
    onStateChange() {},
    onConnect() {},
    onDisconnect() {},
    onError() {},
    onQuote() {},
    onBar() {},
    subscribeForQuotes: (symbols: string[]) => subscribed.push(symbols),
    subscribeForBars() {},
    unsubscribeFromQuotes: (symbols: string[]) => unsubscribed.push(symbols),
    unsubscribeFromBars() {},
    send() {},
    connect() {},
    disconnect() {},
  };
  const alpaca = {
    marketData: { stockStream: () => stream },
  } as unknown as Alpaca;
  const service = createStockStreamService(alpaca);
  const request = new Request(
    "http://localhost/api/market/stream?symbols=AAPL",
  );
  const response = service.open(request, ["AAPL"]);
  const reader = response.body!.getReader();
  const first = await reader.read();

  const payload = JSON.parse(
    new TextDecoder()
      .decode(first.value)
      .replace(/^data: /, "")
      .trim(),
  );
  expect(payload).toMatchObject({
    state: "connecting",
    observedAt: null,
    publishedAt: null,
    retrievedAt: null,
    time: {
      observationTime: null,
      publicationTime: null,
      retrievalTime: null,
    },
  });
  expect(typeof payload.serverRespondedAt).toBe("string");
  expect(payload.asOf).toBe(payload.serverRespondedAt);
  expect(payload.time.serverResponseTime).toBe(payload.serverRespondedAt);
  expect(service.size()).toBe(1);
  expect(subscribed).toEqual([["AAPL"]]);

  await reader.cancel();
  expect(service.size()).toBe(0);
  expect(unsubscribed).toEqual([["AAPL"]]);
});

test("stock stream stops owned work and can restart without duplicate timers", async () => {
  let connects = 0;
  let disconnects = 0;
  const intervals: unknown[] = [];
  const cleared: unknown[] = [];
  const quoteSymbols = new Set<string>();
  const barSymbols = new Set<string>();
  const stream = {
    onStateChange() {},
    onConnect() {},
    onDisconnect() {},
    onError() {},
    onQuote() {},
    onBar() {},
    subscribeForQuotes(symbols: string[]) {
      for (const symbol of symbols) quoteSymbols.add(symbol);
    },
    subscribeForBars(symbols: string[]) {
      for (const symbol of symbols) barSymbols.add(symbol);
    },
    unsubscribeFromQuotes(symbols: string[]) {
      for (const symbol of symbols) quoteSymbols.delete(symbol);
    },
    unsubscribeFromBars(symbols: string[]) {
      for (const symbol of symbols) barSymbols.delete(symbol);
    },
    send() {},
    connect() {
      connects++;
    },
    disconnect() {
      disconnects++;
    },
  };
  const service = createStockStreamService(
    { marketData: { stockStream: () => stream } } as unknown as Alpaca,
    {
      setIntervalFn: (_callback, milliseconds) => {
        const handle = { milliseconds };
        intervals.push(handle);
        return handle;
      },
      clearIntervalFn: (handle) => cleared.push(handle),
    },
  );
  const response = service.open(
    new Request("http://localhost/api/market/stream?symbols=AAPL"),
    ["AAPL"],
  );
  const reader = response.body!.getReader();
  await reader.read();

  service.start();
  service.start();
  expect(connects).toBe(1);
  expect(intervals).toEqual([{ milliseconds: 20_000 }]);

  service.stop();
  service.stop();
  expect(disconnects).toBe(1);
  expect(cleared).toEqual(intervals);
  expect(service.size()).toBe(0);
  expect([...quoteSymbols]).toEqual([]);
  expect([...barSymbols]).toEqual([]);
  expect((await reader.read()).done).toBe(true);

  service.start();
  const restartedResponse = service.open(
    new Request("http://localhost/api/market/stream?symbols=MSFT"),
    ["MSFT"],
  );
  const restartedReader = restartedResponse.body!.getReader();
  await restartedReader.read();
  expect(connects).toBe(2);
  expect(intervals).toHaveLength(2);
  expect([...quoteSymbols]).toEqual(["MSFT"]);
  expect([...barSymbols]).toEqual(["MSFT"]);
  service.stop();
  expect(disconnects).toBe(2);
  expect(cleared).toEqual(intervals);
  expect([...quoteSymbols]).toEqual([]);
  expect([...barSymbols]).toEqual([]);
  expect((await restartedReader.read()).done).toBe(true);
});
