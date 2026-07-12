import {
  ClientError,
  json,
  requestJson,
  securityHeaders,
} from "../../http/http";
import { secUserAgentFromEnv } from "../../integrations/sec-edgar";
import type { createStore } from "../../persistence/store";
import { localResponseTimeFields } from "../../shared/time-provenance";
import { buildDataGovernanceReport, DATA_GOVERNANCE_SOURCES } from "./data-governance";
import { buildDataQualityReport } from "./data-quality";
import {
  buildClosedBetaReviewPacket,
  closedBetaRecordEvent,
  CLOSED_BETA_RECORD_EVENT_TYPES,
  parseClosedBetaRecordInput,
  parseClosedBetaResolutionInput,
} from "./closed-beta-workflow";
import {
  buildClosedBetaEvidenceReport,
  buildProductionGovernanceReport,
} from "./production-governance";
import {
  reconciliationReport,
  type ReconciliationRun,
} from "./reconciliation";
import {
  retentionPolicyFromEnv,
  retentionReport,
  type RetentionRun,
} from "./retention";
import {
  decryptSecretValue,
  encryptSecretValue,
  SecretName,
} from "./secret-vault";

type Env = Record<string, string | undefined>;
type Store = ReturnType<typeof createStore>;
type RateLimit = (key: string, maximum: number) => boolean;

type OperationsContext = {
  store: Store;
  actor: string;
  allow: RateLimit;
  env?: Env;
  runReconciliation?: (
    trigger: "manual",
    actor: string,
  ) => Promise<ReconciliationRun>;
  runRetention?: (trigger: "manual", actor: string) => Promise<RetentionRun>;
};

export function secIdentityConfigured(env: Env = process.env) {
  try {
    secUserAgentFromEnv(env);
    return true;
  } catch {
    return false;
  }
}

function vaultKey(env: Env) {
  const key = env.SECRET_VAULT_KEY ?? "";
  if (key.length < 32)
    throw new ClientError("Secret vault key is not configured", 503);
  return key;
}

function secretNameInput(value: unknown) {
  try {
    return SecretName.parse(value);
  } catch {
    throw new ClientError("Valid secret name is required", 400);
  }
}

function closedBetaWorkflowEvents(store: Store) {
  return CLOSED_BETA_RECORD_EVENT_TYPES.flatMap((type) =>
    store.events(1_000, type),
  )
    .toSorted((left, right) => right.id - left.id)
    .slice(0, 1_000);
}

function closedBetaEvidence(
  store: Store,
  workflowEvents = closedBetaWorkflowEvents(store),
) {
  const runs = store.strategyRuns(100);
  const strategyRuns = runs.map((run) => {
    const config =
      run.config &&
      typeof run.config === "object" &&
      !Array.isArray(run.config)
        ? (run.config as Record<string, unknown>)
        : {};
    return {
      id: run.id,
      status: run.status,
      config,
      reviewCount: Array.isArray(config.reviewHistory)
        ? config.reviewHistory.length
        : 0,
      reviewTimes: Array.isArray(config.reviewHistory)
        ? config.reviewHistory.flatMap((review) => {
            if (!review || typeof review !== "object" || Array.isArray(review))
              return [];
            const reviewedAt = String(
              (review as Record<string, unknown>).reviewedAt ?? "",
            );
            return Number.isFinite(new Date(reviewedAt).getTime())
              ? [reviewedAt]
              : [];
          })
        : [],
    };
  });
  const strategyDecisions = runs.flatMap((run) =>
    store.strategyDecisions(run.id, 500).map((decision) => ({
      runId: decision.runId,
      decision: decision.decision,
      riskChecks:
        decision.riskChecks &&
        typeof decision.riskChecks === "object" &&
        !Array.isArray(decision.riskChecks)
          ? (decision.riskChecks as Record<string, unknown>)
          : {},
      paperOrderId: decision.paperOrderId,
      orderOutcome: decision.orderOutcome,
      createdAt: decision.createdAt,
    })),
  );
  const backup = store.databaseBackup().metadata;
  const recentEvents = store.events(1_000);
  const eventsById = new Map(
    [...recentEvents, ...workflowEvents].map((event) => [event.id, event]),
  );
  return buildClosedBetaEvidenceReport({
    paperClient: true,
    decisionAuditVerification: store.verifyDecisionAuditTrail(),
    decisionAuditEntryHashes: store
      .closedBetaAuditEntries(1_000)
      .map((entry) => entry.entryHash),
    receipts: store.receipts(1_000),
    events: [...eventsById.values()],
    strategyRuns,
    strategyDecisions,
    backupMetadata: {
      sha256: backup.sha256,
      sizeBytes: backup.sizeBytes,
      createdAt: backup.createdAt,
    },
  });
}

