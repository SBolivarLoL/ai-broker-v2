import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createOrderRuntime } from "../../backend/features/orders/runtime";
import { handleStrategyRequest } from "../../backend/features/strategies/routes";
import { createStrategyRuntime } from "../../backend/features/strategies/runtime";
import { createStore } from "../../backend/persistence/store";

test("strategy routes create and list shadow runs through the runtime boundary", async () => {
  const alpaca = {
    marketData: {
      getCryptoBars: async () => ({
        "BTC/USD": [
          {
            timestamp: "2026-06-01T00:00:00Z",
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 10,
          },
          {
            timestamp: "2026-06-01T01:00:00Z",
            open: 101,
            high: 103,
            low: 100,
            close: 102,
            volume: 11,
          },
        ],
      }),
    },
  } as unknown as Alpaca;
  const store = createStore(":memory:");
  const runtime = createStrategyRuntime(alpaca, store, {
    gitCommit: "a".repeat(40),
    workingTreeDirty: false,
  });
  const context = {
    alpaca,
    store,
    runtime,
    orderRuntime: createOrderRuntime(alpaca, store),
    actor: "test-operator",
    allow: () => true,
    previewSecret: "p".repeat(32),
  };

  const unrelated = new Request("http://localhost/api/portfolio/risk");
  expect(
    await handleStrategyRequest(unrelated, new URL(unrelated.url), context),
  ).toBeNull();

  const backtest = new Request("http://localhost/api/strategy/backtests", {
    method: "POST",
    body: JSON.stringify({
      strategyId: "cash",
      symbols: "BTC/USD",
      timeframe: "1Hour",
      days: 30,
    }),
  });
  const backtested = await handleStrategyRequest(
    backtest,
    new URL(backtest.url),
    context,
  );
  expect(backtested?.status).toBe(201);
  const { backtestId } = await backtested!.json();

  const create = new Request("http://localhost/api/strategy/runs", {
    method: "POST",
    body: JSON.stringify({
      backtestId,
      strategyId: "cash",
      symbols: "BTC/USD",
      timeframe: "1Hour",
      days: 30,
      notes: "route boundary test",
    }),
  });
  const created = await handleStrategyRequest(
    create,
    new URL(create.url),
    context,
  );
  expect(created?.status).toBe(201);
  const createdBody = await created?.json();
  expect(createdBody).toMatchObject({
    strategyId: "cash",
    status: "shadow",
    symbols: ["BTC/USD"],
  });

  const list = new Request("http://localhost/api/strategy/runs");
  const listed = await handleStrategyRequest(list, new URL(list.url), context);
  const listedBody = await listed?.json();
  expect(listedBody.runs).toHaveLength(1);
  expect(listedBody).toMatchObject({
    retrievedAt: null,
    time: { retrievalTime: null },
  });
  expect(typeof listedBody.serverRespondedAt).toBe("string");
  expect(listedBody.asOf).toBe(listedBody.serverRespondedAt);
  expect(listedBody.time.serverResponseTime).toBe(listedBody.serverRespondedAt);
  expect(store.verifyStrategyAuditTrail(createdBody.runId).valid).toBe(true);

  const dashboardRequest = new Request(
    `http://localhost/api/strategy/runs/${createdBody.runId}/dashboard`,
  );
  const dashboardResponse = await handleStrategyRequest(
    dashboardRequest,
    new URL(dashboardRequest.url),
    context,
  );
  expect(dashboardResponse?.status).toBe(200);
  expect(await dashboardResponse?.json()).toMatchObject({
    dashboardVersion: "strategy-dashboard-v2",
    run: { id: createdBody.runId, backtestId, comparable: true },
    quality: {
      status: "empty",
      expected: {
        runConfiguration: 1,
        linkedBacktest: 1,
        cleanProvenance: 1,
        comparableRun: 1,
        decisions: 1,
        decisionTraces: 1,
        marketSnapshots: 1,
        snapshotObservationTimes: 1,
        freshMarketSnapshots: 1,
      },
      received: {
        runConfiguration: 1,
        linkedBacktest: 1,
        cleanProvenance: 1,
        comparableRun: 1,
        decisions: 0,
      },
      freshness: {
        status: "unavailable",
        expectedObservations: 1,
        receivedObservations: 0,
      },
    },
    observedAt: null,
    publishedAt: null,
    effectivePeriod: null,
  });
});

test("strategy routes enforce rate limits before strategy work", async () => {
  const alpaca = {} as Alpaca;
  const store = createStore(":memory:");
  const request = new Request("http://localhost/api/strategy/runs", {
    method: "POST",
    body: JSON.stringify({ strategyId: "cash", symbols: "BTC/USD" }),
  });
  const response = await handleStrategyRequest(request, new URL(request.url), {
    alpaca,
    store,
    runtime: createStrategyRuntime(alpaca, store),
    orderRuntime: createOrderRuntime(alpaca, store),
    actor: "test-operator",
    allow: () => false,
    previewSecret: "p".repeat(32),
  });
  expect(response?.status).toBe(429);
  expect(store.strategyRuns()).toHaveLength(0);
});
