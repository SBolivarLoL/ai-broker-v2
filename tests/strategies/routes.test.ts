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
  expect((await listed?.json()).runs).toHaveLength(1);
  expect(store.verifyStrategyAuditTrail(createdBody.runId).valid).toBe(true);
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
