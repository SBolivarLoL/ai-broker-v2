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

  const policy = await route(store, "/api/operations/policy");
  const policyBody = await policy?.json();
  expect(policyBody).toMatchObject({
    retrievedAt: null,
    time: { retrievalTime: null },
  });
  expect(typeof policyBody.serverRespondedAt).toBe("string");
  expect(policyBody.asOf).toBe(policyBody.serverRespondedAt);
  expect(policyBody.time.serverResponseTime).toBe(policyBody.serverRespondedAt);

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

test("closed-beta review routes append evidence resolve incidents and export a packet", async () => {
  const store = createStore(":memory:");
  const initial = await route(store, "/api/operations/closed-beta-review");
  expect(initial?.status).toBe(200);
  expect(await initial?.json()).toMatchObject({
    packetVersion: "closed-beta-review-packet-v1",
    status: "needs_evidence",
    scope: { executionMode: "paper_only", externallyApproved: false },
    summary: {
      totalTargets: 8,
      targetsMissingSupportingRecords: expect.any(Array),
      missingDrills: [
        "backup_export",
        "restore",
        "kill_switch",
        "incident_response",
      ],
    },
  });

  const supporting = await route(
    store,
    "/api/operations/closed-beta-review/records",
    {
      method: "POST",
      body: JSON.stringify({
        kind: "supporting_record",
        targetId: "paper_only_execution",
        title: "Paper client configuration",
        reference: "local://paper-client/1",
        occurredAt: "2026-07-12T09:00:00.000Z",
        note: "Reviewed paper-only construction.",
      }),
    },
  );
  expect(supporting?.status).toBe(201);
  expect(await supporting?.json()).toMatchObject({
    record: {
      kind: "supporting_record",
      targetId: "paper_only_execution",
      auditEntryHash: expect.stringMatching(/^sha256:/),
    },
  });

  for (const drillType of [
    "backup_export",
    "restore",
    "kill_switch",
    "incident_response",
  ]) {
    const response = await route(
      store,
      "/api/operations/closed-beta-review/records",
      {
        method: "POST",
        body: JSON.stringify({
          kind: "drill",
          drillType,
          outcome: "pass",
          title: `${drillType} drill`,
          reference: `local://drill/${drillType}`,
          occurredAt: "2026-07-12T10:00:00.000Z",
        }),
      },
    );
    expect(response?.status).toBe(201);
  }

  const betaWindow = await route(
    store,
    "/api/operations/closed-beta-review/records",
    {
      method: "POST",
      body: JSON.stringify({
        kind: "beta_window",
        title: "Paper beta window",
        reference: "local://beta/window-1",
        startedAt: "2026-06-10T09:00:00.000Z",
        endedAt: "2026-07-12T12:00:00.000Z",
        participantCount: 3,
      }),
    },
  );
  expect(betaWindow?.status).toBe(201);
  expect(await betaWindow?.json()).toMatchObject({
    record: { kind: "beta_window", participantCount: 3 },
  });

  const incidentResponse = await route(
    store,
    "/api/operations/closed-beta-review/records",
    {
      method: "POST",
      body: JSON.stringify({
        kind: "incident",
        severity: "high",
        title: "Reconciliation discrepancy",
        reference: "local://incident/1",
        occurredAt: "2026-07-12T11:00:00.000Z",
      }),
    },
  );
  expect(incidentResponse?.status).toBe(201);
  const incidentBody = (await incidentResponse?.json()) as any;
  const incidentRecordId = String(incidentBody.record.recordId);

  const openReview = await route(
    store,
    "/api/operations/closed-beta-review",
  );
  expect(await openReview?.json()).toMatchObject({
    summary: {
      unresolvedIncidentCount: 1,
      unresolvedCriticalHighCount: 1,
      missingDrills: [],
      completedBetaWindow: true,
    },
    incidents: {
      unresolved: [{ recordId: incidentRecordId, severity: "high" }],
    },
    measuredEvidence: {
      targets: expect.arrayContaining([
        expect.objectContaining({ id: "operations_drills", status: "pass" }),
      ]),
    },
  });

  const missingIncident = await route(
    store,
    "/api/operations/closed-beta-review/incidents/missing-incident/resolve",
    {
      method: "POST",
      body: JSON.stringify({
        resolution: "Not found",
        resolvedAt: "2026-07-12T12:00:00.000Z",
      }),
    },
  );
  expect(missingIncident?.status).toBe(404);

  const earlyResolution = await route(
    store,
    `/api/operations/closed-beta-review/incidents/${incidentRecordId}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({
        resolution: "Too early",
        resolvedAt: "2026-07-12T10:59:00.000Z",
      }),
    },
  );
  expect(earlyResolution?.status).toBe(400);

  const resolved = await route(
    store,
    `/api/operations/closed-beta-review/incidents/${incidentRecordId}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({
        resolution: "Reconciled broker and local order evidence.",
        resolvedAt: "2026-07-12T12:00:00.000Z",
      }),
    },
  );
  expect(resolved?.status).toBe(200);
  expect(await resolved?.json()).toMatchObject({
    resolution: {
      incidentRecordId,
      auditEntryHash: expect.stringMatching(/^sha256:/),
    },
    workflowSummary: { unresolvedCriticalHighCount: 0 },
  });
  const duplicateResolution = await route(
    store,
    `/api/operations/closed-beta-review/incidents/${incidentRecordId}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({
        resolution: "Duplicate",
        resolvedAt: "2026-07-12T12:30:00.000Z",
      }),
    },
  );
  expect(duplicateResolution?.status).toBe(409);

  const packet = await route(
    store,
    "/api/operations/closed-beta-review/packet",
  );
  expect(packet?.status).toBe(200);
  expect(packet?.headers.get("content-disposition")).toContain(
    "closed-beta-review-",
  );
  expect(await packet?.json()).toMatchObject({
    incidents: {
      records: [{ recordId: incidentRecordId, status: "resolved" }],
    },
  });
  expect(store.verifyDecisionAuditTrail()).toMatchObject({ valid: true });
  store.close();
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
