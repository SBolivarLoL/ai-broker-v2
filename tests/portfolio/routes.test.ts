import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
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

test("portfolio risk distinguishes whole-account and invested-asset diversification", async () => {
  const positions = [
    { symbol: "AAPL", qty: "70", marketValue: "7000", unrealizedPl: "100" },
    { symbol: "MSFT", qty: "40", marketValue: "4000", unrealizedPl: "50" },
    { symbol: "NVDA", qty: "10", marketValue: "1000", unrealizedPl: "25" },
  ];
  const bars = Array.from({ length: 90 }, (_, index) => ({
    close: 100 + index,
    volume: 100_000,
  }));
  const alpaca = {
    trading: {
      account: {
        getAccount: async () => ({ equity: "100000", cash: "88000" }),
      },
      positions: { getAllOpenPositions: async () => positions },
    },
    marketData: {
      getStockBarsFor: async () => bars,
      stocks: {
        stockSnapshotSingle: async () => ({
          latestQuote: { bp: 99, ap: 101 },
        }),
      },
    },
  } as unknown as Alpaca;
  const request = new Request("http://localhost/api/portfolio/risk");
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
  });

  expect(response?.status).toBe(200);
  const body = (await response?.json()) as {
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
});
