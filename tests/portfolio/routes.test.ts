import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import type { CurrentPortfolioExposure } from "../../backend/features/portfolio/exposure-service";
import { handlePortfolioRequest } from "../../backend/features/portfolio/routes";
import { createStore } from "../../backend/persistence/store";
import { normalizeActivity } from "../../backend/features/portfolio/ledger";

const route = async (
  path: string,
  envOrInit: Record<string, string | undefined> | RequestInit = {},
) => {
  const isRequestInit =
    "method" in envOrInit || "body" in envOrInit || "headers" in envOrInit;
  const request = new Request(
    `http://localhost${path}`,
    isRequestInit ? (envOrInit as RequestInit) : undefined,
  );
  return handlePortfolioRequest(request, new URL(request.url), {
    alpaca: {} as Alpaca,
    store: createStore(":memory:"),
    actor: "test-operator",
    allow: () => true,
    syncAccountActivities: async () => ({ imported: 0, truncated: false, retrievedAt: "2026-01-01T00:00:00.000Z", cacheHit: false }),
    currentPortfolioExposure: async () => {
      throw new Error("unexpected exposure request");
    },
    capturePortfolioSnapshot: async () => {
      throw new Error("unexpected snapshot capture");
    },
    env: isRequestInit ? {} : (envOrInit as Record<string, string | undefined>),
  });
};

test("portfolio routes reject invalid inputs before broker calls", async () => {
  expect(await route("/api/research/metrics")).toBeNull();
  expect(
    (await route("/api/account/activities?category=invalid"))?.status,
  ).toBe(400);
  expect((await route("/api/portfolio/snapshots?limit=367"))?.status).toBe(400);
  expect((await route("/api/portfolio/performance?period=2Y"))?.status).toBe(
    400,
  );
  expect(
    (
      await route("/api/portfolio/performance?period=1M", {
        PORTFOLIO_BENCHMARK: "not-a-symbol",
      })
    )?.status,
  ).toBe(500);

  const optimizer = await route("/api/portfolio/optimizer?minObservations=9");
  expect(optimizer?.status).toBe(400);

  const scenarios = await route("/api/portfolio/scenarios", {
    method: "POST",
    body: JSON.stringify({ custom: { name: "", shocks: [] } }),
  });
  expect(scenarios?.status).toBe(400);

  const rebalance = await route("/api/portfolio/rebalance-plan", {
    method: "POST",
    body: JSON.stringify({ targets: [] }),
  });
  expect(rebalance?.status).toBe(400);
});

test("account activities separate provider, effective, retrieval, and response times", async () => {
  const store = createStore(":memory:");
  try {
    const retrievedAt = "2026-01-03T10:00:00.000Z";
    store.syncActivities([
      normalizeActivity({
        id: "fill-1",
        activityType: "FILL",
        transactionTime: new Date("2026-01-02T15:00:00.000Z"),
        symbol: "AAPL",
        side: "buy",
        qty: "1",
        price: "100",
      }, retrievedAt),
      normalizeActivity({
        id: "dividend-1",
        activityType: "DIV",
        createdAt: new Date("2026-01-02T02:00:00.000Z"),
        date: new Date("2026-01-01T00:00:00.000Z"),
        symbol: "AAPL",
        netAmount: "1.25",
      }, retrievedAt),
    ]);
    const request = new Request("http://localhost/api/account/activities?limit=2");
    const response = await handlePortfolioRequest(request, new URL(request.url), {
      alpaca: {} as Alpaca,
      store,
      actor: "test-operator",
      allow: () => true,
      syncAccountActivities: async () => ({
        imported: 2,
        truncated: false,
        retrievedAt,
        cacheHit: false,
      }),
      currentPortfolioExposure: async () => {
        throw new Error("unexpected exposure request");
      },
      capturePortfolioSnapshot: async () => {
        throw new Error("unexpected snapshot capture");
      },
      now: () => new Date("2026-01-03T10:00:01.000Z"),
    });

    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body).toMatchObject({
      schemaVersion: "account-activities-v2",
      imported: 2,
      cache: { hit: false, ttlSeconds: 30 },
      quality: {
        status: "complete",
        received: {
          storedActivities: 2,
          withRetrievalTime: 2,
          withProviderTime: 2,
        },
      },
      source: {
        provider: "alpaca",
        api: "trading",
        environment: "paper",
        endpoint: "account-activities",
      },
      observedAt: "2026-01-02T15:00:00.000Z",
      publishedAt: "2026-01-02T02:00:00.000Z",
      effectivePeriod: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-02T15:00:00.000Z",
        label: "Imported account activity history",
      },
      retrievedAt,
      serverRespondedAt: "2026-01-03T10:00:01.000Z",
    });
    expect(body.activities[0]).toMatchObject({
      id: "fill-1",
      occurredAt: "2026-01-02T15:00:00.000Z",
      observedAt: "2026-01-02T15:00:00.000Z",
      publishedAt: null,
      effectivePeriod: null,
      retrievedAt,
      serverRespondedAt: "2026-01-03T10:00:01.000Z",
    });
    expect(body.activities[1]).toMatchObject({
      id: "dividend-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      observedAt: null,
      publishedAt: "2026-01-02T02:00:00.000Z",
      effectivePeriod: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-01T23:59:59.999Z",
      },
      retrievedAt,
      serverRespondedAt: "2026-01-03T10:00:01.000Z",
    });
    expect(body.summary).toMatchObject({
      source: { provider: "local", component: "fifo-account-ledger" },
      retrievedAt,
      serverRespondedAt: "2026-01-03T10:00:01.000Z",
    });
  } finally {
    store.close();
  }
});

