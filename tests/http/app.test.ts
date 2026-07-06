import { afterEach, expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createApp } from "../../backend/app";
import { createStore } from "../../backend/persistence/store";

const codeIdentity = { gitCommit: "a".repeat(40), workingTreeDirty: false };
const optionSymbols = ["AAPL260717C00100000", "AAPL260717C00101000"] as const;
const stores: ReturnType<typeof createStore>[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

type FakeAlpacaOptions = {
  accountError?: Error;
  placementError?: Error;
  placementErrorAt?: number;
  placementGate?: Promise<void>;
  positions?: any[];
  recoveryError?: Error;
  recoveredOrderStatus?: string;
  cancellationError?: Error;
  replacementError?: Error;
  placementStatus?: string;
  accountEquity?: number;
  optionActionError?: Error;
  cryptoBarsError?: Error;
  cryptoBars?: (request: any) => Record<string, any[]>;
};

function fakeAlpaca(options: FakeAlpacaOptions = {}) {
  let stockConnects = 0;
  let orderStreamConnects = 0;
  const orderAttempts: any[] = [];
  const cancellationAttempts: string[] = [];
  const replacementAttempts: any[] = [];
  const optionActionAttempts: { action: string; symbol: string }[] = [];
  const cryptoBarRequests: any[] = [];
  const acceptedOrders = new Map<string, any>();
  const orderStreamCallbacks: Record<string, (...args: any[]) => void> = {};
  const orderStream = {
    onStateChange(callback: (...args: any[]) => void) { orderStreamCallbacks.state = callback; },
    onConnect(callback: (...args: any[]) => void) { orderStreamCallbacks.connect = callback; },
    onDisconnect(callback: (...args: any[]) => void) { orderStreamCallbacks.disconnect = callback; },
    onError(callback: (...args: any[]) => void) { orderStreamCallbacks.error = callback; },
    onTradeUpdate(callback: (...args: any[]) => void) { orderStreamCallbacks.trade = callback; },
    subscribeTradeUpdates() {},
    connect() { orderStreamConnects++; },
  };
  const stockStream = {
    onStateChange() {}, onConnect() {}, onDisconnect() {}, onError() {}, onQuote() {}, onBar() {},
    subscribeForQuotes() {}, subscribeForBars() {}, unsubscribeFromQuotes() {}, unsubscribeFromBars() {},
    connect() { stockConnects++; },
  };
  const placeOrder = async (input: any, orderClass = "simple") => {
    orderAttempts.push(input);
    if (options.placementGate) await options.placementGate;
    if (options.placementError || options.placementErrorAt === orderAttempts.length - 1) throw options.placementError ?? new Error("private basket placement failure");
    const order = {
      id: crypto.randomUUID(),
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      qty: input.qty === undefined ? null : String(input.qty),
      notional: input.notional === undefined ? null : String(input.notional),
      filledQty: "0",
      filledAvgPrice: null,
      type: input.limitPrice === undefined ? "market" : "limit",
      orderClass,
      timeInForce: input.timeInForce,
      status: options.placementStatus ?? "accepted",
      limitPrice: input.limitPrice === undefined ? null : String(input.limitPrice),
      stopPrice: null,
      extendedHours: input.extendedHours,
      submittedAt: new Date(),
      filledAt: null,
      canceledAt: null,
      updatedAt: new Date(),
      replacedBy: null,
      replaces: null,
      legs: [],
    };
    acceptedOrders.set(input.clientOrderId, order);
    return order;
  };
  const alpaca = {
    marketData: {
      stockStream: () => stockStream,
      getLatestPrice: async () => 100,
      stocks: {
        stockSnapshotSingle: async () => ({
          latestQuote: { bp: 99.9, ap: 100.1 },
          dailyBar: { v: 1_000_000 },
        }),
      },
      options: {
        optionSnapshots: async () => ({ snapshots: {
          [optionSymbols[0]]: { latestQuote: { bp: 0.1, ap: 0.2 } },
          [optionSymbols[1]]: { latestQuote: { bp: 0.1, ap: 0.2 } },
        } }),
      },
      getCryptoBars: async (request: any) => {
        cryptoBarRequests.push(request);
        if (options.cryptoBarsError) throw options.cryptoBarsError;
        return options.cryptoBars?.(request) ?? {
          "BTC/USD": [
            { t: "2026-01-01T00:00:00.000Z", o: 100, h: 102, l: 99, c: 101, v: 10 },
            { t: "2026-01-01T01:00:00.000Z", o: 101, h: 103, l: 100, c: 102, v: 12 },
          ],
        };
      },
      crypto: {
        cryptoSnapshots: async () => {
          const timestamp = new Date().toISOString();
          return { snapshots: { "BTC/USD": { latestQuote: { bp: 101, bs: 2, ap: 102, as: 2, t: timestamp }, latestTrade: { p: 101.5, s: 1, t: timestamp }, latestBar: { o: 100, h: 103, l: 99, c: 101.5, v: 20, t: timestamp } } } };
        },
        cryptoLatestOrderbooks: async () => ({ orderbooks: { "BTC/USD": { a: [{ p: 102, s: 2 }], b: [{ p: 101, s: 2 }] } } }),
      },
    },
    trading: {
      stream: () => orderStream,
      account: { getAccount: async () => { if (options.accountError) throw options.accountError; const equity = options.accountEquity ?? 1_000; return { equity, cash: equity, buyingPower: equity, optionsBuyingPower: equity, optionsTradingLevel: 3, currency: "USD", status: "ACTIVE" }; } },
      positions: {
        getAllOpenPositions: async () => options.positions ?? [],
        getOpenPosition: async ({ symbolOrAssetId }: any) => {
          const position = options.positions?.find(item => item.symbol === symbolOrAssetId);
          if (!position) throw new Error("Position not found");
          return position;
        },
        optionExercise: async ({ symbolOrContractId }: any) => {
          optionActionAttempts.push({ action: "exercise", symbol: symbolOrContractId });
          if (options.optionActionError) throw options.optionActionError;
        },
        optionDoNotExercise: async ({ symbolOrContractId }: any) => {
          optionActionAttempts.push({ action: "do_not_exercise", symbol: symbolOrContractId });
          if (options.optionActionError) throw options.optionActionError;
        },
      },
      assets: {
        getV2AssetsSymbolOrAssetId: async ({ symbolOrAssetId }: any) => ({
          symbol: symbolOrAssetId,
          _class: "us_equity",
          tradable: true,
          fractionable: true,
          shortable: true,
          easyToBorrow: true,
          marginable: true,
        }),
        getOptionContractSymbolOrId: async ({ symbolOrId }: any) => ({
          symbol: symbolOrId,
          underlyingSymbol: "AAPL",
          expirationDate: new Date("2026-07-17T00:00:00.000Z"),
          type: "call",
          strikePrice: symbolOrId === optionSymbols[0] ? "100" : "101",
          multiplier: "100",
          tradable: true,
        }),
      },
      calendar: {
        clock: async () => ({
          clocks: [{
            market: { acronym: "NASDAQ" },
            phase: "open",
            isMarketDay: true,
            timestamp: new Date(),
            nextMarketOpen: new Date(Date.now() + 86_400_000),
            nextMarketClose: new Date(Date.now() + 3_600_000),
          }],
        }),
      },
      orders: {
        getAllOrders: async (query: any) => {
          if (options.recoveryError) throw options.recoveryError;
          if (query.status === "open") return [...acceptedOrders.values()].filter(order => ["new", "accepted", "partially_filled"].includes(order.status));
          if (!options.recoveredOrderStatus) return [];
          return [...acceptedOrders.values()].map(order => ({
            ...order,
            status: options.recoveredOrderStatus,
            filledQty: options.recoveredOrderStatus === "filled" ? order.qty : order.filledQty,
            filledAvgPrice: options.recoveredOrderStatus === "filled" ? "100" : order.filledAvgPrice,
            filledAt: options.recoveredOrderStatus === "filled" ? new Date() : order.filledAt,
            updatedAt: new Date(),
          }));
        },
        market: (input: any) => placeOrder(input),
        limit: (input: any) => placeOrder(input),
        submit: (input: any) => placeOrder({ ...input, symbol: "AAPL_OPTION_VERTICAL" }, "mleg"),
        bracket: (input: any) => placeOrder(input, "bracket"),
        oco: (input: any) => placeOrder(input, "oco"),
        oto: (input: any) => placeOrder(input, "oto"),
        getOrderByClientOrderId: async ({ clientOrderId }: any) => {
          const order = acceptedOrders.get(clientOrderId);
          if (!order) throw new Error("Order not found");
          return order;
        },
        getOrderByOrderID: async ({ orderId }: any) => {
          const order = [...acceptedOrders.values()].find(item => item.id === orderId);
          if (!order) throw new Error("Order not found");
          return order;
        },
        deleteOrderByOrderID: async ({ orderId }: any) => {
          cancellationAttempts.push(orderId);
          if (options.cancellationError) throw options.cancellationError;
        },
        patchOrderByOrderId: async (input: any) => {
          replacementAttempts.push(input);
          if (options.replacementError) throw options.replacementError;
          const order = [...acceptedOrders.values()].find(item => item.id === input.orderId);
          if (!order) throw new Error("Order not found");
          const request = input.patchOrderRequest;
          const replaced = { ...order, id: crypto.randomUUID(), clientOrderId: request.clientOrderId, qty: request.qty, limitPrice: request.limitPrice ?? order.limitPrice, stopPrice: request.stopPrice ?? order.stopPrice, replaces: order.id, updatedAt: new Date() };
          acceptedOrders.set(request.clientOrderId, replaced);
          return replaced;
        },
      },
    },
  } as unknown as Alpaca;
  return {
    alpaca,
    stockConnects: () => stockConnects,
    orderStreamConnects: () => orderStreamConnects,
    orderAttempts,
    cancellationAttempts,
    replacementAttempts,
    optionActionAttempts,
    cryptoBarRequests,
    emitOrderStreamState: (state: string) => orderStreamCallbacks.state?.(state),
    emitTradeUpdate: (clientOrderId: string, status: string) => {
      const order = acceptedOrders.get(clientOrderId);
      if (!order) throw new Error("Order not found");
      const updated = { ...order, status, filledQty: status === "filled" ? order.qty : order.filledQty, filledAvgPrice: status === "filled" ? "100" : order.filledAvgPrice, filledAt: status === "filled" ? new Date() : order.filledAt, updatedAt: new Date() };
      acceptedOrders.set(clientOrderId, updated);
      orderStreamCallbacks.trade?.({ event: status === "filled" ? "fill" : "update", order: updated, timestamp: new Date() });
    },
  };
}

function testApp(env: Record<string, string | undefined> = {}, options: FakeAlpacaOptions = {}) {
  const store = createStore(":memory:");
  stores.push(store);
  const fake = fakeAlpaca(options);
  // Relaxed auth is opt-in; default test apps to the development/test path so
  // demo-identity contracts hold unless a test supplies its own NODE_ENV.
  const resolvedEnv = { NODE_ENV: "test", ...env };
  return { ...createApp({ alpaca: fake.alpaca, store, codeIdentity, env: resolvedEnv, setIntervalFn: () => 0 }), store, stockConnects: fake.stockConnects, orderStreamConnects: fake.orderStreamConnects, orderAttempts: fake.orderAttempts, cancellationAttempts: fake.cancellationAttempts, replacementAttempts: fake.replacementAttempts, optionActionAttempts: fake.optionActionAttempts, cryptoBarRequests: fake.cryptoBarRequests, emitOrderStreamState: fake.emitOrderStreamState, emitTradeUpdate: fake.emitTradeUpdate };
}

const productionEnv = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://broker.example.com",
  AUTHORIZED_EMAIL_DOMAIN: "example.com",
  AUTH_PROXY_SECRET: "a".repeat(32),
  SECRET_VAULT_KEY: "b".repeat(32),
  PREVIEW_SECRET: "c".repeat(32),
  SEC_USER_AGENT: "ai-broker-v2 ops@example.com",
};

