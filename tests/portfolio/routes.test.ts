import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import type { CurrentPortfolioExposure } from "../../backend/features/portfolio/exposure-service";
import { handlePortfolioRequest } from "../../backend/features/portfolio/routes";
import { createStore } from "../../backend/persistence/store";

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
    syncAccountActivities: async () => ({ imported: 0, truncated: false }),
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
    syncAccountActivities: async () => ({ imported: 0, truncated: false }),
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
    syncAccountActivities: async () => ({ imported: 0, truncated: false }),
    currentPortfolioExposure: async () => ({ equity: 10_000, report }),
    capturePortfolioSnapshot: async () => {
      throw new Error("unexpected snapshot capture");
    },
  });

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(report);
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
    syncAccountActivities: async () => ({ imported: 0, truncated: false }),
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
    syncAccountActivities: async () => ({ imported: 0, truncated: false }),
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