test("portfolio optimizer separates account, market-history, freshness, and response evidence", async () => {
  const store = createStore(":memory:");
  const requests: Record<string, unknown>[] = [];
  const bars = Array.from({ length: 12 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 8 + index, 20)),
    close: 100 + index,
  }));
  const alpaca = {
    trading: {
      account: {
        getAccount: async () => ({ equity: "100000" }),
      },
      positions: {
        getAllOpenPositions: async () => [
          {
            symbol: "AAPL",
            assetClass: "us_equity",
            qty: "10",
            marketValue: "2000",
          },
          {
            symbol: "BTCUSD",
            assetClass: "crypto",
            qty: "1",
            marketValue: "1000",
          },
        ],
      },
    },
    marketData: {
      getStockBarsFor: async (
        _symbol: string,
        request: Record<string, unknown>,
      ) => {
        requests.push(request);
        return bars;
      },
    },
  } as unknown as Alpaca;
  const times = [
    new Date("2026-01-20T10:00:00.000Z"),
    new Date("2026-01-20T10:00:01.000Z"),
    new Date("2026-01-20T10:00:02.000Z"),
    new Date("2026-01-20T10:00:03.000Z"),
  ];
  try {
    const request = new Request(
      "http://localhost/api/portfolio/optimizer?minObservations=10&maxWeightPercent=100&maxTurnoverPercent=100&cashReservePercent=0",
    );
    const response = await handlePortfolioRequest(
      request,
      new URL(request.url),
      {
        alpaca,
        store,
        actor: "test-operator",
        allow: () => true,
        syncAccountActivities: async () => ({
          imported: 0,
          truncated: false,
          retrievedAt: "2026-01-20T10:00:00.000Z",
          cacheHit: false,
        }),
        currentPortfolioExposure: async () => {
          throw new Error("unexpected exposure request");
        },
        capturePortfolioSnapshot: async () => {
          throw new Error("unexpected snapshot capture");
        },
        now: () => times.shift()!,
      },
    );

    expect(response?.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      start: new Date("2025-10-22T10:00:00.000Z"),
      end: new Date("2026-01-20T10:00:00.000Z"),
      feed: "iex",
    });
    const body = await response!.json();
    expect(body).toMatchObject({
      schemaVersion: "portfolio-optimizer-v2",
      observedAt: "2026-01-19T20:00:00.000Z",
      publishedAt: null,
      effectivePeriod: {
        start: "2026-01-08T20:00:00.000Z",
        end: "2026-01-19T20:00:00.000Z",
        label: "Aligned optimizer market-history window",
      },
      retrievedAt: "2026-01-20T10:00:02.000Z",
      serverRespondedAt: "2026-01-20T10:00:03.000Z",
      inputs: {
        account: {
          observedAt: null,
          retrievedAt: "2026-01-20T10:00:01.000Z",
        },
        positions: {
          total: 2,
          eligibleLongUsEquity: 1,
          omitted: 1,
          retrievedAt: "2026-01-20T10:00:01.000Z",
        },
        marketHistory: {
          queried: true,
          count: 1,
          retrievedAt: "2026-01-20T10:00:02.000Z",
        },
        marketHistories: [
          {
            symbol: "AAPL",
            inputBars: 12,
            acceptedBars: 12,
            returnObservations: 11,
            used: true,
            freshness: {
              status: "fresh",
              staleAfterSeconds: 604800,
            },
            retrievedAt: "2026-01-20T10:00:02.000Z",
          },
        ],
      },
      quality: {
        status: "partial",
        expected: { currentPositions: 2, eligibleMarketHistories: 1 },
        received: {
          currentPositions: 2,
          marketHistories: 1,
          usableMarketHistories: 1,
        },
        omitted: { currentPositions: 1, marketHistories: 0 },
        rejected: {
          malformedBars: 0,
          duplicateBars: 0,
          conflictingBars: 0,
        },
        freshness: {
          evaluatedAt: "2026-01-20T10:00:02.000Z",
          freshHistories: 1,
          staleHistories: 0,
          unavailableHistories: 0,
          futureHistories: 0,
        },
      },
      source: {
        account: { provider: "alpaca", api: "trading" },
        marketHistory: { provider: "alpaca", feed: "iex" },
        calculation: { provider: "local", component: "portfolio-optimizer" },
      },
    });
    expect(body.quality.missing).toContain(
      "1 current positions are outside the eligible long US-equity set.",
    );
    expect(body.warnings).toContain(
      "Optimizer return histories use Alpaca IEX single-exchange bars, not consolidated SIP market data.",
    );
    expect(body.proposals[0]).toMatchObject({
      source: { provider: "local", component: "portfolio-optimizer" },
      observedAt: "2026-01-19T20:00:00.000Z",
      weights: [
        {
          symbol: "AAPL",
          source: { provider: "alpaca", feed: "iex" },
          observedAt: "2026-01-19T20:00:00.000Z",
          retrievedAt: "2026-01-20T10:00:02.000Z",
        },
      ],
    });
  } finally {
    store.close();
  }
});