function productionHeaders(
  role: string,
  mutation = false,
  email = "advisor@example.com",
) {
  return {
    "x-auth-proxy-secret": productionEnv.AUTH_PROXY_SECRET,
    "x-auth-request-email": email,
    "x-auth-request-roles": role,
    ...(mutation ? { origin: productionEnv.APP_ORIGIN, "content-type": "application/json" } : {}),
  };
}

test("createApp is side-effect free and exposes basic HTTP contracts", async () => {
  const app = testApp();
  expect(app.stockConnects()).toBe(0);

  const health = await app.fetch(new Request("http://local/health"));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  expect(health.headers.get("cache-control")).toBe("no-store");
  expect(health.headers.get("x-content-type-options")).toBe("nosniff");

  const missing = await app.fetch(new Request("http://local/api/not-a-route"));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Not found" });
  expect(app.stockConnects()).toBe(0);
});

test("runtime starts once and reconciles terminal trade stream updates", async () => {
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32), STRATEGY_SCHEDULER_DISABLED: "1" });
  const order = await (await equitySubmission(app, (await equityPreview(app)).previewToken, "stream-reconcile")).json() as any;
  expect(app.store.activeRiskReservations()).toHaveLength(1);

  app.startRuntime();
  app.startRuntime();
  await Bun.sleep(0);
  expect(app.orderStreamConnects()).toBe(1);
  expect(app.stockConnects()).toBe(1);

  app.emitOrderStreamState("authenticated");
  app.emitTradeUpdate("stream-reconcile", "filled");
  const response = await app.fetch(new Request("http://local/api/orders"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ orders: [expect.objectContaining({ id: order.id, status: "filled", filledQty: 0.1 })], sync: { streamState: "authenticated" } });
  expect(app.store.getReceipt(order.receiptId)).toMatchObject({ orderId: order.id, status: "filled", updatedAt: expect.any(String) });
  expect(app.store.activeRiskReservations()).toEqual([]);
  expect(app.store.events(10, "order.stream.update")).toMatchObject([{ payload: { event: "fill", orderId: order.id, clientOrderId: "stream-reconcile", status: "filled" } }]);
});

test("injected env, not process.env, controls the strategy scheduler", async () => {
  const intervals: number[] = [];
  const setIntervalFn = (_callback: () => void, milliseconds: number) => {
    intervals.push(milliseconds);
    return 0;
  };
  const store = createStore(":memory:");
  stores.push(store);

  const disabled = createApp({ alpaca: fakeAlpaca().alpaca, store, codeIdentity, env: { STRATEGY_SCHEDULER_DISABLED: "1" }, setIntervalFn });
  disabled.startRuntime();
  expect(intervals).toEqual([15 * 60_000]);

  intervals.length = 0;
  const enabled = createApp({ alpaca: fakeAlpaca().alpaca, store, codeIdentity, env: { STRATEGY_SCHEDULER_POLL_MS: "30000" }, setIntervalFn });
  enabled.startRuntime();
  expect(intervals).toEqual([15 * 60_000, 30_000]);
});

