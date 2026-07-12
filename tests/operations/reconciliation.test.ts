import { afterEach, expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createOrderRuntime } from "../../backend/features/orders/runtime";
import {
  createReconciliationService,
  reconciliationReport,
} from "../../backend/features/operations/reconciliation";
import { createStore } from "../../backend/persistence/store";

const stores: ReturnType<typeof createStore>[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const at = new Date("2026-07-12T14:00:00.000Z");
const rawBar = {
  t: new Date("2026-07-12T13:59:00.000Z"),
  o: 100,
  h: 102,
  l: 99,
  c: 101,
  v: 1_000,
  n: 50,
  vw: 100.5,
};
const canonicalBar = {
  timestamp: new Date("2026-07-12T13:59:00.000Z"),
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 1_000,
  tradeCount: 50,
  vwap: 100.5,
};
const openOrder = {
  id: "2e45d9cc-d5e2-4514-8171-c6f85fda5d09",
  clientOrderId: "reconcile-one",
  symbol: "AAPL",
  side: "buy",
  status: "accepted",
  qty: "1",
  filledQty: "0",
  filledAvgPrice: null,
  updatedAt: new Date("2026-07-12T13:58:00.000Z"),
};

function fixture(overrides: {
  account?: any;
  positions?: any[];
  bulkOrder?: any;
  detailOrder?: any;
  latestBar?: any;
  historicalBar?: any;
} = {}) {
  const bulkOrder = overrides.bulkOrder ?? openOrder;
  const detailOrder = overrides.detailOrder ?? bulkOrder;
  const positions =
    overrides.positions ??
    [{ symbol: "AAPL", marketValue: "100", qty: "1" }];
  const alpaca = {
    trading: {
      account: {
        getAccount: async () =>
          overrides.account ?? {
            equity: "1100",
            cash: "1000",
            status: "ACTIVE",
          },
      },
      positions: { getAllOpenPositions: async () => positions },
      orders: {
        getAllOrders: async () => (bulkOrder ? [bulkOrder] : []),
        getOrderByOrderID: async () => detailOrder,
      },
    },
    marketData: {
      stocks: {
        stockLatestBars: async () => ({
          bars: { AAPL: overrides.latestBar ?? rawBar },
        }),
      },
      getStockBarsFor: async () => [
        overrides.historicalBar ?? canonicalBar,
      ],
    },
  } as unknown as Alpaca;
  const store = createStore(":memory:");
  stores.push(store);
  const orderRuntime = createOrderRuntime(alpaca, store, () => at);
  return {
    store,
    service: createReconciliationService({
      alpaca,
      store,
      orderRuntime,
      now: () => at,
    }),
    orderRuntime,
  };
}

test("scheduled reconciliation records a healthy bounded cross-check", async () => {
  const { service, store } = fixture();
  const run = await service.run("scheduler", "reconciliation-scheduler");

  expect(run).toMatchObject({
    schemaVersion: "scheduled-reconciliation-v1",
    trigger: "scheduler",
    actor: "reconciliation-scheduler",
    status: "healthy",
    scope: {
      marketSymbols: ["AAPL"],
      listedOrders: 1,
      detailedOrders: 1,
    },
    checks: { marketBars: "passed", account: "passed", orders: "passed" },
    summary: {
      discrepancyCount: 0,
      recoveredCount: 0,
      unresolvedCount: 0,
    },
  });
  expect(store.events(10, "operations.reconciliation.completed")).toHaveLength(
    1,
  );
  expect(reconciliationReport(store)).toMatchObject({
    reportVersion: "reconciliation-report-v1",
    latest: { runId: run.runId, status: "healthy" },
    evidence: {
      completedRuns: 1,
      discrepancyEvents: 0,
      recoveryEvents: 0,
      failedRuns: 0,
      latestFailure: null,
    },
  });
});

test("reconciliation persists discrepancies and verifies local order recovery", async () => {
  const detail = {
    ...openOrder,
    status: "filled",
    filledQty: "1",
    filledAvgPrice: "101",
    updatedAt: new Date("2026-07-12T13:59:30.000Z"),
  };
  const { service, store, orderRuntime } = fixture({
    account: { equity: "1200", cash: "1000", status: "ACTIVE" },
    detailOrder: detail,
    historicalBar: {
      ...canonicalBar,
      timestamp: new Date("2026-07-12T13:58:00.000Z"),
      close: 100,
    },
  });
  const run = await service.run("manual", "test-admin");

  expect(run.status).toBe("error");
  expect(run.discrepancies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        domain: "account",
        code: "equity_position_reconciliation_gap",
        recovery: { status: "not_applicable", action: expect.any(String), verifiedAt: at.toISOString() },
      }),
      expect.objectContaining({
        domain: "order",
        code: "order_query_mismatch",
        recovery: {
          status: "local_state_synchronized",
          action: expect.any(String),
          verifiedAt: at.toISOString(),
        },
      }),
      expect.objectContaining({
        domain: "market_bar",
        code: "historical_bar_lag",
        recovery: { status: "not_applicable", action: expect.any(String), verifiedAt: at.toISOString() },
      }),
    ]),
  );
  expect(run.summary).toMatchObject({
    discrepancyCount: 3,
    recoveredCount: 1,
    unresolvedCount: 0,
    warningCount: 2,
    errorCount: 1,
  });
  expect(orderRuntime.tracker.list("all", 10)[0]).toMatchObject({
    id: detail.id,
    status: "filled",
  });
  expect(store.events(10, "operations.reconciliation.discrepancy")).toHaveLength(
    3,
  );
  expect(store.events(10, "operations.reconciliation.recovery")).toHaveLength(3);
});