test("portfolio performance route separates portfolio, benchmark, and response times", async () => {
  const alpaca = {
    trading: {
      portfolioHistory: {
        getAccountPortfolioHistory: async () => ({
          timestamp: [
            Date.parse("2026-01-01T00:00:00Z") / 1_000,
            Date.parse("2026-01-02T00:00:00Z") / 1_000,
          ],
          equity: [100, 110],
          profitLoss: [0, 10],
          profitLossPct: [0, 0.1],
          cashflow: {},
        }),
      },
      positions: {
        getAllOpenPositions: async () => [
          {
            symbol: "AAPL",
            marketValue: "100",
            unrealizedPl: "10",
            unrealizedPlpc: "0.1",
          },
        ],
      },
    },
    marketData: {
      getStockBarsFor: async () => [
        { timestamp: "2026-01-01T20:00:00Z", close: 200 },
        { timestamp: "2026-01-02T20:00:00Z", close: 210 },
      ],
    },
  } as unknown as Alpaca;
  const times = [
    new Date("2026-01-02T20:00:01Z"),
    new Date("2026-01-02T20:00:02Z"),
    new Date("2026-01-02T20:00:03Z"),
  ];
  const request = new Request(
    "http://localhost/api/portfolio/performance?period=1M",
  );
  const response = await handlePortfolioRequest(request, new URL(request.url), {
    alpaca,
    store: createStore(":memory:"),
    actor: "test-operator",
    allow: () => true,
    syncAccountActivities: async () => ({ imported: 0, truncated: false, retrievedAt: "2026-01-01T00:00:00.000Z", cacheHit: false }),
    currentPortfolioExposure: async () => {
      throw new Error("unexpected exposure request");
    },
    capturePortfolioSnapshot: async () => {
      throw new Error("unexpected snapshot capture");
    },
    now: () => times.shift()!,
  });

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    retrievedAt: "2026-01-02T20:00:02.000Z",
    serverRespondedAt: "2026-01-02T20:00:03.000Z",
    summary: { retrievedAt: "2026-01-02T20:00:01.000Z" },
    benchmark: {
      retrievedAt: "2026-01-02T20:00:02.000Z",
      source: { provider: "alpaca", feed: "sip" },
    },
    attribution: [
      {
        symbol: "AAPL",
        observedAt: null,
        retrievedAt: "2026-01-02T20:00:01.000Z",
      },
    ],
    quality: {
      status: "complete",
      expected: {
        portfolioHistory: 1,
        currentPositions: 1,
        benchmarkHistory: 1,
      },
      received: {
        portfolioHistory: 1,
        currentPositions: 1,
        benchmarkHistory: 1,
      },
      omitted: {
        portfolioHistory: 0,
        currentPositions: 0,
        benchmarkHistory: 0,
      },
      freshness: {
        status: "observed",
        evaluatedAt: "2026-01-02T20:00:03.000Z",
      },
      missing: [],
    },
    asOf: "2026-01-02T20:00:03.000Z",
  });
});