test("data-governance API exposes provider and stored-output decisions", async () => {
  const response = await testApp().fetch(new Request("http://local/api/operations/data-governance"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    summary: { totalSources: 16, storedOutputCategories: 12 },
    sources: expect.arrayContaining([expect.objectContaining({ id: "openai_api", liveUseDecision: "external_review_required" })]),
    storedOutputs: expect.arrayContaining([expect.objectContaining({ id: "strategy_experiments", redistributionDecision: "internal_only" })]),
  });
});

test("API authorization distinguishes authentication roles and route families", async () => {
  const app = testApp(productionEnv);
  expect((await app.fetch(new Request("https://broker.example.com/api/operations/policy"))).status).toBe(401);
  expect((await app.fetch(new Request("https://broker.example.com/api/operations/policy", { headers: productionHeaders("viewer") }))).status).toBe(403);

  const operations = await app.fetch(new Request("https://broker.example.com/api/operations/policy", { headers: productionHeaders("operator") }));
  expect(operations.status).toBe(200);
  expect(await operations.json()).toMatchObject({ policy: { schemaVersion: "operations-policy-v1" } });

  for (const path of ["/api/orders/preview", "/api/strategy/runs", "/api/research/runs"]) {
    const response = await app.fetch(new Request(`https://broker.example.com${path}`, { method: "POST", headers: productionHeaders("viewer", true), body: "{}" }));
    expect(response.status).toBe(403);
  }

  const orderParsing = await app.fetch(new Request("https://broker.example.com/api/orders/preview", { method: "POST", headers: productionHeaders("trader", true), body: "{" }));
  expect(orderParsing.status).toBe(400);
  const strategyParsing = await app.fetch(new Request("https://broker.example.com/api/strategy/runs", { method: "POST", headers: productionHeaders("operator", true), body: "{" }));
  expect(strategyParsing.status).toBe(400);
  const researchUnavailable = await app.fetch(new Request("https://broker.example.com/api/research/runs", { method: "POST", headers: productionHeaders("researcher", true), body: "{}" }));
  expect(researchUnavailable.status).toBe(503);

  const portfolio = await app.fetch(new Request("https://broker.example.com/api/portfolio/risk", { headers: productionHeaders("viewer") }));
  expect(portfolio.status).toBe(502);
});

test("mutation origin and request body limits fail before route work", async () => {
  const production = testApp(productionEnv);
  const wrongOrigin = await production.fetch(new Request("https://broker.example.com/api/strategy/runs", {
    method: "POST",
    headers: { ...productionHeaders("operator", true), origin: "https://evil.example" },
    body: "{}",
  }));
  expect(wrongOrigin.status).toBe(403);
  expect(await wrongOrigin.json()).toEqual({ error: "Invalid request origin" });

  const local = testApp();
  const oversized = await local.fetch(new Request("http://local/api/strategy/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(16_385) }),
  }));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ error: "Request body is too large" });
});

test("strategy routes reject invalid configuration without provider calls", async () => {
  const app = testApp();
  const backtest = await app.fetch(new Request("http://local/api/strategy/backtests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols: ["BTC/USD"], strategyId: "moving-average-trend", timeframe: "1Hour", days: 30, params: { fast: 20, slow: 20 } }),
  }));
  expect(backtest.status).toBe(400);
  expect(await backtest.json()).toEqual({ error: "Invalid moving-average-trend parameters: slow must be greater than fast" });

  const ambiguousPeer = await app.fetch(new Request("http://local/api/strategy/backtests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols: ["BTC/USD", "ETH/USD"], strategyId: "btc-eth-relative-strength", timeframe: "1Hour", days: 30, params: { peerSymbol: "BTC/USD" } }),
  }));
  expect(ambiguousPeer.status).toBe(400);
  expect(await ambiguousPeer.json()).toEqual({ error: "Invalid btc-eth-relative-strength parameters: Unrecognized key: \"peerSymbol\"" });

  const run = await app.fetch(new Request("http://local/api/strategy/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols: ["BTC/USD"], strategyId: "cash", timeframe: "1Hour", days: 30, params: { exposure: 1 } }),
  }));
  expect(run.status).toBe(400);
  expect(await run.json()).toEqual({ error: "Invalid cash parameters: Unrecognized key: \"exposure\"" });

  const walkForward = await app.fetch(new Request("http://local/api/strategy/backtests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      symbols: ["BTC/USD"],
      strategyId: "time-sliced-accumulation",
      timeframe: "1Hour",
      days: 30,
      walkForward: {
        trainSize: 10,
        testSize: 2,
        candidates: [{}, { slices: 10, maxExposure: 1 }],
      },
    }),
  }));
  expect(walkForward.status).toBe(400);
  expect(await walkForward.json()).toEqual({
    error: "walkForward candidates must be unique after defaults are applied",
  });
  expect(app.cryptoBarRequests).toHaveLength(0);
});

test("strategy dataset API ingests chunked history and powers a stored-data backtest", async () => {
  const app = testApp({}, {
    cryptoBars: (request) => ({
      "BTC/USD": [
        {
          t: new Date(request.start).toISOString(),
          o: 100,
          h: 102,
          l: 99,
          c: 101,
          v: 10,
        },
      ],
    }),
  });
  const datasetRequest = {
    symbols: ["BTC/USD"],
    timeframe: "1Day",
    start: "2025-01-01T00:00:00.000Z",
    end: "2025-07-20T00:00:00.000Z",
  };
  const ingest = await app.fetch(new Request("http://local/api/strategy/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(datasetRequest),
  }));
  expect(ingest.status).toBe(201);
  const ingested = await ingest.json() as any;
  const datasetId = String(ingested.dataset.id);
  const datasetHash = String(ingested.dataset.datasetHash);
  expect(ingested).toMatchObject({
    reused: false,
    chunks: 3,
    dataset: {
      id: expect.any(String),
      timezone: "UTC",
      stats: { acceptedBars: 3 },
      datasetHash: expect.stringMatching(/^sha256:/),
    },
  });
  expect(app.cryptoBarRequests).toHaveLength(3);

  const repeated = await app.fetch(new Request("http://local/api/strategy/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(datasetRequest),
  }));
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toMatchObject({
    reused: true,
    dataset: { id: datasetId, datasetHash },
  });
  expect(app.cryptoBarRequests).toHaveLength(6);

  const detail = await app.fetch(new Request(`http://local/api/strategy/datasets/${datasetId}?includeBars=1`));
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ id: datasetId, bars: [{ symbol: "BTC/USD" }, { symbol: "BTC/USD" }, { symbol: "BTC/USD" }] });

  const backtestResponse = await app.fetch(new Request("http://local/api/strategy/backtests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ datasetId, strategyId: "buy-and-hold", params: {} }),
  }));
  expect(backtestResponse.status).toBe(201);
  const backtest = await backtestResponse.json() as any;
  expect(backtest.result.points).toHaveLength(3);
  expect(backtest).toMatchObject({
    datasetId,
    result: { strategyId: "buy-and-hold" },
    provenance: { datasetHash },
  });
  expect(app.cryptoBarRequests).toHaveLength(6);

  const walkForwardResponse = await app.fetch(new Request("http://local/api/strategy/backtests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      datasetId,
      strategyId: "time-sliced-accumulation",
      params: {},
      walkForward: {
        trainSize: 2,
        testSize: 1,
        candidates: [{ slices: 1 }, { slices: 3 }],
      },
    }),
  }));
  expect(walkForwardResponse.status).toBe(201);
  const walkForwardBacktest = await walkForwardResponse.json() as any;
  const walkForwardBacktestId = String(walkForwardBacktest.backtestId);
  expect(walkForwardBacktest).toMatchObject({
    datasetId,
    walkForwardEvaluation: {
      candidateCount: 2,
      aggregate: { foldCount: 1, testBars: 1 },
      leakageChecks: { allPassed: true },
      folds: [{
        train: { bars: 2 },
        test: { bars: 1 },
        selectedParams: { slices: expect.any(Number), maxExposure: 1 },
        testResult: { points: [{ timestamp: expect.any(String) }] },
      }],
    },
  });
  expect(app.cryptoBarRequests).toHaveLength(6);
  const persistedWalkForward = await app.fetch(new Request(
    `http://local/api/strategy/backtests/${walkForwardBacktestId}`,
  ));
  expect(persistedWalkForward.status).toBe(200);
  expect(await persistedWalkForward.json()).toMatchObject({
    id: walkForwardBacktestId,
    result: {
      walkForwardEvaluation: {
        aggregate: { foldCount: 1 },
        leakageChecks: { allPassed: true },
      },
    },
  });

  const runResponse = await app.fetch(new Request("http://local/api/strategy/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      datasetId,
      backtestId: backtest.backtestId,
      strategyId: "buy-and-hold",
      params: {},
    }),
  }));
  expect(runResponse.status).toBe(201);
  expect(await runResponse.json()).toMatchObject({
    backtestId: backtest.backtestId,
    config: { datasetId, days: 90 },
    provenance: { datasetHash },
  });
});