test("reconciliation keeps independent-query failures explicit", async () => {
  const store = createStore(":memory:");
  stores.push(store);
  const alpaca = {
    trading: {
      account: { getAccount: async () => { throw new Error("account down"); } },
      positions: { getAllOpenPositions: async () => { throw new Error("positions down"); } },
      orders: { getAllOrders: async () => { throw new Error("orders down"); } },
    },
  } as unknown as Alpaca;
  const orderRuntime = createOrderRuntime(alpaca, store, () => at);
  const service = createReconciliationService({
    alpaca,
    store,
    orderRuntime,
    now: () => at,
  });

  const run = await service.run("scheduler", "reconciliation-scheduler");
  expect(run).toMatchObject({
    status: "error",
    checks: { marketBars: "skipped", account: "failed", orders: "failed" },
    summary: { discrepancyCount: 3, unresolvedCount: 3, errorCount: 3 },
  });
  expect(run.discrepancies.map((item) => item.code).sort()).toEqual([
    "account_query_failed",
    "bulk_order_query_failed",
    "positions_query_failed",
  ]);
});

test("order reconciliation preserves the newer bulk observation", async () => {
  const newerBulk = {
    ...openOrder,
    status: "partially_filled",
    filledQty: "0.5",
    filledAvgPrice: "100",
    updatedAt: new Date("2026-07-12T13:59:30.000Z"),
  };
  const olderDetail = {
    ...openOrder,
    updatedAt: new Date("2026-07-12T13:58:30.000Z"),
  };
  const { service, orderRuntime } = fixture({
    bulkOrder: newerBulk,
    detailOrder: olderDetail,
  });

  const run = await service.run("manual", "test-admin");
  expect(run.discrepancies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        domain: "order",
        code: "order_query_mismatch",
        detail: expect.objectContaining({
          selectedEndpoint: "trading.orders.getAllOrders",
          ambiguousObservationTime: false,
        }),
        recovery: expect.objectContaining({
          status: "local_state_synchronized",
        }),
      }),
    ]),
  );
  expect(orderRuntime.tracker.list("all", 10)[0]).toMatchObject({
    status: "partially_filled",
    updatedAt: newerBulk.updatedAt,
  });
});

test("order reconciliation leaves equal-time conflicting responses unresolved", async () => {
  const conflictingDetail = {
    ...openOrder,
    status: "partially_filled",
    filledQty: "0.5",
  };
  const { service, orderRuntime } = fixture({ detailOrder: conflictingDetail });

  const run = await service.run("manual", "test-admin");
  expect(run.discrepancies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        domain: "order",
        detail: expect.objectContaining({ ambiguousObservationTime: true }),
        recovery: expect.objectContaining({ status: "unresolved" }),
      }),
    ]),
  );
  expect(orderRuntime.tracker.list("all", 10)[0]).toMatchObject({
    status: "accepted",
  });
});

test("account reconciliation fails closed on malformed position values", async () => {
  const { service } = fixture({
    positions: [{ symbol: "AAPL", marketValue: "not-a-number", qty: "1" }],
  });
  const run = await service.run("manual", "test-admin");
  expect(run.checks.account).toBe("failed");
  expect(run.discrepancies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        domain: "account",
        code: "position_values_unavailable",
        detail: { invalidPositionSymbols: ["AAPL"] },
        recovery: expect.objectContaining({ status: "unresolved" }),
      }),
    ]),
  );
});