test("portfolio exposure route preserves the normalized service contract", async () => {
  const report = {
    schemaVersion: "portfolio-exposure-v2",
    observedAt: "2026-01-02T21:00:00.000Z",
    retrievedAt: "2026-01-02T21:00:01.000Z",
    serverRespondedAt: "2026-01-02T21:00:02.000Z",
    asOf: "2026-01-02T21:00:02.000Z",
    quality: {
      status: "partial",
      missing: ["AAPL:sec_sic_classification"],
      cache: { hit: true },
    },
    inputs: {
      account: { observedAt: null },
      benchmark: { observedAt: "2026-01-02T21:00:00.000Z" },
    },
  } as unknown as CurrentPortfolioExposure["report"];
  const request = new Request("http://localhost/api/portfolio/exposure");
  const response = await handlePortfolioRequest(request, new URL(request.url), {
    alpaca: {} as Alpaca,
    store: createStore(":memory:"),
    actor: "test-operator",
    allow: () => true,
    syncAccountActivities: async () => ({ imported: 0, truncated: false, retrievedAt: "2026-01-01T00:00:00.000Z", cacheHit: false }),
    currentPortfolioExposure: async () => ({ equity: 10_000, report }),
    capturePortfolioSnapshot: async () => {
      throw new Error("unexpected snapshot capture");
    },
  });

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(report);
});

test("portfolio scenarios expose normalized time and calculation coverage", async () => {
  const report = {
    schemaVersion: "portfolio-exposure-v2",
    positions: [
      {
        symbol: "AAPL",
        marketValue: 4_000,
        assetClass: "US equity",
        sector: "Manufacturing",
        sic: "3571",
        factors: { volatility20dPercent: 20 },
        source: {
          currentPosition: { provider: "alpaca", api: "trading" },
          marketHistory: {
            provider: "alpaca",
            api: "market-data",
            feed: "iex",
          },
          classification: {
            provider: "sec",
            dataset: "submissions",
            taxonomy: "SIC",
          },
        },
        observedAt: "2026-01-09T20:00:00.000Z",
        publishedAt: null,
        effectivePeriod: {
          start: "2025-12-01T20:00:00.000Z",
          end: "2026-01-09T20:00:00.000Z",
          label: "AAPL exposure evidence window",
        },
        retrievedAt: "2026-01-10T20:00:00.000Z",
        serverRespondedAt: "2026-01-10T20:00:01.000Z",
      },
    ],
    quality: { status: "complete", omittedPositions: 0 },
    inputs: {
      positions: { retrievedAt: "2026-01-10T20:00:00.000Z" },
      positionEvidence: [
        {
          symbol: "AAPL",
          currentPosition: {
            source: { provider: "alpaca", api: "trading" },
            observedAt: null,
            publishedAt: null,
            effectivePeriod: null,
            retrievedAt: "2026-01-10T20:00:00.000Z",
          },
          marketHistory: {
            queried: true,
            available: true,
            count: 20,
            rejected: 0,
            source: {
              provider: "alpaca",
              api: "market-data",
              feed: "iex",
            },
            observedAt: "2026-01-09T20:00:00.000Z",
            publishedAt: null,
            effectivePeriod: {
              start: "2025-12-01T20:00:00.000Z",
              end: "2026-01-09T20:00:00.000Z",
              label: "AAPL IEX exposure-factor window",
            },
            retrievedAt: "2026-01-10T20:00:00.000Z",
          },
          classification: {
            queried: true,
            available: true,
            source: {
              provider: "sec",
              dataset: "submissions",
              taxonomy: "SIC",
            },
            observedAt: null,
            publishedAt: null,
            effectivePeriod: null,
            retrievedAt: "2026-01-10T20:00:00.000Z",
          },
        },
      ],
    },
    source: {
      account: { provider: "alpaca", api: "trading" },
      marketHistory: {
        provider: "alpaca",
        api: "market-data",
        feed: "iex",
      },
      classifications: {
        provider: "sec",
        dataset: "submissions",
        taxonomy: "SIC",
      },
    },
    observedAt: "2026-01-09T20:00:00.000Z",
    publishedAt: null,
    effectivePeriod: {
      start: "2025-12-01T20:00:00.000Z",
      end: "2026-01-09T20:00:00.000Z",
      label: "Trailing IEX exposure-factor input window",
    },
    retrievedAt: "2026-01-10T20:00:00.000Z",
    serverRespondedAt: "2026-01-10T20:00:01.000Z",
    asOf: "2026-01-10T20:00:01.000Z",
  } as unknown as CurrentPortfolioExposure["report"];
  const request = new Request("http://localhost/api/portfolio/scenarios");
  const response = await handlePortfolioRequest(request, new URL(request.url), {
    alpaca: {} as Alpaca,
    store: createStore(":memory:"),
    actor: "test-operator",
    allow: () => true,
    syncAccountActivities: async () => ({ imported: 0, truncated: false, retrievedAt: "2026-01-01T00:00:00.000Z", cacheHit: false }),
    currentPortfolioExposure: async () => ({ equity: 10_000, report }),
    capturePortfolioSnapshot: async () => {
      throw new Error("unexpected snapshot capture");
    },
    now: () => new Date("2026-01-10T20:00:02Z"),
  });

  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(body).toMatchObject({
    schemaVersion: "portfolio-scenarios-v2",
    observedAt: "2026-01-09T20:00:00.000Z",
    retrievedAt: "2026-01-10T20:00:00.000Z",
    serverRespondedAt: "2026-01-10T20:00:02.000Z",
    quality: {
      status: "complete",
      expected: { currentPositions: 1, positionEvaluations: 3 },
      received: { modeledPositionEvaluations: 3 },
    },
  });
  expect(body.scenarios).toHaveLength(3);
  expect(body.scenarios[0]).toMatchObject({
    id: "rates_up_200bp",
    positions: [
      {
        symbol: "AAPL",
        observedAt: "2026-01-09T20:00:00.000Z",
        retrievedAt: "2026-01-10T20:00:00.000Z",
        serverRespondedAt: "2026-01-10T20:00:02.000Z",
      },
    ],
  });
});

