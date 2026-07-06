import { expect, test } from "bun:test";
import { handleOperationsRequest } from "../../backend/features/operations/routes";
import { createStore } from "../../backend/persistence/store";

const route = async (
  store: ReturnType<typeof createStore>,
  path: string,
  init?: RequestInit,
) => {
  const request = new Request(`http://localhost${path}`, init);
  return handleOperationsRequest(request, new URL(request.url), {
    store,
    actor: "test-admin",
    allow: () => true,
    env: {
      SECRET_VAULT_KEY: "a".repeat(32),
      SEC_USER_AGENT: "AI Broker test@example.com",
    },
  });
};

test("operations routes own policy and kill-switch lifecycle", async () => {
  const store = createStore(":memory:");
  expect(await route(store, "/api/account")).toBeNull();

  const missingReason = await route(store, "/api/operations/kill-switch", {
    method: "POST",
    body: JSON.stringify({ active: true }),
  });
  expect(missingReason?.status).toBe(400);

  const activated = await route(store, "/api/operations/kill-switch", {
    method: "POST",
    body: JSON.stringify({ active: true, reason: "test drill" }),
  });
  expect(activated?.status).toBe(200);
  expect((await activated?.json()).policy.globalKillSwitch).toMatchObject({
    active: true,
    reason: "test drill",
    activatedBy: "test-admin",
  });
  expect(store.operationsPolicy().globalKillSwitch.active).toBe(true);
});

test("operations secret routes never return plaintext", async () => {
  const store = createStore(":memory:");
  const created = await route(store, "/api/operations/secrets", {
    method: "POST",
    body: JSON.stringify({ name: "finnhub_api_key", value: "private-value" }),
  });
  expect(created?.status).toBe(200);
  expect(JSON.stringify(await created?.json())).not.toContain("private-value");

  const listed = await route(store, "/api/operations/secrets");
  expect(await listed?.json()).toMatchObject({
    secrets: [expect.objectContaining({ name: "finnhub_api_key" })],
  });
});

test("operations data-quality route exposes provider health evidence", async () => {
  const store = createStore(":memory:");
  store.event("strategy.dataset.ingested", "test-admin", {
    datasetId: "dataset-1",
  });
  store.event("strategy.crypto.order.preview", "test-admin", {
    warning: "provider rate limit 429",
  });

  const response = await route(store, "/api/operations/data-quality");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    reportVersion: "data-quality-v1",
    providers: expect.arrayContaining([
      expect.objectContaining({
        sourceId: "alpaca_crypto_data",
        status: "throttled",
        throttlingEvents: 1,
      }),
    ]),
    summary: {
      providerCount: expect.any(Number),
      degradedProviders: expect.any(Number),
      datasetCount: 0,
    },
  });
});