function closedBetaReview(store: Store) {
  const events = closedBetaWorkflowEvents(store);
  return buildClosedBetaReviewPacket({
    evidence: closedBetaEvidence(store, events),
    events,
    auditEntries: store.closedBetaAuditEntries(1_000),
  });
}

function betaInput<T>(operation: () => T) {
  try {
    return operation();
  } catch (error) {
    throw new ClientError(
      error instanceof Error ? error.message : "Invalid closed-beta input",
      400,
    );
  }
}

/** Handles the operational controls and evidence endpoints. */
export async function handleOperationsRequest(
  request: Request,
  url: URL,
  context: OperationsContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/operations/")) return null;

  const { store, actor, allow } = context;
  const env = context.env ?? process.env;

  if (url.pathname === "/api/operations/policy" && request.method === "GET") {
    return json({
      policy: store.operationsPolicy(),
      ...localResponseTimeFields(new Date()),
    });
  }

  if (url.pathname === "/api/operations/policy" && request.method === "POST") {
    if (!allow(`${actor}:operations-policy`, 10)) {
      return json(
        { error: "Operations policy update rate limit exceeded" },
        429,
      );
    }
    const policy = store.updateOperationsPolicy(
      actor,
      await requestJson(request),
    );
    store.event("operations.policy.updated", actor, { policy });
    return json({ policy, ...localResponseTimeFields(new Date()) });
  }

  if (
    url.pathname === "/api/operations/kill-switch" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:operations-kill-switch`, 10)) {
      return json({ error: "Operations kill switch rate limit exceeded" }, 429);
    }
    const input = await requestJson(request);
    const active = input.active !== false;
    const reason = String(input.reason ?? "").trim();
    if (active && !reason)
      return json({ error: "A kill-switch reason is required" }, 400);
    const policy = store.updateOperationsPolicy(actor, {
      globalKillSwitch: active
        ? {
            active: true,
            reason,
            activatedAt: new Date().toISOString(),
            activatedBy: actor,
          }
        : { active: false, reason, activatedAt: null, activatedBy: actor },
    });
    store.event(
      active
        ? "operations.kill_switch.activated"
        : "operations.kill_switch.cleared",
      actor,
      { reason, policy },
    );
    return json({ policy, ...localResponseTimeFields(new Date()) });
  }

  if (url.pathname === "/api/operations/secrets" && request.method === "GET") {
    return json({
      secrets: store.encryptedSecretMetadata(),
      ...localResponseTimeFields(new Date()),
    });
  }

  if (url.pathname === "/api/operations/secrets" && request.method === "POST") {
    if (!allow(`${actor}:operations-secrets`, 10)) {
      return json(
        { error: "Operations secret update rate limit exceeded" },
        429,
      );
    }
    const input = await requestJson(request);
    const name = secretNameInput(input.name);
    const value = String(input.value ?? "");
    const key = vaultKey(env);
    const envelope = encryptSecretValue(value, key);
    if (decryptSecretValue(envelope, key) !== value) {
      throw new Error("Encrypted secret self-check failed");
    }
    const secret = store.upsertEncryptedSecret(name, envelope, actor);
    store.event("operations.secret.upserted", actor, {
      name,
      algorithm: secret.algorithm,
      keyDigest: secret.keyDigest,
      ciphertextBytes: secret.ciphertextBytes,
    });
    return json({ secret, ...localResponseTimeFields(new Date()) });
  }

  const secretMatch = url.pathname.match(
    /^\/api\/operations\/secrets\/([^/]+)$/,
  );
  if (secretMatch && request.method === "GET") {
    const secret = store.encryptedSecret(
      secretNameInput(decodeURIComponent(secretMatch[1]!)),
    );
    if (!secret) return json({ error: "Secret not found" }, 404);
    return json({
      secret: store
        .encryptedSecretMetadata()
        .find((item) => item.name === secret.name),
      ...localResponseTimeFields(new Date()),
    });
  }

  if (secretMatch && request.method === "DELETE") {
    if (!allow(`${actor}:operations-secrets`, 10)) {
      return json(
        { error: "Operations secret update rate limit exceeded" },
        429,
      );
    }
    const name = secretNameInput(decodeURIComponent(secretMatch[1]!));
    const deleted = store.deleteEncryptedSecret(name);
    store.event("operations.secret.deleted", actor, { name, deleted });
    return deleted
      ? json({ deleted: true, name })
      : json({ error: "Secret not found" }, 404);
  }

  if (
    url.pathname === "/api/operations/readiness" &&
    request.method === "GET"
  ) {
    const backup = store.databaseBackup().metadata;
    const observability = store.observabilityExport(100);
    return json({
      migrations: store.schemaMigrations(),
      backup,
      observability: {
        generatedAt: observability.generatedAt,
        spanCount: observability.spans.length,
        metricCount: observability.strategyMetrics.length,
        eventCount: observability.recentEvents.length,
        decisionAuditVerification: observability.decisionAuditVerification,
      },
      secrets: { count: store.encryptedSecretMetadata().length },
      externalDataIdentity: {
        secUserAgentConfigured: secIdentityConfigured(env),
      },
      incident: store.incidentPacket(50),
      ...localResponseTimeFields(new Date()),
    });
  }

  if (url.pathname === "/api/operations/backup" && request.method === "POST") {
    if (!allow(`${actor}:operations-backup`, 5)) {
      return json({ error: "Operations backup rate limit exceeded" }, 429);
    }
    store.event("operations.backup.exported", actor, {
      requestedAt: new Date().toISOString(),
    });
    const backup = store.databaseBackup();
    return new Response(new Blob([new Uint8Array(backup.bytes)]), {
      headers: {
        ...securityHeaders,
        "content-type": "application/vnd.sqlite3",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="ai-broker-backup-${backup.metadata.createdAt.replace(/[:.]/g, "-")}.sqlite"`,
        "x-backup-sha256": backup.metadata.sha256,
        "x-backup-size-bytes": String(backup.metadata.sizeBytes),
      },
    });
  }

  if (
    url.pathname === "/api/operations/observability-export" &&
    request.method === "GET"
  ) {
    const limit = Number(url.searchParams.get("limit") ?? 500);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      return json(
        { error: "Observability export limit must be between 1 and 5000" },
        400,
      );
    }
    return json(store.observabilityExport(limit));
  }

  if (
    url.pathname === "/api/operations/incident-packet" &&
    request.method === "GET"
  ) {
    const limit = Number(url.searchParams.get("limit") ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      return json(
        { error: "Incident packet limit must be between 1 and 1000" },
        400,
      );
    }
    return json(store.incidentPacket(limit));
  }

  if (
    url.pathname === "/api/operations/data-governance" &&
    request.method === "GET"
  ) {
    return json(buildDataGovernanceReport());
  }

  if (
    url.pathname === "/api/operations/data-quality" &&
    request.method === "GET"
  ) {
    return json(
      buildDataQualityReport({
        sources: DATA_GOVERNANCE_SOURCES,
        events: store.events(1_000),
        datasets: store.strategyBarDatasets(actor, 100).filter(Boolean),
      }),
    );
  }

  if (
    url.pathname === "/api/operations/reconciliation" &&
    request.method === "GET"
  ) {
    return json(reconciliationReport(store));
  }

  if (
    url.pathname === "/api/operations/reconciliation" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:operations-reconciliation`, 5)) {
      return json(
        { error: "Operations reconciliation rate limit exceeded" },
        429,
      );
    }
    if (!context.runReconciliation) {
      return json({ error: "Operations reconciliation is unavailable" }, 503);
    }
    return json(await context.runReconciliation("manual", actor));
  }

  if (
    url.pathname === "/api/operations/retention" &&
    request.method === "GET"
  ) {
    return json(retentionReport(store, retentionPolicyFromEnv(env)));
  }

  if (
    url.pathname === "/api/operations/retention" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:operations-retention`, 2)) {
      return json({ error: "Operations retention rate limit exceeded" }, 429);
    }
    if (!context.runRetention)
      return json({ error: "Operations retention is unavailable" }, 503);
    return json(await context.runRetention("manual", actor));
  }

  if (
    url.pathname === "/api/operations/production-governance" &&
    request.method === "GET"
  ) {
    return json(buildProductionGovernanceReport(env));
  }

  if (
    url.pathname === "/api/operations/closed-beta-evidence" &&
    request.method === "GET"
  ) {
    return json(closedBetaEvidence(store));
  }

  if (
    url.pathname === "/api/operations/closed-beta-review" &&
    request.method === "GET"
  ) {
    const packet = closedBetaReview(store);
    return json({
      ...packet,
      ...localResponseTimeFields(new Date(packet.generatedAt)),
    });
  }

  if (
    url.pathname === "/api/operations/closed-beta-review/packet" &&
    request.method === "GET"
  ) {
    const packet = closedBetaReview(store);
    return new Response(JSON.stringify(packet, null, 2), {
      headers: {
        ...securityHeaders,
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="closed-beta-review-${packet.generatedAt.replace(/[:.]/g, "-")}.json"`,
      },
    });
  }

  if (
    url.pathname === "/api/operations/closed-beta-review/records" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:closed-beta-record`, 30))
      return json({ error: "Closed-beta record rate limit exceeded" }, 429);
    const evidence = closedBetaEvidence(store);
    const recordBody = await requestJson(request);
    const input = betaInput(() =>
      parseClosedBetaRecordInput(
        recordBody,
        evidence.targets.map((target) => target.id),
      ),
    );
    const recordId = crypto.randomUUID();
    const recordedAt = new Date().toISOString();
    const event = closedBetaRecordEvent(input);
    const payload = {
      schemaVersion: "closed-beta-workflow-record-v1",
      recordId,
      ...input,
      recordedAt,
      recordedBy: actor,
    };
    const persisted = store.closedBetaWorkflowRecord({
      eventType: event.type,
      recordId,
      auditKind: event.auditKind,
      actor,
      payload,
      recordedAt,
    });
    return json(
      {
        record: { ...persisted.payload, eventId: persisted.eventId },
        workflowSummary: closedBetaReview(store).summary,
        ...localResponseTimeFields(new Date()),
      },
      201,
    );
  }

  const incidentResolutionMatch = url.pathname.match(
    /^\/api\/operations\/closed-beta-review\/incidents\/([^/]+)\/resolve$/,
  );
  if (incidentResolutionMatch && request.method === "POST") {
    if (!allow(`${actor}:closed-beta-incident-resolution`, 30))
      return json(
        { error: "Closed-beta incident resolution rate limit exceeded" },
        429,
      );
    const incidentRecordId = decodeURIComponent(incidentResolutionMatch[1]!);
    const review = closedBetaReview(store);
    const incident = review.incidents.records.find(
      (record) => record.recordId === incidentRecordId,
    );
    if (!incident) return json({ error: "Closed-beta incident not found" }, 404);
    if (incident.status === "resolved")
      return json({ error: "Closed-beta incident is already resolved" }, 409);
    const resolutionBody = await requestJson(request);
    const input = betaInput(() =>
      parseClosedBetaResolutionInput(resolutionBody),
    );
    if (
      new Date(input.resolvedAt).getTime() <
      new Date(incident.occurredAt).getTime()
    )
      return json(
        { error: "resolvedAt cannot precede the incident" },
        400,
      );
    const recordedAt = new Date().toISOString();
    const payload = {
      schemaVersion: "closed-beta-workflow-resolution-v1",
      incidentRecordId,
      ...input,
      resolvedBy: actor,
      recordedAt,
    };
    const persisted = store.closedBetaWorkflowRecord({
      eventType: "operations.closed_beta.incident_resolved",
      recordId: incidentRecordId,
      auditKind: "closed_beta_incident_resolved",
      actor,
      payload,
      recordedAt,
    });
    return json({
      resolution: { ...persisted.payload, eventId: persisted.eventId },
      workflowSummary: closedBetaReview(store).summary,
      ...localResponseTimeFields(new Date()),
    });
  }

  return null;
}