test("rebalance route preserves IEX trade time and rejects stale evidence", async () => {
  const request = new Request("http://localhost/api/portfolio/rebalance-plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targets: [{ symbol: "AAPL", targetWeightPercent: 5 }],
      maxTurnoverPercent: 10,
      cashBufferPercent: 5,
    }),
  });
  const responseFor = async (options: {
    tradeTime?: string;
    price?: number;
    tradable?: boolean;
    assetClass?: string;
  }) => {
    const alpaca = {
      trading: {
        account: {
          getAccount: async () => ({ equity: "100000", cash: "20000" }),
        },
        positions: { getAllOpenPositions: async () => [] },
        orders: { getAllOrders: async () => [] },
        assets: {
          getV2AssetsSymbolOrAssetId: async () => ({
            tradable: options.tradable ?? true,
            _class: options.assetClass ?? "us_equity",
            fractionable: true,
          }),
        },
      },
      marketData: {
        stocks: {
          stockLatestTradeSingle: async () => ({
            trade: {
              p: options.price ?? 100,
              t: options.tradeTime ? new Date(options.tradeTime) : undefined,
            },
          }),
        },
      },
    } as unknown as Alpaca;
    return handlePortfolioRequest(request.clone(), new URL(request.url), {
      alpaca,
      store: createStore(":memory:"),
      actor: "test-operator",
      allow: () => true,
      syncAccountActivities: async () => ({
        imported: 0,
        truncated: false,
        retrievedAt: "2026-01-10T20:00:00.000Z",
        cacheHit: false,
      }),
      currentPortfolioExposure: async () => {
        throw new Error("unexpected exposure request");
      },
      capturePortfolioSnapshot: async () => {
        throw new Error("unexpected snapshot capture");
      },
      now: () => new Date("2026-01-10T20:00:02.000Z"),
    });
  };

  const response = await responseFor({
    tradeTime: "2026-01-09T20:00:00.000Z",
  });
  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(body).toMatchObject({
    schemaVersion: "portfolio-rebalance-plan-v2",
    observedAt: "2026-01-09T20:00:00.000Z",
    retrievedAt: "2026-01-10T20:00:02.000Z",
    serverRespondedAt: "2026-01-10T20:00:02.000Z",
    quality: {
      status: "complete",
      expected: { account: 1, targetAssets: 1, targetPrices: 1 },
      received: { targetPricesWithObservation: 1 },
      freshness: {
        marketPrices: { fresh: 1, stale: 0, future: 0, unavailable: 0 },
      },
    },
    inputs: {
      account: { observedAt: null },
      targetMarket: { expected: 1, received: 1 },
    },
  });
  expect(body.legs).toHaveLength(1);
  expect(body.legs[0]).toMatchObject({
    symbol: "AAPL",
    observedAt: "2026-01-09T20:00:00.000Z",
    source: { provider: "local" },
    priceSource: { provider: "alpaca", feed: "iex" },
  });

  const stale = await responseFor({
    tradeTime: "2025-12-01T20:00:00.000Z",
  });
  expect(stale?.status).toBe(400);
  expect(await stale?.json()).toEqual({
    error: "Fresh IEX trade evidence is unavailable for AAPL",
  });

  const unavailable = await responseFor({});
  expect(unavailable?.status).toBe(400);
  expect(await unavailable?.json()).toEqual({
    error: "Fresh IEX trade evidence is unavailable for AAPL",
  });

  const malformed = await responseFor({
    tradeTime: "2026-01-09T20:00:00.000Z",
    price: 0,
  });
  expect(malformed?.status).toBe(400);
  expect(await malformed?.json()).toEqual({
    error: "Valid IEX latest-trade evidence is required",
  });

  const unsupported = await responseFor({
    tradeTime: "2026-01-09T20:00:00.000Z",
    assetClass: "crypto",
  });
  expect(unsupported?.status).toBe(400);
  expect(await unsupported?.json()).toEqual({
    error: "AAPL is not a tradable US stock or ETF",
  });
});