test("strategy dataset provider failures remain sanitized", async () => {
  const app = testApp({}, { cryptoBarsError: new Error("private dataset provider failure") });
  const response = await app.fetch(new Request("http://local/api/strategy/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      symbols: ["BTC/USD"],
      timeframe: "1Day",
      start: "2025-01-01T00:00:00.000Z",
      end: "2025-07-20T00:00:00.000Z",
    }),
  }));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "The broker service could not complete the request" });
});

test("strategy dataset API keeps versions actor-scoped", async () => {
  const app = testApp(productionEnv);
  const ingest = await app.fetch(new Request("https://broker.example.com/api/strategy/datasets", {
    method: "POST",
    headers: productionHeaders("operator", true),
    body: JSON.stringify({
      symbols: ["BTC/USD"],
      timeframe: "1Day",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-03T00:00:00.000Z",
    }),
  }));
  expect(ingest.status).toBe(201);
  const datasetId = String((await ingest.json() as any).dataset.id);
  const otherActor = await app.fetch(new Request(
    `https://broker.example.com/api/strategy/datasets/${datasetId}?includeBars=1`,
    { headers: productionHeaders("operator", false, "other@example.com") },
  ));
  expect(otherActor.status).toBe(404);
  expect(await otherActor.json()).toEqual({ error: "Strategy dataset not found" });
});

test("strategy dataset API creates correction lineage without rewriting history", async () => {
  let revision = 0;
  const app = testApp({}, {
    cryptoBars: (request) => ({
      "BTC/USD": [{
        t: new Date(request.start).toISOString(),
        o: 100 + revision,
        h: 102 + revision,
        l: 99 + revision,
        c: 101 + revision,
        v: 10,
      }],
    }),
  });
  const ingest = () => app.fetch(new Request("http://local/api/strategy/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      symbols: ["BTC/USD"],
      timeframe: "1Day",
      start: "2025-01-01T00:00:00.000Z",
      end: "2025-07-20T00:00:00.000Z",
    }),
  }));
  const initialResponse = await ingest();
  expect(initialResponse.status).toBe(201);
  const initial = await initialResponse.json() as any;
  const initialId = String(initial.dataset.id);
  const initialHash = String(initial.dataset.datasetHash);

  revision = 1;
  const correctedResponse = await ingest();
  expect(correctedResponse.status).toBe(201);
  const corrected = await correctedResponse.json() as any;
  expect(corrected.dataset).toMatchObject({
    previousDatasetId: initialId,
    stats: { addedBars: 0, correctedBars: 3, removedBars: 0 },
  });
  expect(corrected.dataset.datasetHash).not.toBe(initialHash);

  const originalResponse = await app.fetch(new Request(
    `http://local/api/strategy/datasets/${initialId}?includeBars=1`,
  ));
  expect(originalResponse.status).toBe(200);
  expect(await originalResponse.json()).toMatchObject({
    id: initialId,
    datasetHash: initialHash,
    bars: [{ close: 101 }, { close: 101 }, { close: 101 }],
  });
});

async function approvedPaperRun(app: ReturnType<typeof testApp>) {
  const definition = { symbols: ["BTC/USD"], strategyId: "buy-and-hold", timeframe: "1Hour", days: 30, params: {} };
  const backtestResponse = await app.fetch(new Request("http://local/api/strategy/backtests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(definition),
  }));
  expect(backtestResponse.status).toBe(201);
  const backtest = await backtestResponse.json() as any;
  const runResponse = await app.fetch(new Request("http://local/api/strategy/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...definition, backtestId: backtest.backtestId }),
  }));
  expect(runResponse.status).toBe(201);
  const run = await runResponse.json() as any;
  const approvalResponse = await app.fetch(new Request(`http://local/api/strategy/runs/${run.runId}/paper-approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget: 100, maxPositionNotional: 100, maxOrderNotional: 25, minOrderNotional: 5, maxSpreadBps: 200, expiresHours: 24, timeInForce: "gtc", maxDailyLossPercent: 5, maxDrawdownPercent: 10, maxDailyTurnoverPercent: 50, errorCooldownMinutes: 1 }),
  }));
  expect(approvalResponse.status).toBe(200);
  expect(await approvalResponse.json()).toMatchObject({ runId: run.runId, status: "paper", budget: 100 });
  return run;
}

test("strategy API persists a reviewed backtest and exact run and decision provenance", async () => {
  const app = testApp();
  const definition = { symbols: ["BTC/USD"], strategyId: "moving-average-trend", timeframe: "1Hour", days: 30, params: { fast: 2, slow: 3, exposure: 1 } };
  const backtestResponse = await app.fetch(new Request("http://local/api/strategy/backtests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(definition),
  }));
  expect(backtestResponse.status).toBe(201);
  const backtest = await backtestResponse.json() as any;
  const backtestId = String(backtest.backtestId);
  expect(backtest).toMatchObject({
    backtestId: expect.any(String),
    provenance: {
      gitCommit: codeIdentity.gitCommit,
      pluginVersion: "strategy-plugin-v1",
      featureSchemaVersion: "strategy-features-v1",
      policyVersion: "crypto-backtest-v1",
      datasetHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    },
  });

  expect(app.store.getStrategyBacktest(backtestId)).toMatchObject({ actor: "demo-advisor" });
  const persisted = await app.fetch(new Request(`http://local/api/strategy/backtests/${backtestId}`));
  expect(persisted.status).toBe(200);
  expect(await persisted.json()).toMatchObject({ id: backtestId, comparable: true, result: { result: { strategyId: definition.strategyId } } });

  const runResponse = await app.fetch(new Request("http://local/api/strategy/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...definition, backtestId }),
  }));
  expect(runResponse.status).toBe(201);
  const run = await runResponse.json() as any;
  expect(run).toMatchObject({ backtestId, comparable: true, strategyVersion: "strategy-plugin-v1", provenance: { datasetHash: backtest.provenance.datasetHash } });

  const tick = await app.fetch(new Request(`http://local/api/strategy/runs/${run.runId}/tick`, { method: "POST" }));
  expect(tick.status).toBe(200);
  expect(await tick.json()).toMatchObject({
    trace: {
      comparable: true,
      provenance: { gitCommit: codeIdentity.gitCommit, pluginVersion: "strategy-plugin-v1", datasetHash: expect.stringMatching(/^sha256:/) },
      snapshots: [expect.objectContaining({ datasetHash: expect.stringMatching(/^sha256:/) })],
    },
  });

  const mismatch = await app.fetch(new Request("http://local/api/strategy/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...definition, days: 31, backtestId }),
  }));
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toEqual({ error: "Strategy run code or configuration does not match the reviewed backtest" });
});

