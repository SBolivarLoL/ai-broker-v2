import { expect, test } from "bun:test";
import { handleOperationsRequest } from "../../backend/features/operations/routes";
import { createStore } from "../../backend/persistence/store";

const route = async (
  store: ReturnType<typeof createStore>,
  path: string,
  init?: RequestInit,
  runReconciliation?: any,
  runRetention?: any,
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
    runReconciliation,
    runRetention,
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

test("operations reconciliation route reports evidence and owns manual runs", async () => {
  const store = createStore(":memory:");
  const unavailable = await route(store, "/api/operations/reconciliation", {
    method: "POST",
  });
  expect(unavailable?.status).toBe(503);

  const completed = {
    schemaVersion: "scheduled-reconciliation-v1" as const,
    runId: "run-1",
    trigger: "manual" as const,
    actor: "test-admin",
    startedAt: "2026-07-12T14:00:00.000Z",
    completedAt: "2026-07-12T14:00:01.000Z",
    status: "healthy" as const,
    scope: { marketSymbols: [], omittedMarketSymbols: 0, listedOrders: 0, detailedOrders: 0, omittedDetailedOrders: 0 },
    checks: { marketBars: "skipped" as const, account: "passed" as const, orders: "skipped" as const },
    discrepancies: [],
    summary: { discrepancyCount: 0, recoveredCount: 0, unresolvedCount: 0, warningCount: 0, errorCount: 0 },
  };
  const manual = await route(
    store,
    "/api/operations/reconciliation",
    { method: "POST" },
    async (trigger: string, actor: string) => ({ ...completed, trigger, actor }),
  );
  expect(manual?.status).toBe(200);
  expect(await manual?.json()).toMatchObject({
    runId: "run-1",
    trigger: "manual",
    actor: "test-admin",
  });

  store.event("operations.reconciliation.completed", "test-admin", completed);
  const report = await route(store, "/api/operations/reconciliation");
  expect(report?.status).toBe(200);
  expect(await report?.json()).toMatchObject({
    reportVersion: "reconciliation-report-v1",
    latest: { runId: "run-1", status: "healthy" },
    evidence: { completedRuns: 1 },
  });
});

test("operations retention route previews policy and owns manual pruning", async () => {
  const store = createStore(":memory:");
  const preview = await route(store, "/api/operations/retention");
  expect(preview?.status).toBe(200);
  expect(await preview?.json()).toMatchObject({
    reportVersion: "retention-report-v1",
    policy: {
      policyVersion: "retention-policy-v1",
      strategySnapshotDays: 30,
      providerEvidenceDays: 365,
    },
    inventory: {
      strategySnapshots: { total: 0, eligibleForDeletion: 0 },
      providerEvidence: { totalResearchRuns: 0, eligibleResearchRuns: 0 },
    },
    latest: null,
  });

  const unavailable = await route(store, "/api/operations/retention", {
    method: "POST",
  });
  expect(unavailable?.status).toBe(503);

  const manual = await route(
    store,
    "/api/operations/retention",
    { method: "POST" },
    undefined,
    async (trigger: string, actor: string) => ({
      schemaVersion: "retention-run-v1",
      runId: "retention-1",
      trigger,
      actor,
      deleted: { strategySnapshots: 0 },
    }),
  );
  expect(manual?.status).toBe(200);
  expect(await manual?.json()).toMatchObject({
    schemaVersion: "retention-run-v1",
    runId: "retention-1",
    trigger: "manual",
    actor: "test-admin",
  });
  store.close();
});