test("portfolio snapshots route preserves capture time and legacy gaps", async () => {
  const store = createStore(":memory:");
  store.portfolioSnapshot({ snapshotDate: "2026-01-02", equity: 9_000 });
  const current = {
    snapshotDate: "2026-06-21",
    capturedAt: "2026-06-21T12:00:00.000Z",
    equity: 10_000,
    cash: 10_000,
    buyingPower: 10_000,
    positionValue: 0,
    positionCount: 0,
    reconciliationGap: 0,
    reconciliationGapPercent: 0,
    risk: {
      equity: 10_000,
      cash: 10_000,
      cashPercent: 100,
      unrealizedPl: 0,
      largestPositionPercent: 0,
      topThreePercent: 0,
      hhi: 0,
      weights: [],
    },
    positions: [],
    orderSync: {
      streamState: "authenticated",
      lastEventAt: "2026-06-21T11:59:30.000Z",
      stale: false,
    },
    quality: { status: "healthy", flags: [] },
    source: "alpaca-paper",
  };
  const request = new Request(
    "http://localhost/api/portfolio/snapshots?limit=30",
  );
  const response = await handlePortfolioRequest(request, new URL(request.url), {
    alpaca: {} as Alpaca,
    store,
    actor: "test-operator",
    allow: () => true,
    syncAccountActivities: async () => ({ imported: 0, truncated: false, retrievedAt: "2026-01-01T00:00:00.000Z", cacheHit: false }),
    currentPortfolioExposure: async () => {
      throw new Error("unexpected exposure request");
    },
    capturePortfolioSnapshot: async () => current,
    now: () => new Date("2026-06-21T12:00:01Z"),
  });

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    schemaVersion: "portfolio-snapshots-v2",
    observedAt: null,
    retrievedAt: "2026-06-21T12:00:00.000Z",
    serverRespondedAt: "2026-06-21T12:00:01.000Z",
    current: {
      schemaVersion: "portfolio-snapshot-v2",
      retrievedAt: "2026-06-21T12:00:00.000Z",
      orderSync: { observedAt: "2026-06-21T11:59:30.000Z" },
    },
    history: [
      {
        snapshotDate: "2026-01-02",
        provenanceStatus: "unavailable",
        retrievedAt: null,
      },
    ],
    quality: {
      status: "partial",
      missing: [
        "history:2026-01-02:capture_time",
        "history:2026-01-02:quality",
        "history:2026-01-02:positions",
        "history:2026-01-02:order_sync",
      ],
    },
  });
  store.close();
});