test("approved strategy paper tick submits one bounded broker order with trace and receipt", async () => {
  const app = testApp();
  const run = await approvedPaperRun(app);
  const response = await app.fetch(new Request(`http://local/api/strategy/runs/${run.runId}/tick`, { method: "POST" }));
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  const receiptId = String(result.receiptId);
  expect(result).toMatchObject({ runId: run.runId, trace: { decision: "enter", paperOrderId: expect.any(String), riskChecks: { submittedOrder: true, reasons: [], paper: { draftOrder: { side: "buy", notional: 25 }, orderError: null } } } });
  expect(app.orderAttempts).toEqual([expect.objectContaining({ symbol: "BTC/USD", side: "buy", notional: 25, timeInForce: "gtc", clientOrderId: expect.any(String) })]);
  expect(app.store.strategyOrders(run.runId)).toMatchObject([{ paperOrderId: result.trace.paperOrderId, status: "accepted", payload: { side: "buy", notional: 25 } }]);
  expect(app.store.getReceipt(receiptId)).toMatchObject({ kind: "strategy_paper_decision", runId: run.runId, submittedOrder: true, paperOrderId: result.trace.paperOrderId });
});

test("strategy paper tick records a stable block when broker submission fails", async () => {
  const app = testApp({}, { placementError: new Error("private strategy placement failure") });
  const run = await approvedPaperRun(app);
  const response = await app.fetch(new Request(`http://local/api/strategy/runs/${run.runId}/tick`, { method: "POST" }));
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  expect(result).toMatchObject({ runId: run.runId, trace: { decision: "block", paperOrderId: null, reason: "Paper order was blocked by broker response: Broker submission failed", riskChecks: { submittedOrder: false, reasons: ["broker_order_rejected"], paper: { orderError: "Broker submission failed" } } } });
  expect(JSON.stringify(result)).not.toContain("private strategy placement failure");
  expect(app.store.strategyOrders(run.runId)).toEqual([]);
  expect(app.orderAttempts).toHaveLength(1);
});

