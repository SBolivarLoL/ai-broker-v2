import { afterEach, expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createApp } from "./app";
import { createStore } from "./store";

const codeIdentity = { gitCommit: "a".repeat(40), workingTreeDirty: false };
const stores: ReturnType<typeof createStore>[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

type FakeAlpacaOptions = {
  accountError?: Error;
  placementError?: Error;
  placementErrorAt?: number;
  placementGate?: Promise<void>;
};

function fakeAlpaca(options: FakeAlpacaOptions = {}) {
  let stockConnects = 0;
  const orderAttempts: any[] = [];
  const acceptedOrders = new Map<string, any>();
  const stockStream = {
    onStateChange() {}, onConnect() {}, onDisconnect() {}, onError() {}, onQuote() {}, onBar() {},
    subscribeForQuotes() {}, subscribeForBars() {}, unsubscribeFromQuotes() {}, unsubscribeFromBars() {},
    connect() { stockConnects++; },
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
      getCryptoBars: async () => ({
        "BTC/USD": [
          { t: "2026-01-01T00:00:00.000Z", o: 100, h: 102, l: 99, c: 101, v: 10 },
          { t: "2026-01-01T01:00:00.000Z", o: 101, h: 103, l: 100, c: 102, v: 12 },
        ],
      }),
      crypto: {
        cryptoSnapshots: async () => {
          const timestamp = new Date().toISOString();
          return { snapshots: { "BTC/USD": { latestQuote: { bp: 101, bs: 2, ap: 102, as: 2, t: timestamp }, latestTrade: { p: 101.5, s: 1, t: timestamp }, latestBar: { o: 100, h: 103, l: 99, c: 101.5, v: 20, t: timestamp } } } };
        },
        cryptoLatestOrderbooks: async () => ({ orderbooks: { "BTC/USD": { a: [{ p: 102, s: 2 }], b: [{ p: 101, s: 2 }] } } }),
      },
    },
    trading: {
      account: { getAccount: async () => { if (options.accountError) throw options.accountError; return { equity: 1_000, cash: 1_000, buyingPower: 1_000, currency: "USD", status: "ACTIVE" }; } },
      positions: { getAllOpenPositions: async () => [] },
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
        getAllOrders: async () => [],
        market: async (input: any) => {
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
            type: "market",
            orderClass: "simple",
            timeInForce: input.timeInForce,
            status: "accepted",
            limitPrice: null,
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
        },
        getOrderByClientOrderId: async ({ clientOrderId }: any) => {
          const order = acceptedOrders.get(clientOrderId);
          if (!order) throw new Error("Order not found");
          return order;
        },
      },
    },
  } as unknown as Alpaca;
  return { alpaca, stockConnects: () => stockConnects, orderAttempts };
}

function testApp(env: Record<string, string | undefined> = {}, options: FakeAlpacaOptions = {}) {
  const store = createStore(":memory:");
  stores.push(store);
  const fake = fakeAlpaca(options);
  return { ...createApp({ alpaca: fake.alpaca, store, codeIdentity, env }), store, stockConnects: fake.stockConnects, orderAttempts: fake.orderAttempts };
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

function productionHeaders(role: string, mutation = false) {
  return {
    "x-auth-proxy-secret": productionEnv.AUTH_PROXY_SECRET,
    "x-auth-request-email": "advisor@example.com",
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

  const run = await app.fetch(new Request("http://local/api/strategy/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols: ["BTC/USD"], strategyId: "cash", timeframe: "1Hour", days: 30, params: { exposure: 1 } }),
  }));
  expect(run.status).toBe(400);
  expect(await run.json()).toEqual({ error: "Invalid cash parameters: Unrecognized key: \"exposure\"" });
});

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

async function equityPreview(app: ReturnType<typeof testApp>, qty = 0.1) {
  const response = await app.fetch(new Request("http://local/api/orders/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: "SPY", side: "buy", qty }),
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

test("unexpected provider errors map to a stable response without leaking details", async () => {
  const app = testApp({}, { accountError: new Error("private provider failure") });
  const response = await app.fetch(new Request("http://local/api/account"));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "The broker service could not complete the request" });
});