test("portfolio risk distinguishes whole-account and invested-asset diversification", async () => {
  const positions = [
    { symbol: "AAPL", qty: "70", marketValue: "7000", unrealizedPl: "100" },
    { symbol: "MSFT", qty: "40", marketValue: "4000", unrealizedPl: "50" },
    { symbol: "NVDA", qty: "10", marketValue: "1000", unrealizedPl: "25" },
  ];
  const bars = Array.from({ length: 90 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1 + index, 21)),
    close: 100 + index,
    volume: 100_000,
  }));
  const barRequests: Record<string, unknown>[] = [];
  const alpaca = {
    trading: {
      account: {
        getAccount: async () => ({ equity: "100000", cash: "88000" }),
      },
      positions: { getAllOpenPositions: async () => positions },
    },
    marketData: {
      getStockBarsFor: async (
        _symbol: string,
        options: Record<string, unknown>,
      ) => {
        barRequests.push(options);
        return bars;
      },
      stocks: {
        stockSnapshotSingle: async () => ({
          latestQuote: {
            bp: 99,
            ap: 101,
            t: new Date("2026-04-02T19:59:00Z"),
          },
        }),
      },
    },
  } as unknown as Alpaca;
  const request = new Request("http://localhost/api/portfolio/risk");
  const times = [
    new Date("2026-04-02T20:00:00Z"),
    new Date("2026-04-02T20:00:01Z"),
    new Date("2026-04-02T20:00:02Z"),
    new Date("2026-04-02T20:00:03Z"),
  ];
  const response = await handlePortfolioRequest(request, new URL(request.url), {
    alpaca,
    store: createStore(":memory:"),
    actor: "test-operator",
    allow: () => true,
    syncAccountActivities: async () => ({ imported: 0, truncated: false, retrievedAt: "2026-01-01T00:00:00.000Z", cacheHit: false }),
    currentPortfolioExposure: async () => {
      throw new Error("unexpected exposure request");
    },
    capturePortfolioSnapshot: async () => {
      throw new Error("unexpected snapshot capture");
    },
    now: () => times.shift()!,
  });

  expect(response?.status).toBe(200);
  const body = (await response?.json()) as {
    observedAt: string;
    retrievedAt: string;
    serverRespondedAt: string;
    inputs: {
      account: { observedAt: null; retrievedAt: string };
      positionMarketData: {
        historicalBars: { observedAt: string; source: { feed: string } };
        quote: { observedAt: string; source: { feed: string } };
      }[];
      benchmark: { observedAt: string; source: { feed: string } };
    };
    quality: { status: string; missing: string[] };
    diversification: {
      score: number;
      wholeAccount: { score: number };
      investedAssets: { score: number; grossInvested: number };
    };
  };
  expect(body.diversification.score).toBe(99);
  expect(body.diversification.wholeAccount.score).toBe(99);
  expect(body.diversification.investedAssets.score).toBe(0);
  expect(body.diversification.investedAssets.grossInvested).toBe(12_000);
  expect(body.observedAt).toBe("2026-04-02T19:59:00.000Z");
  expect(body.retrievedAt).toBe("2026-04-02T20:00:02.000Z");
  expect(body.serverRespondedAt).toBe("2026-04-02T20:00:03.000Z");
  expect(body.inputs.account).toMatchObject({
    observedAt: null,
    retrievedAt: "2026-04-02T20:00:01.000Z",
  });
  expect(body.inputs.positionMarketData[0]).toMatchObject({
    historicalBars: {
      observedAt: "2026-03-31T21:00:00.000Z",
      source: { feed: "sip" },
    },
    quote: {
      observedAt: "2026-04-02T19:59:00.000Z",
      source: { feed: "iex" },
    },
  });
  expect(body.inputs.benchmark).toMatchObject({
    observedAt: "2026-03-31T21:00:00.000Z",
    source: { feed: "sip" },
  });
  expect(body.quality).toMatchObject({ status: "complete", missing: [] });
  expect(barRequests).toHaveLength(4);
  expect(barRequests.every((options) => options.feed === "sip")).toBe(true);
  expect(
    barRequests.every(
      (options) =>
        (options.end as Date).toISOString() === "2026-04-02T20:00:00.000Z",
    ),
  ).toBe(true);
});
