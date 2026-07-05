import { afterEach, expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createApp } from "./app";
import { createStore } from "./store";

const codeIdentity = { gitCommit: "a".repeat(40), workingTreeDirty: false };
const stores: ReturnType<typeof createStore>[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function fakeAlpaca(accountError?: Error) {
  let stockConnects = 0;
  const stockStream = {
    onStateChange() {}, onConnect() {}, onDisconnect() {}, onError() {}, onQuote() {}, onBar() {},
    subscribeForQuotes() {}, subscribeForBars() {}, unsubscribeFromQuotes() {}, unsubscribeFromBars() {},
    connect() { stockConnects++; },
  };
  const alpaca = {
    marketData: {
      stockStream: () => stockStream,
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
      account: { getAccount: async () => { if (accountError) throw accountError; return { equity: 1_000, cash: 1_000, buyingPower: 1_000, currency: "USD", status: "ACTIVE" }; } },
      positions: { getAllOpenPositions: async () => [] },
      orders: { getAllOrders: async () => [] },
    },
  } as unknown as Alpaca;
  return { alpaca, stockConnects: () => stockConnects };
}

function testApp(env: Record<string, string | undefined> = {}, accountError?: Error) {
  const store = createStore(":memory:");
  stores.push(store);
  const fake = fakeAlpaca(accountError);
  return { ...createApp({ alpaca: fake.alpaca, store, codeIdentity, env }), store, stockConnects: fake.stockConnects };
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

test("unexpected provider errors map to a stable response without leaking details", async () => {
  const app = testApp({}, new Error("private provider failure"));
  const response = await app.fetch(new Request("http://local/api/account"));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "The broker service could not complete the request" });
});