async function equityPreview(app: ReturnType<typeof testApp>, qty = 0.1) {
  const response = await app.fetch(new Request("http://local/api/orders/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: "SPY", side: "buy", qty }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

async function equityLimitPreview(app: ReturnType<typeof testApp>) {
  const response = await app.fetch(new Request("http://local/api/orders/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: "SPY", side: "buy", qty: 1, type: "limit", limitPrice: 100 }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

function equitySubmission(app: ReturnType<typeof testApp>, previewToken: string, idempotencyKey: string) {
  return app.fetch(new Request("http://local/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewToken, idempotencyKey }),
  }));
}

async function linkedPreview(app: ReturnType<typeof testApp>, ticket: Record<string, unknown>) {
  const response = await app.fetch(new Request("http://local/api/orders/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: "SPY", qty: 0.1, timeInForce: "day", ...ticket }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

async function basketPreview(app: ReturnType<typeof testApp>) {
  const response = await app.fetch(new Request("http://local/api/orders/basket/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ legs: [{ symbol: "SPY", side: "buy", qty: 0.1 }, { symbol: "QQQ", side: "buy", qty: 0.1 }], timeInForce: "day" }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

function basketSubmission(app: ReturnType<typeof testApp>, previewToken: string, idempotencyKey: string) {
  return app.fetch(new Request("http://local/api/orders/basket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewToken, idempotencyKey }),
  }));
}

async function cryptoPreview(app: ReturnType<typeof testApp>, notional = 25) {
  const response = await app.fetch(new Request("http://local/api/strategy/crypto/order-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: "BTC/USD", side: "buy", type: "market", amountType: "notional", notional, timeInForce: "gtc" }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

function cryptoSubmission(app: ReturnType<typeof testApp>, previewToken: string, idempotencyKey: string) {
  return app.fetch(new Request("http://local/api/strategy/crypto/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewToken, idempotencyKey }),
  }));
}

async function optionPreview(app: ReturnType<typeof testApp>, ticket: Record<string, unknown>) {
  const response = await app.fetch(new Request("http://local/api/options/orders/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ticket),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

function optionSubmission(app: ReturnType<typeof testApp>, previewToken: string, idempotencyKey: string) {
  return app.fetch(new Request("http://local/api/options/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewToken, idempotencyKey }),
  }));
}

async function optionActionPreview(app: ReturnType<typeof testApp>, action: "exercise" | "do_not_exercise") {
  const response = await app.fetch(new Request(`http://local/api/options/positions/${optionSymbols[0]}/action-preview?action=${action}`));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

function optionAction(app: ReturnType<typeof testApp>, previewToken: string) {
  return app.fetch(new Request(`http://local/api/options/positions/${optionSymbols[0]}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewToken }),
  }));
}

test("equity order API persists one idempotent reviewed submission and receipt", async () => {
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) });
  const preview = await equityPreview(app);
  const previewToken = String(preview.previewToken);
  expect(preview).toMatchObject({
    allowed: true,
    simulation: { allowed: true, estimatedNotional: 10 },
    operationalPolicy: { allowed: true },
    liquidity: { bid: 99.9, ask: 100.1 },
    order: { type: "market", qty: 0.1 },
    previewToken: expect.any(String),
  });

  const key = "api-order-idempotent";
  const response = await equitySubmission(app, previewToken, key);
  const order = await response.json() as any;
  const orderId = String(order.id);
  const receiptId = String(order.receiptId);
  expect(response.status).toBe(200);
  expect(order).toMatchObject({ id: expect.any(String), clientOrderId: key, symbol: "SPY", side: "buy", qty: 0.1, status: "accepted", receiptId: expect.any(String) });
  expect(app.orderAttempts).toEqual([expect.objectContaining({ symbol: "SPY", side: "buy", qty: 0.1, clientOrderId: key })]);
  expect(app.store.getReceipt(receiptId)).toMatchObject({ advisor: "demo-advisor", idempotencyKey: key, orderId, status: "accepted", preview: { qty: 0.1, price: 100 } });
  expect(app.store.activeRiskReservations()).toMatchObject([{ key, status: "submitted", orderId }]);

  const replay = await equitySubmission(app, previewToken, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(order);
  expect(app.orderAttempts).toHaveLength(1);
});

test("equity order API sanitizes broker failure, releases capacity, and permits retry", async () => {
  const options: FakeAlpacaOptions = { placementError: new Error("private placement failure") };
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, options);
  const preview = await equityPreview(app);
  const key = "api-order-retry";

  const failed = await equitySubmission(app, preview.previewToken, key);
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "The broker service could not complete the request" });
  expect(app.store.submission(key)).toBeNull();
  expect(app.store.activeRiskReservations()).toEqual([]);

  options.placementError = undefined;
  const retried = await equitySubmission(app, preview.previewToken, key);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ clientOrderId: key, status: "accepted" });
  expect(app.orderAttempts).toHaveLength(2);
});

test("linked order API submits exact bracket, OCO, and OTO payloads with durable receipts", async () => {
  const cases = [
    { label: "bracket", ticket: { side: "buy", orderClass: "bracket", takeProfitPrice: 110, stopLossPrice: 90 }, expected: { side: "buy", takeProfit: { limitPrice: 110 }, stopLoss: { stopPrice: 90 } } },
    { label: "oco", ticket: { side: "sell", orderClass: "oco", takeProfitPrice: 110, stopLossPrice: 90 }, positions: [{ symbol: "SPY", qty: "1", marketValue: "100" }], expected: { side: "sell", takeProfit: { limitPrice: 110 }, stopLoss: { stopPrice: 90 } } },
    { label: "oto-take-profit", ticket: { side: "buy", orderClass: "oto", takeProfitPrice: 110 }, expected: { side: "buy", takeProfit: { limitPrice: 110 } } },
    { label: "oto-stop-loss", ticket: { side: "buy", orderClass: "oto", stopLossPrice: 90 }, expected: { side: "buy", stopLoss: { stopPrice: 90 } } },
  ];

  for (const item of cases) {
    const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, { positions: item.positions });
    const preview = await linkedPreview(app, item.ticket);
    const previewToken = String(preview.previewToken);
    expect(preview).toMatchObject({ allowed: true, order: { orderClass: item.ticket.orderClass, qty: 0.1 }, operationalPolicy: { allowed: true } });

    const key = `linked-api-${item.label}`;
    const response = await equitySubmission(app, previewToken, key);
    expect(response.status).toBe(200);
    const order = await response.json() as any;
    const receiptId = String(order.receiptId);
    expect(order).toMatchObject({ clientOrderId: key, symbol: "SPY", side: item.ticket.side, qty: 0.1, orderClass: item.ticket.orderClass, status: "accepted" });
    expect(app.orderAttempts).toEqual([expect.objectContaining({ symbol: "SPY", qty: 0.1, clientOrderId: key, ...item.expected })]);
    expect(app.store.getReceipt(receiptId)).toMatchObject({ idempotencyKey: key, orderId: order.id, status: "accepted", preview: { orderClass: item.ticket.orderClass } });

    const replay = await equitySubmission(app, previewToken, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(order);
    expect(app.orderAttempts).toHaveLength(1);
  }
});

test("linked order API sanitizes broker failure, releases capacity, and permits retry", async () => {
  const options: FakeAlpacaOptions = { placementError: new Error("private linked placement failure") };
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, options);
  const preview = await linkedPreview(app, { side: "buy", orderClass: "bracket", takeProfitPrice: 110, stopLossPrice: 90 });
  const key = "linked-api-retry";

  const failed = await equitySubmission(app, preview.previewToken, key);
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "The broker service could not complete the request" });
  expect(app.store.submission(key)).toBeNull();
  expect(app.store.activeRiskReservations()).toEqual([]);

  options.placementError = undefined;
  const retried = await equitySubmission(app, preview.previewToken, key);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ clientOrderId: key, orderClass: "bracket", status: "accepted" });
  expect(app.orderAttempts).toHaveLength(2);
});

test("replacement API releases failed idempotency and replays one successful broker mutation", async () => {
  const options: FakeAlpacaOptions = { accountEquity: 10_000, placementStatus: "new", replacementError: new Error("private replacement failure") };
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, options);
  const original = await (await equitySubmission(app, (await equityLimitPreview(app)).previewToken, "replace-original")).json() as any;
  const previewResponse = await app.fetch(new Request(`http://local/api/orders/${original.id}/replacement-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ qty: 1, limitPrice: 99, stopPrice: null }),
  }));
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json() as any;
  const key = "replace-api-retry";
  const request = () => app.fetch(new Request(`http://local/api/orders/${original.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewToken: preview.previewToken, idempotencyKey: key }),
  }));

  const failed = await request();
  expect(failed.status).toBe(409);
  expect(await failed.json()).toEqual({ error: "Alpaca could not replace the order because its state changed. Refresh the blotter." });
  expect(app.store.submission(key)).toBeNull();

  options.replacementError = undefined;
  const retried = await request();
  expect(retried.status).toBe(200);
  const replaced = await retried.json() as any;
  expect(replaced).toMatchObject({ clientOrderId: key, qty: 1, limitPrice: 99, status: "new", replacedOrderId: original.id });
  expect(app.replacementAttempts).toEqual([
    expect.objectContaining({ orderId: original.id, patchOrderRequest: expect.objectContaining({ qty: "1", limitPrice: "99", clientOrderId: key }) }),
    expect.objectContaining({ orderId: original.id, patchOrderRequest: expect.objectContaining({ qty: "1", limitPrice: "99", clientOrderId: key }) }),
  ]);

  const replay = await request();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(replaced);
  expect(app.replacementAttempts).toHaveLength(2);
});

test("exact cancellation maps broker state changes to a stable conflict", async () => {
  const success = testApp({ PREVIEW_SECRET: "p".repeat(32) });
  const order = await (await equitySubmission(success, (await equityPreview(success)).previewToken, "cancel-exact")).json() as any;
  const canceled = await success.fetch(new Request(`http://local/api/orders/${order.id}`, { method: "DELETE" }));
  expect(canceled.status).toBe(202);
  expect(await canceled.json()).toMatchObject({ orderId: order.id, status: "cancel_requested" });
  expect(success.cancellationAttempts).toEqual([order.id]);

  const failure = testApp({ PREVIEW_SECRET: "p".repeat(32) }, { cancellationError: new Error("private cancellation failure") });
  const failedOrder = await (await equitySubmission(failure, (await equityPreview(failure)).previewToken, "cancel-conflict")).json() as any;
  const failed = await failure.fetch(new Request(`http://local/api/orders/${failedOrder.id}`, { method: "DELETE" }));
  expect(failed.status).toBe(409);
  expect(await failed.json()).toEqual({ error: "Alpaca could not accept the cancellation because the order state changed. Refresh the blotter." });
  expect(failure.cancellationAttempts).toEqual([failedOrder.id]);
});

test("cancel-all API binds and submits the exact reviewed working-order snapshot", async () => {
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) });
  const order = await (await equitySubmission(app, (await equityPreview(app)).previewToken, "cancel-all-order")).json() as any;
  const previewResponse = await app.fetch(new Request("http://local/api/orders/cancel-all-preview"));
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json() as any;
  const previewToken = String(preview.previewToken);
  expect(preview).toMatchObject({ orders: [{ id: order.id, status: "accepted" }], previewToken: expect.any(String) });

  const response = await app.fetch(new Request("http://local/api/orders", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewToken }),
  }));
  const result = await response.json();
  expect(result).toMatchObject({ results: [{ orderId: order.id, status: "cancel_requested" }] });
  expect(response.status).toBe(202);
  expect(app.cancellationAttempts).toEqual([order.id]);
});

test("concurrent equity submissions cannot stack beyond transactional risk capacity", async () => {
  let releasePlacement!: () => void;
  const placementGate = new Promise<void>(resolve => { releasePlacement = resolve; });
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, { placementGate });
  const preview = await equityPreview(app, 0.25);
  const accepted = Array.from({ length: 4 }, (_, index) => equitySubmission(app, preview.previewToken, `capacity-order-${index}`));
  for (let attempt = 0; attempt < 100 && app.orderAttempts.length < 4; attempt++) await Bun.sleep(1);
  expect(app.orderAttempts).toHaveLength(4);

  const blocked = await equitySubmission(app, preview.previewToken, "capacity-order-4");
  expect(blocked.status).toBe(422);
  expect(await blocked.json()).toMatchObject({ allowed: false, simulation: { allowed: false, reasons: ["Daily turnover exceeds 10% limit"] } });
  expect(app.store.submission("capacity-order-4")).toBeNull();

  releasePlacement();
  const responses = await Promise.all(accepted);
  expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200]);
  expect(app.orderAttempts).toHaveLength(4);
  expect(app.store.activeRiskReservations()).toHaveLength(4);
});

test("basket order API persists one idempotent multi-leg submission and receipt", async () => {
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) });
  const preview = await basketPreview(app);
  const previewToken = String(preview.previewToken);
  expect(preview).toMatchObject({
    allowed: true,
    simulation: { allowed: true, summary: { buyNotional: 20, netCashChange: -20 } },
    operationalPolicies: [{ allowed: true }, { allowed: true }],
    liquidity: [{ symbol: "SPY" }, { symbol: "QQQ" }],
  });

  const key = "basket-api-success";
  const response = await basketSubmission(app, previewToken, key);
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  const receiptId = String(result.receiptId);
  expect(result).toMatchObject({
    status: "submitted",
    results: [
      { symbol: "SPY", orderId: expect.any(String), status: "accepted" },
      { symbol: "QQQ", orderId: expect.any(String), status: "accepted" },
    ],
  });
  expect(app.orderAttempts).toEqual([
    expect.objectContaining({ symbol: "SPY", clientOrderId: `${key}-0` }),
    expect.objectContaining({ symbol: "QQQ", clientOrderId: `${key}-1` }),
  ]);
  expect(app.store.getReceipt(receiptId)).toMatchObject({ advisor: "demo-advisor", kind: "rebalance_basket", idempotencyKey: key, status: "submitted", orderIds: result.results.map((item: any) => item.orderId) });
  expect(app.store.activeRiskReservations()).toMatchObject([{ key: `${key}:0`, status: "submitted" }, { key: `${key}:1`, status: "submitted" }]);

  const replay = await basketSubmission(app, previewToken, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  expect(app.orderAttempts).toHaveLength(2);
});

test("basket order API preserves partial status and hides broker failure details", async () => {
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, { placementErrorAt: 1 });
  const preview = await basketPreview(app);
  const key = "basket-api-partial";
  const response = await basketSubmission(app, preview.previewToken, key);
  expect(response.status).toBe(207);
  const result = await response.json() as any;
  const receiptId = String(result.receiptId);
  expect(result).toMatchObject({
    status: "partial",
    results: [
      { symbol: "SPY", orderId: expect.any(String), status: "accepted" },
      { symbol: "QQQ", orderId: null, status: "not_submitted", error: "Broker submission failed" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("private basket placement failure");
  expect(app.store.getReceipt(receiptId)).toMatchObject({ kind: "rebalance_basket", status: "partial", orderIds: [result.results[0].orderId] });
  expect(app.store.activeRiskReservations()).toMatchObject([{ key: `${key}:0`, status: "submitted" }]);

  const replay = await basketSubmission(app, preview.previewToken, key);
  expect(replay.status).toBe(207);
  expect(await replay.json()).toEqual(result);
  expect(app.orderAttempts).toHaveLength(2);
});

test("order recovery reconciles receipts and terminal risk reservations by broker order id", async () => {
  const options: FakeAlpacaOptions = {};
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, options);
  const equityOrder = await (await equitySubmission(app, (await equityPreview(app)).previewToken, "reconcile-equity")).json() as any;
  const basketResult = await (await basketSubmission(app, (await basketPreview(app)).previewToken, "reconcile-basket")).json() as any;
  expect(app.store.activeRiskReservations()).toHaveLength(3);

  options.recoveredOrderStatus = "filled";
  const recovered = await app.fetch(new Request("http://local/api/orders"));
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ orders: [{ status: "filled" }, { status: "filled" }, { status: "filled" }] });
  expect(app.store.getReceipt(equityOrder.receiptId)).toMatchObject({ orderId: equityOrder.id, status: "filled", updatedAt: expect.any(String) });
  expect(app.store.getReceipt(basketResult.receiptId)).toMatchObject({ results: [{ status: "filled" }, { status: "filled" }], updatedAt: expect.any(String) });
  expect(app.store.activeRiskReservations()).toEqual([]);
});

test("order recovery sanitizes provider failure and succeeds on retry", async () => {
  const options: FakeAlpacaOptions = {};
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, options);
  const order = await (await equitySubmission(app, (await equityPreview(app)).previewToken, "reconcile-retry")).json() as any;
  options.recoveryError = new Error("private recovery failure");

  const failed = await app.fetch(new Request("http://local/api/orders"));
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "The broker service could not complete the request" });
  expect(app.store.getReceipt(order.receiptId)).toMatchObject({ status: "accepted" });
  expect(app.store.activeRiskReservations()).toHaveLength(1);

  options.recoveryError = undefined;
  options.recoveredOrderStatus = "filled";
  const retried = await app.fetch(new Request("http://local/api/orders"));
  expect(retried.status).toBe(200);
  expect(app.store.getReceipt(order.receiptId)).toMatchObject({ status: "filled" });
  expect(app.store.activeRiskReservations()).toEqual([]);
});

test("crypto order API persists one idempotent reviewed notional submission and receipt", async () => {
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) });
  const preview = await cryptoPreview(app);
  const previewToken = String(preview.previewToken);
  expect(preview).toMatchObject({
    allowed: true,
    preview: { symbol: "BTC/USD", side: "buy", type: "market", amountType: "notional", notional: 25, estimatedNotional: 25 },
    operationalPolicy: { allowed: true },
    market: { bid: 101, ask: 102 },
  });

  const key = "crypto-api-success";
  const response = await cryptoSubmission(app, previewToken, key);
  expect(response.status).toBe(200);
  const order = await response.json() as any;
  const orderId = String(order.id);
  const receiptId = String(order.receiptId);
  expect(order).toMatchObject({ id: expect.any(String), clientOrderId: key, symbol: "BTC/USD", side: "buy", qty: null, notional: 25, status: "accepted", receiptId: expect.any(String) });
  expect(app.orderAttempts).toEqual([expect.objectContaining({ symbol: "BTC/USD", side: "buy", notional: 25, clientOrderId: key })]);
  expect(app.store.getReceipt(receiptId)).toMatchObject({ advisor: "demo-advisor", kind: "crypto_order", idempotencyKey: key, orderId, status: "accepted", preview: { estimatedNotional: 25, operationalPolicy: { allowed: true } } });
  expect(app.store.activeRiskReservations()).toMatchObject([{ key, symbol: "BTC/USD", status: "submitted", orderId }]);

  const replay = await cryptoSubmission(app, previewToken, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(order);
  expect(app.orderAttempts).toHaveLength(1);
});