test("market reconciliation detects same-time bar revisions", async () => {
  const { service } = fixture({
    historicalBar: { ...canonicalBar, close: 100.75 },
  });
  const run = await service.run("manual", "test-admin");
  expect(run.status).toBe("warning");
  expect(run.discrepancies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        domain: "market_bar",
        code: "bar_revision_mismatch",
        severity: "warning",
        detail: expect.objectContaining({ mismatchedFields: ["close"] }),
      }),
    ]),
  );
});

test("reconciliation enforces market-symbol and order-detail bounds", async () => {
  const positions = Array.from({ length: 30 }, (_, index) => ({
    symbol: `S${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
    marketValue: "0",
    qty: "0",
  }));
  const orders = positions.map((position, index) => ({
    ...openOrder,
    id: `order-${String(index).padStart(2, "0")}`,
    clientOrderId: `bounded-${index}`,
    symbol: position.symbol,
  }));
  let detailed = 0;
  let latestSymbols: string[] = [];
  const store = createStore(":memory:");
  stores.push(store);
  const alpaca = {
    trading: {
      account: { getAccount: async () => ({ equity: 100, cash: 100, status: "ACTIVE" }) },
      positions: { getAllOpenPositions: async () => positions },
      orders: {
        getAllOrders: async () => orders,
        getOrderByOrderID: async ({ orderId }: any) => {
          detailed++;
          return orders.find((order) => order.id === orderId);
        },
      },
    },
    marketData: {
      stocks: {
        stockLatestBars: async ({ symbols }: any) => {
          latestSymbols = symbols.split(",");
          return {
            bars: Object.fromEntries(
              latestSymbols.map((symbol) => [symbol, rawBar]),
            ),
          };
        },
      },
      getStockBarsFor: async () => [canonicalBar],
    },
  } as unknown as Alpaca;
  const orderRuntime = createOrderRuntime(alpaca, store, () => at);
  const service = createReconciliationService({ alpaca, store, orderRuntime, now: () => at });

  const run = await service.run("manual", "test-admin");
  expect(run.status).toBe("healthy");
  expect(run.scope).toMatchObject({
    omittedMarketSymbols: 10,
    listedOrders: 30,
    detailedOrders: 25,
    omittedDetailedOrders: 5,
  });
  expect(run.scope.marketSymbols).toHaveLength(20);
  expect(latestSymbols).toHaveLength(20);
  expect(detailed).toBe(25);
});

test("overlapping reconciliation calls share one provider run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let accountCalls = 0;
  const store = createStore(":memory:");
  stores.push(store);
  const alpaca = {
    trading: {
      account: { getAccount: async () => { accountCalls++; await gate; return { equity: 100, cash: 100, status: "ACTIVE" }; } },
      positions: { getAllOpenPositions: async () => [] },
      orders: { getAllOrders: async () => [] },
    },
  } as unknown as Alpaca;
  const orderRuntime = createOrderRuntime(alpaca, store, () => at);
  const service = createReconciliationService({ alpaca, store, orderRuntime, now: () => at });
  const first = service.run("scheduler", "reconciliation-scheduler");
  const second = service.run("manual", "test-admin");
  release();

  expect(await second).toEqual(await first);
  expect(accountCalls).toBe(1);
  expect(store.events(10, "operations.reconciliation.completed")).toHaveLength(1);
});

test("unexpected reconciliation failures leave sanitized durable evidence", async () => {
  const store = createStore(":memory:");
  stores.push(store);
  const alpaca = {
    trading: {
      account: { getAccount() { throw new TypeError("private provider detail"); } },
      positions: { getAllOpenPositions: async () => [] },
      orders: { getAllOrders: async () => [] },
    },
  } as unknown as Alpaca;
  const orderRuntime = createOrderRuntime(alpaca, store, () => at);
  const service = createReconciliationService({ alpaca, store, orderRuntime, now: () => at });

  await expect(
    service.run("scheduler", "reconciliation-scheduler"),
  ).rejects.toThrow("private provider detail");
  expect(store.events(10, "operations.reconciliation.failed")).toMatchObject([
    {
      actor: "reconciliation-scheduler",
      payload: {
        schemaVersion: "scheduled-reconciliation-failure-v1",
        trigger: "scheduler",
        reason: "unexpected_reconciliation_failure",
        errorType: "TypeError",
      },
    },
  ]);
  expect(JSON.stringify(reconciliationReport(store))).not.toContain(
    "private provider detail",
  );
});
