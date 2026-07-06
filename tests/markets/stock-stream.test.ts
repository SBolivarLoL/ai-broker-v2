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
    connect() {},
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

  expect(new TextDecoder().decode(first.value)).toContain(
    '"state":"connecting"',
  );
  expect(service.size()).toBe(1);
  expect(subscribed).toEqual([["AAPL"]]);

  await reader.cancel();
  expect(service.size()).toBe(0);
  expect(unsubscribed).toEqual([["AAPL"]]);
});