test("crypto order API sanitizes broker failure, releases capacity, and permits retry", async () => {
  const options: FakeAlpacaOptions = { placementError: new Error("private crypto placement failure") };
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, options);
  const preview = await cryptoPreview(app);
  const key = "crypto-api-retry";

  const failed = await cryptoSubmission(app, preview.previewToken, key);
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "The broker service could not complete the request" });
  expect(app.store.submission(key)).toBeNull();
  expect(app.store.activeRiskReservations()).toEqual([]);

  options.placementError = undefined;
  const retried = await cryptoSubmission(app, preview.previewToken, key);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ clientOrderId: key, notional: 25, status: "accepted" });
  expect(app.orderAttempts).toHaveLength(2);
});

test("concurrent crypto submissions cannot stack beyond transactional turnover capacity", async () => {
  let releasePlacement!: () => void;
  const placementGate = new Promise<void>(resolve => { releasePlacement = resolve; });
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, { placementGate });
  const preview = await cryptoPreview(app);
  const accepted = Array.from({ length: 4 }, (_, index) => cryptoSubmission(app, preview.previewToken, `crypto-capacity-${index}`));
  for (let attempt = 0; attempt < 100 && app.orderAttempts.length < 4; attempt++) await Bun.sleep(1);
  expect(app.orderAttempts).toHaveLength(4);

  const blocked = await cryptoSubmission(app, preview.previewToken, "crypto-capacity-4");
  expect(blocked.status).toBe(422);
  expect(await blocked.json()).toMatchObject({ allowed: false, reasons: ["max_daily_turnover"], operationalPolicy: { allowed: false, reasons: ["max_daily_turnover"] } });
  expect(app.store.submission("crypto-capacity-4")).toBeNull();

  releasePlacement();
  const responses = await Promise.all(accepted);
  expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200]);
  expect(app.orderAttempts).toHaveLength(4);
  expect(app.store.activeRiskReservations()).toHaveLength(4);
});

