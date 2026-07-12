import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createOrderRuntime } from "../../backend/features/orders/runtime";
import { createStore } from "../../backend/persistence/store";

test("order runtime values working broker orders conservatively", async () => {
  const alpaca = {
    marketData: { getLatestPrice: async () => 125 },
  } as unknown as Alpaca;
  const runtime = createOrderRuntime(alpaca, createStore(":memory:"));
  const pending = await runtime.pendingBrokerOrders(
    [
      {
        id: "order-1",
        symbol: "AAPL",
        side: "buy",
        status: "accepted",
        qty: "10",
        filledQty: "2",
      },
      {
        id: "closed",
        symbol: "MSFT",
        side: "buy",
        status: "filled",
        qty: "1",
        filledQty: "1",
      },
    ],
    new Map(),
  );

  expect(pending).toEqual([
    { orderId: "order-1", symbol: "AAPL", side: "buy", qty: 8, price: 125 },
  ]);
});

test("order runtime recovers broker state into one shared tracker", async () => {
  let calls = 0;
  const alpaca = {
    trading: {
      orders: {
        getAllOrders: async () => {
          calls++;
          return [
            {
              id: "order-1",
              clientOrderId: "client-1",
              symbol: "AAPL",
              side: "buy",
              status: "accepted",
              qty: "1",
              filledQty: "0",
              updatedAt: new Date("2026-01-01T00:00:00Z"),
            },
          ];
        },
      },
    },
  } as unknown as Alpaca;
  const runtime = createOrderRuntime(alpaca, createStore(":memory:"));
  await Promise.all([runtime.recover(), runtime.recover()]);

  expect(calls).toBe(1);
  expect(runtime.tracker.size).toBe(1);
  expect(runtime.tracker.list("open", 10)[0]).toMatchObject({
    id: "order-1",
    status: "accepted",
  });
});

test("stale broker snapshots cannot reconcile durable state after a newer stream observation", () => {
  let receiptReconciliations = 0;
  let strategyReconciliations = 0;
  const store = {
    reconcileOrder: () => receiptReconciliations++,
    reconcileStrategyOrder: () => strategyReconciliations++,
    finishRiskReservation: () => false,
  } as any;
  const runtime = createOrderRuntime({} as Alpaca, store);
  const newer = {
    id: "order-1",
    status: "filled",
    updatedAt: new Date("2026-07-12T14:00:00.000Z"),
  };
  const stale = {
    id: "order-1",
    status: "accepted",
    updatedAt: new Date("2026-07-12T13:59:00.000Z"),
  };
  runtime.tracker.update(newer as any);

  expect(runtime.applyBrokerSnapshot(stale)).toBe(false);
  expect(runtime.tracker.list("all", 10)[0]).toMatchObject({
    status: "filled",
  });
  expect(receiptReconciliations).toBe(0);
  expect(strategyReconciliations).toBe(0);
});
