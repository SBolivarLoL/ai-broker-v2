import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createMarketService } from "../../backend/features/markets/service";
import { createStore } from "../../backend/persistence/store";

function fakeMarketService(allow = () => true) {
  let clockCalls = 0,
    discoveryCalls = 0,
    calendarCalls = 0,
    companyMarketCalls = 0,
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
      getStockBarsFor: async (symbol: string) => [
        {
          timestamp: new Date("2026-06-21T00:00:00Z"),
          open: symbol === "SPY" ? 500 : 190,
          high: symbol === "SPY" ? 505 : 202,
          low: symbol === "SPY" ? 495 : 189,
          close: symbol === "SPY" ? 502 : 200,
          volume: 1_000,
          vwap: symbol === "SPY" ? 501 : 198,
        },
        {
          timestamp: new Date("2026-06-22T00:00:00Z"),
          open: symbol === "SPY" ? 502 : 200,
          high: symbol === "SPY" ? 510 : 206,
          low: symbol === "SPY" ? 501 : 199,
          close: symbol === "SPY" ? 507 : 205,
          volume: 2_000,
          vwap: symbol === "SPY" ? 506 : 204,
        },
      ],
      stocks: {
        stockSnapshotSingle: async () => {
          companyMarketCalls++;
          return {
            latestTrade: { p: 205, t: new Date("2026-06-22T14:33:00Z") },
            latestQuote: {
              bp: 204.5,
              ap: 205.5,
              bs: 2,
              as: 3,
              t: new Date("2026-06-22T14:33:00Z"),
            },
            dailyBar: { v: 3_000 },
            prevDailyBar: { c: 200 },
          };
        },
      },
      news: {
        news: async () => ({
          news: [
            {
              id: 1,
              headline: "AAPL news",
              summary: "Summary",
              source: "Wire",
              author: "A",
              createdAt: new Date("2026-06-22T13:00:00Z"),
              updatedAt: new Date("2026-06-22T13:05:00Z"),
              url: "https://example.com/aapl",
            },
          ],
        }),
      },
      screener: {
        movers: async () => {
          discoveryCalls++;
          return {
            gainers: [
              { symbol: "AAPL", price: 200, change: 10, percentChange: 5 },
            ],
            losers: [],
            lastUpdated: "2026-06-22T14:30:00Z",
          };
        },
        mostActives: async () => ({
          mostActives: [{ symbol: "MSFT", volume: 1_000, tradeCount: 20 }],
          lastUpdated: "2026-06-22T14:31:00Z",
        }),
      },
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
      assets: {
        getV2AssetsSymbolOrAssetId: async () => ({
          symbol: "AAPL",
          name: "Apple Inc.",
          exchange: "NASDAQ",
          status: "active",
          tradable: true,
          fractionable: true,
          shortable: true,
          marginable: true,
        }),
      },
      calendar: {
        clock: async () => {
          clockCalls++;
          return {
            clocks: [
              {
                market: { acronym: "NASDAQ" },
                phase: "open",
                isMarketDay: true,
                timestamp: new Date("2026-06-22T14:32:00Z"),
                nextMarketClose: new Date("2026-06-22T20:00:00Z"),
              },
            ],
          };
        },
        calendar: async () => {
          calendarCalls++;
          return {
            market: {
              name: "Nasdaq",
              acronym: "NASDAQ",
              timezone: "America/New_York",
            },
            calendar: [
              {
                date: new Date("2026-06-22"),
                coreStart: new Date("2026-06-22T13:30:00Z"),
                coreEnd: new Date("2026-06-22T20:00:00Z"),
                settlementDate: new Date("2026-06-24"),
              },
            ],
          };
        },
      },
      watchlists: {
        getWatchlists: async () => [],
        getWatchlistById: async () => null,
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
    discoveryCalls: () => discoveryCalls,
    calendarCalls: () => calendarCalls,
    companyMarketCalls: () => companyMarketCalls,
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

test("market workspace route keeps cached provider retrieval separate from response time", async () => {
  const { service, discoveryCalls, calendarCalls } = fakeMarketService();
  const request = new Request("http://localhost/api/market/workspace");
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

  expect(firstBody.discovery).toMatchObject({
    gainers: [
      {
        symbol: "AAPL",
        observedAt: "2026-06-22T14:30:00.000Z",
      },
    ],
    mostActive: [
      {
        symbol: "MSFT",
        observedAt: "2026-06-22T14:31:00.000Z",
      },
    ],
    session: {
      observedAt: "2026-06-22T14:32:00.000Z",
    },
    observedAt: "2026-06-22T14:32:00.000Z",
  });
  expect(firstBody.calendar.sessions[0]).toMatchObject({
    date: "2026-06-22",
    time: {
      effectivePeriod: {
        start: "2026-06-22T13:30:00.000Z",
        end: "2026-06-22T20:00:00.000Z",
      },
    },
  });
  expect(secondBody.discovery.retrievedAt).toBe(firstBody.discovery.retrievedAt);
  expect(secondBody.calendar.retrievedAt).toBe(firstBody.calendar.retrievedAt);
  expect(
    new Date(secondBody.discovery.serverRespondedAt).getTime(),
  ).toBeGreaterThan(new Date(firstBody.discovery.serverRespondedAt).getTime());
  expect(
    new Date(secondBody.calendar.serverRespondedAt).getTime(),
  ).toBeGreaterThan(new Date(firstBody.calendar.serverRespondedAt).getTime());
  expect(discoveryCalls()).toBe(1);
  expect(calendarCalls()).toBe(1);
});

test("company market route keeps cached provider retrieval separate from response time", async () => {
  const { service, companyMarketCalls } = fakeMarketService();
  const request = new Request(
    "http://localhost/api/company/market?symbol=AAPL&period=1M&benchmark=SPY",
  );
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
    company: {
      symbol: "AAPL",
    },
    quote: {
      observedAt: "2026-06-22T14:33:00.000Z",
    },
  });
  expect(firstBody.bars[0]).toMatchObject({
    observedAt: "2026-06-21T00:00:00.000Z",
  });
  expect(firstBody.news[0]).toMatchObject({
    publishedAt: "2026-06-22T13:00:00.000Z",
  });
  expect(secondBody.retrievedAt).toBe(firstBody.retrievedAt);
  expect(secondBody.quote.retrievedAt).toBe(firstBody.retrievedAt);
  expect(secondBody.time.retrievalTime).toBe(firstBody.retrievedAt);
  expect(new Date(secondBody.serverRespondedAt).getTime()).toBeGreaterThan(
    new Date(firstBody.serverRespondedAt).getTime(),
  );
  expect(secondBody.asOf).toBe(secondBody.serverRespondedAt);
  expect(companyMarketCalls()).toBe(1);
});