test("option order API submits long single and debit vertical orders with durable receipts", async () => {
  const cases = [
    {
      label: "single",
      ticket: { kind: "single", legs: [{ symbol: optionSymbols[0], side: "buy", positionIntent: "buy_to_open" }], qty: 1, type: "market", limitPrice: null },
      expectedAttempt: { symbol: optionSymbols[0], side: "buy", qty: 1, positionIntent: "buy_to_open" },
      expectedOrder: { symbol: optionSymbols[0], orderClass: "simple", type: "market" },
    },
    {
      label: "vertical",
      ticket: { kind: "vertical", legs: [{ symbol: optionSymbols[0], side: "buy", positionIntent: "buy_to_open" }, { symbol: optionSymbols[1], side: "sell", positionIntent: "sell_to_open" }], qty: 1, type: "limit", limitPrice: 0.2 },
      expectedAttempt: { type: "limit", orderClass: "mleg", qty: 1, limitPrice: 0.2, legs: [{ symbol: optionSymbols[0], side: "buy", positionIntent: "buy_to_open", ratioQty: "1" }, { symbol: optionSymbols[1], side: "sell", positionIntent: "sell_to_open", ratioQty: "1" }] },
      expectedOrder: { symbol: "AAPL_OPTION_VERTICAL", orderClass: "mleg", type: "limit" },
    },
  ];

  for (const item of cases) {
    const app = testApp({ PREVIEW_SECRET: "p".repeat(32) });
    const preview = await optionPreview(app, item.ticket);
    const previewToken = String(preview.previewToken);
    expect(preview).toMatchObject({ allowed: true, preview: { kind: item.label, qty: 1, maxLoss: 20 }, operationalPolicy: { allowed: true } });

    const key = `option-api-${item.label}`;
    const response = await optionSubmission(app, previewToken, key);
    expect(response.status).toBe(200);
    const order = await response.json() as any;
    const receiptId = String(order.receiptId);
    expect(order).toMatchObject({ clientOrderId: key, qty: 1, status: "accepted", ...item.expectedOrder });
    expect(app.orderAttempts).toEqual([expect.objectContaining({ clientOrderId: key, ...item.expectedAttempt })]);
    expect(app.store.getReceipt(receiptId)).toMatchObject({ kind: "option_order", idempotencyKey: key, orderId: order.id, status: "accepted", preview: { kind: item.label, maxLoss: 20, risk: { portfolioReservedRisk: 20 }, operationalPolicy: { allowed: true } } });
    expect(app.store.activeRiskReservations()).toMatchObject([{ key, symbol: "OPTIONS_RISK", status: "submitted", orderId: order.id }]);

    const replay = await optionSubmission(app, previewToken, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(order);
    expect(app.orderAttempts).toHaveLength(1);
  }
});

test("option order API sanitizes broker failure, releases capacity, and permits retry", async () => {
  const options: FakeAlpacaOptions = { placementError: new Error("private option placement failure") };
  const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, options);
  const preview = await optionPreview(app, { kind: "single", legs: [{ symbol: optionSymbols[0], side: "buy", positionIntent: "buy_to_open" }], qty: 1, type: "market", limitPrice: null });
  const key = "option-api-retry";

  const failed = await optionSubmission(app, preview.previewToken, key);
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "The broker service could not complete the request" });
  expect(app.store.submission(key)).toBeNull();
  expect(app.store.activeRiskReservations()).toEqual([]);

  options.placementError = undefined;
  const retried = await optionSubmission(app, preview.previewToken, key);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ clientOrderId: key, symbol: optionSymbols[0], status: "accepted" });
  expect(app.orderAttempts).toHaveLength(2);
});

test("option position API binds exact exercise and do-not-exercise instructions", async () => {
  for (const action of ["exercise", "do_not_exercise"] as const) {
    const app = testApp({ PREVIEW_SECRET: "p".repeat(32) }, { positions: [{ symbol: optionSymbols[0], qty: "2" }] });
    const preview = await optionActionPreview(app, action);
    const previewToken = String(preview.previewToken);
    expect(preview).toMatchObject({ preview: { symbol: optionSymbols[0], action, qty: 2, strike: 100, multiplier: 100, exerciseCost: 20_000 }, previewToken: expect.any(String) });

    const response = await optionAction(app, previewToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, action, symbol: optionSymbols[0], qty: 2 });
    expect(app.optionActionAttempts).toEqual([{ action, symbol: optionSymbols[0] }]);
  }
});

test("option position API blocks quantity drift and sanitizes provider failure before retry", async () => {
  const positions = [{ symbol: optionSymbols[0], qty: "1" }];
  const drift = testApp({ PREVIEW_SECRET: "p".repeat(32) }, { positions });
  const driftPreview = await optionActionPreview(drift, "exercise");
  positions[0]!.qty = "2";
  const blocked = await optionAction(drift, driftPreview.previewToken);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({ error: "Option position quantity changed after preview" });
  expect(drift.optionActionAttempts).toEqual([]);

  const options: FakeAlpacaOptions = { positions: [{ symbol: optionSymbols[0], qty: "1" }], optionActionError: new Error("private option action failure") };
  const retry = testApp({ PREVIEW_SECRET: "p".repeat(32) }, options);
  const retryPreview = await optionActionPreview(retry, "do_not_exercise");
  const failed = await optionAction(retry, retryPreview.previewToken);
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "The broker service could not complete the request" });

  options.optionActionError = undefined;
  const retried = await optionAction(retry, retryPreview.previewToken);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ accepted: true, action: "do_not_exercise" });
  expect(retry.optionActionAttempts).toHaveLength(2);
});

test("unexpected provider errors map to a stable response without leaking details", async () => {
  const app = testApp({}, { accountError: new Error("private provider failure") });
  const response = await app.fetch(new Request("http://local/api/account"));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "The broker service could not complete the request" });
});
