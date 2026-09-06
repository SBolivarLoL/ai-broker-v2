import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createOrderRuntime } from "../../backend/features/orders/runtime";
import { createStore } from "../../backend/persistence/store";

test("order runtime values working broker orders conservatively", async () => {
  const alpaca = {
    marketData: { stocks: { stockLatestTradeSingle: async ({symbol}: any) => ({symbol, trade:{p:125,t:new Date()}}) } },
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


test("pending order valuation skips broker price reads when an authoritative limit exists",async()=>{
 let calls=0;
 const store=createStore(":memory:");
 const runtime=createOrderRuntime({marketData:{stocks:{stockLatestTradeSingle:async()=>{calls++;throw new Error("unexpected");}}}} as any,store);
 try {
  const values=await runtime.pendingBrokerOrders([{id:"limit",symbol:"SPY",side:"buy",status:"accepted",qty:"1",filledQty:"0",limitPrice:"90"}],new Map());
  expect(values[0]?.price).toBe(90);
  expect(calls).toBe(0);
 } finally {store.close();}
});

test("pending market orders with stale reference trades block risk reservation",async()=>{
 const store=createStore(":memory:");
 const runtime=createOrderRuntime({marketData:{stocks:{stockLatestTradeSingle:async()=>({symbol:"SPY",trade:{p:100,t:new Date(Date.now()-61_000)}})}}} as any,store);
 try {
  await expect(runtime.pendingBrokerOrders([{id:"market",symbol:"SPY",side:"buy",status:"accepted",qty:"1",filledQty:"0"}],new Map())).rejects.toThrow("60 seconds");
 } finally {store.close();}
});


test("mixed-asset pending orders never use the stock endpoint for unsupported valuations",async()=>{
 const store=createStore(":memory:"); let calls=0;
 const runtime=createOrderRuntime({marketData:{stocks:{stockLatestTradeSingle:async()=>{calls++;throw new Error("unexpected stock endpoint");}}}} as any,store);
 try {
  for(const [symbol,assetClass] of [["BTC/USD","crypto"],["AAPL260918C00100000","us_option"]]) {
   const order={id:"other",symbol,assetClass,side:"buy",status:"accepted",qty:"1",filledQty:"0"};
   await expect(runtime.pendingBrokerOrders([order],new Map())).rejects.toMatchObject({status:409,details:{code:"pending_order_price_unavailable",nextAction:"refresh_orders"}});
   expect((await runtime.pendingBrokerOrders([order],new Map([[symbol!,100]])))[0]?.price).toBe(100);
  }
  expect(calls).toBe(0);
 } finally {store.close();}
});

test("order runtime disconnects polling and reuses one stream across restart", async () => {
  let connects = 0;
  let disconnects = 0;
  let subscriptions = 0;
  const intervals: unknown[] = [];
  const cleared: unknown[] = [];
  const stream = {
    onStateChange() {},
    onConnect() {},
    onDisconnect() {},
    onError() {},
    onTradeUpdate() {},
    send() {},
    subscribeTradeUpdates() {
      subscriptions++;
    },
    connect() {
      connects++;
    },
    disconnect() {
      disconnects++;
    },
  };
  const alpaca = {
    trading: {
      stream: () => stream,
      orders: { getAllOrders: async () => [] },
    },
  } as unknown as Alpaca;
  const store = createStore(":memory:");
  const runtime = createOrderRuntime(alpaca, store, () => new Date(), {
    setIntervalFn: (_callback, milliseconds) => {
      const handle = { milliseconds };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => cleared.push(handle),
  });

  await runtime.start();
  await runtime.start();
  expect(connects).toBe(1);
  expect(subscriptions).toBe(1);
  expect(intervals).toEqual([{ milliseconds: 30_000 }]);

  runtime.stop();
  runtime.stop();
  expect(disconnects).toBe(1);
  expect(cleared).toEqual(intervals);

  await runtime.start();
  expect(connects).toBe(2);
  expect(subscriptions).toBe(1);
  expect(intervals).toHaveLength(2);
  runtime.stop();
  expect(disconnects).toBe(2);
  expect(cleared).toEqual(intervals);
  store.close();
});
