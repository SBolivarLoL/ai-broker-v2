/** Builds an append-only operator review workflow around measured beta evidence. */

import type {
  ClosedBetaEvidenceReport,
  ClosedBetaEvidenceTarget,
} from "./production-governance";

export const CLOSED_BETA_DRILL_TYPES = [
  "backup_export",
  "restore",
  "kill_switch",
  "incident_response",
] as const;

export const CLOSED_BETA_RECORD_EVENT_TYPES = [
  "operations.closed_beta.supporting_recorded",
  "operations.closed_beta.drill_recorded",
  "operations.closed_beta.beta_window_recorded",
  "operations.closed_beta.incident_opened",
  "operations.closed_beta.incident_resolved",
] as const;

type DrillType = (typeof CLOSED_BETA_DRILL_TYPES)[number];
type RecordEventType = (typeof CLOSED_BETA_RECORD_EVENT_TYPES)[number];
type IncidentSeverity = "critical" | "high" | "medium" | "low";

export type ClosedBetaWorkflowEvent = {
  id: number;
  type: string;
  actor: string;
  payload: unknown;
  createdAt: string;
};

export type ClosedBetaAuditEntry = {
  subjectId: string;
  kind: string;
  actor: string;
  payload: unknown;
  entryHash: string;
  createdAt: string;
};

export type ClosedBetaRecordInput =
  | {
      kind: "supporting_record";
      targetId: string;
      title: string;
      reference: string;
      occurredAt: string;
      note: string | null;
    }
  | {
      kind: "drill";
      drillType: DrillType;
      outcome: "pass" | "fail";
      title: string;
      reference: string;
      occurredAt: string;
      note: string | null;
    }
  | {
      kind: "incident";
      severity: IncidentSeverity;
      title: string;
      reference: string;
      occurredAt: string;
      note: string | null;
    }
  | {
      kind: "beta_window";
      title: string;
      reference: string;
      occurredAt: string;
      note: string | null;
      startedAt: string;
      endedAt: string;
      participantCount: number;
    };

export type ClosedBetaResolutionInput = {
  resolution: string;
  resolvedAt: string;
};

type WorkflowRecordBase = {
  schemaVersion: "closed-beta-workflow-record-v1";
  recordId: string;
  title: string;
  reference: string;
  occurredAt: string;
  note: string | null;
  recordedAt: string;
  recordedBy: string;
  auditEntryHash: string;
};

type SupportingRecord = WorkflowRecordBase & {
  kind: "supporting_record";
  targetId: string;
};

type DrillRecord = WorkflowRecordBase & {
  kind: "drill";
  drillType: DrillType;
  outcome: "pass" | "fail";
};

type IncidentRecord = WorkflowRecordBase & {
  kind: "incident";
  severity: IncidentSeverity;
  status: "open" | "resolved";
  resolution: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionAuditEntryHash: string | null;
};

type BetaWindowRecord = WorkflowRecordBase & {
  kind: "beta_window";
  startedAt: string;
  endedAt: string;
  participantCount: number;
  durationDays: number;
};

const MAX_FUTURE_MS = 5 * 60_000;

function objectInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Closed-beta workflow input must be an object");
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  field: string,
  maximum: number,
  required = true,
) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${field} is required`);
  if (normalized.length > maximum)
    throw new Error(`${field} must be at most ${maximum} characters`);
  return normalized;
}

function timestamp(value: unknown, field: string, now: Date) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime()))
    throw new Error(`${field} must be a valid timestamp`);
  if (date.getTime() > now.getTime() + MAX_FUTURE_MS)
    throw new Error(`${field} cannot be in the future`);
  return date.toISOString();
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
) {
  const normalized = String(value ?? "") as T;
  if (!allowed.includes(normalized))
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  return normalized;
}

export function parseClosedBetaRecordInput(
  value: unknown,
  targetIds: readonly string[],
  now = new Date(),
): ClosedBetaRecordInput {
  const input = objectInput(value);
  const kind = oneOf(input.kind, "kind", [
    "supporting_record",
    "drill",
    "incident",
    "beta_window",
  ] as const);
  const commonText = {
    title: text(input.title, "title", 160),
    reference: text(input.reference, "reference", 500),
    note: text(input.note, "note", 2_000, false) || null,
  };
  if (kind === "beta_window") {
    const startedAt = timestamp(input.startedAt, "startedAt", now);
    const endedAt = timestamp(input.endedAt, "endedAt", now);
    if (new Date(endedAt).getTime() - new Date(startedAt).getTime() < 30 * 86_400_000)
      throw new Error("beta window must span at least 30 days");
    const participantCount = Number(input.participantCount);
    if (
      !Number.isInteger(participantCount) ||
      participantCount < 1 ||
      participantCount > 5
    )
      throw new Error("participantCount must be between 1 and 5");
    return {
      kind,
      ...commonText,
      occurredAt: endedAt,
      startedAt,
      endedAt,
      participantCount,
    };
  }
  const common = {
    ...commonText,
    occurredAt: timestamp(input.occurredAt, "occurredAt", now),
  };
  if (kind === "supporting_record")
    return {
      kind,
      targetId: oneOf(input.targetId, "targetId", targetIds),
      ...common,
    };
  if (kind === "drill")
    return {
      kind,
      drillType: oneOf(
        input.drillType,
        "drillType",
        CLOSED_BETA_DRILL_TYPES,
      ),
      outcome: oneOf(input.outcome, "outcome", ["pass", "fail"] as const),
      ...common,
    };
  return {
    kind,
    severity: oneOf(input.severity, "severity", [
      "critical",
      "high",
      "medium",
      "low",
    ] as const),
    ...common,
  };
}

export function parseClosedBetaResolutionInput(
  value: unknown,
  now = new Date(),
): ClosedBetaResolutionInput {
  const input = objectInput(value);
  return {
    resolution: text(input.resolution, "resolution", 2_000),
    resolvedAt: timestamp(input.resolvedAt, "resolvedAt", now),
  };
}

export function closedBetaRecordEvent(input: ClosedBetaRecordInput) {
  const type: RecordEventType =
    input.kind === "supporting_record"
      ? "operations.closed_beta.supporting_recorded"
      : input.kind === "drill"
        ? "operations.closed_beta.drill_recorded"
        : input.kind === "beta_window"
          ? "operations.closed_beta.beta_window_recorded"
          : "operations.closed_beta.incident_opened";
  return { type, auditKind: `closed_beta_${input.kind}_recorded` };
}

function eventPayload(event: ClosedBetaWorkflowEvent) {
  return objectInput(event.payload);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function validRecordId(value: unknown) {
  const id = String(value ?? "");
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,80}$/.test(id) ? id : null;
}

function commonRecord(
  event: ClosedBetaWorkflowEvent,
  payload: Record<string, unknown>,
  now: Date,
  auditEntries: ReadonlyMap<string, ClosedBetaAuditEntry>,
  expectedAuditKind: string,
) {
  if (payload.schemaVersion !== "closed-beta-workflow-record-v1")
    throw new Error("Unsupported closed-beta workflow record version");
  const recordId = validRecordId(payload.recordId);
  if (!recordId) throw new Error("Invalid closed-beta workflow record id");
  const auditEntryHash = String(payload.auditEntryHash ?? "");
  if (!/^sha256:[a-f0-9]{64}$/.test(auditEntryHash))
    throw new Error("Missing closed-beta workflow audit hash");
  const auditEntry = auditEntries.get(auditEntryHash);
  if (!auditEntry)
    throw new Error("Closed-beta workflow audit entry is unavailable");
  const record = {
    schemaVersion: "closed-beta-workflow-record-v1" as const,
    recordId,
    title: text(payload.title, "title", 160),
    reference: text(payload.reference, "reference", 500),
    occurredAt: timestamp(payload.occurredAt, "occurredAt", now),
    note: text(payload.note, "note", 2_000, false) || null,
    recordedAt: timestamp(
      payload.recordedAt ?? event.createdAt,
      "recordedAt",
      now,
    ),
    recordedBy: text(payload.recordedBy ?? event.actor, "recordedBy", 320),
    auditEntryHash,
  };
  const { auditEntryHash: omittedHash, ...auditedPayload } = payload;
  void omittedHash;
  if (
    auditEntry.subjectId !== `closed-beta:${recordId}` ||
    auditEntry.kind !== expectedAuditKind ||
    auditEntry.actor !== event.actor ||
    auditEntry.createdAt !== record.recordedAt ||
    event.actor !== record.recordedBy ||
    canonicalJson(auditEntry.payload) !== canonicalJson(auditedPayload)
  )
    throw new Error("Closed-beta workflow audit entry does not match its event");
  return record;
}

function parseSupportingEvent(
  event: ClosedBetaWorkflowEvent,
  targetIds: readonly string[],
  now: Date,
  auditEntries: ReadonlyMap<string, ClosedBetaAuditEntry>,
): SupportingRecord {
  const payload = eventPayload(event);
  return {
    ...commonRecord(
      event,
      payload,
      now,
      auditEntries,
      "closed_beta_supporting_record_recorded",
    ),
    kind: "supporting_record",
    targetId: oneOf(payload.targetId, "targetId", targetIds),
  };
}

function parseDrillEvent(
  event: ClosedBetaWorkflowEvent,
  now: Date,
  auditEntries: ReadonlyMap<string, ClosedBetaAuditEntry>,
): DrillRecord {
  const payload = eventPayload(event);
  return {
    ...commonRecord(
      event,
      payload,
      now,
      auditEntries,
      "closed_beta_drill_recorded",
    ),
    kind: "drill",
    drillType: oneOf(
      payload.drillType,
      "drillType",
      CLOSED_BETA_DRILL_TYPES,
    ),
    outcome: oneOf(payload.outcome, "outcome", ["pass", "fail"] as const),
  };
}

function parseIncidentEvent(
  event: ClosedBetaWorkflowEvent,
  now: Date,
  auditEntries: ReadonlyMap<string, ClosedBetaAuditEntry>,
): IncidentRecord {
  const payload = eventPayload(event);
  return {
    ...commonRecord(
      event,
      payload,
      now,
      auditEntries,
      "closed_beta_incident_recorded",
    ),
    kind: "incident",
    severity: oneOf(payload.severity, "severity", [
      "critical",
      "high",
      "medium",
      "low",
    ] as const),
    status: "open",
    resolution: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionAuditEntryHash: null,
  };
}

function parseBetaWindowEvent(
  event: ClosedBetaWorkflowEvent,
  now: Date,
  auditEntries: ReadonlyMap<string, ClosedBetaAuditEntry>,
): BetaWindowRecord {
  const payload = eventPayload(event);
  const common = commonRecord(
    event,
    payload,
    now,
    auditEntries,
    "closed_beta_beta_window_recorded",
  );
  const startedAt = timestamp(payload.startedAt, "startedAt", now);
  const endedAt = timestamp(payload.endedAt, "endedAt", now);
  const durationDays =
    (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 86_400_000;
  if (durationDays < 30)
    throw new Error("Closed-beta window is shorter than 30 days");
  const participantCount = Number(payload.participantCount);
  if (
    !Number.isInteger(participantCount) ||
    participantCount < 1 ||
    participantCount > 5
  )
    throw new Error("Closed-beta participant count is outside 1-5");
  if (common.occurredAt !== endedAt)
    throw new Error("Closed-beta window occurrence must equal its end time");
  return {
    ...common,
    kind: "beta_window",
    startedAt,
    endedAt,
    participantCount,
    durationDays,
  };
}

function parseResolutionEvent(
  event: ClosedBetaWorkflowEvent,
  now: Date,
  auditEntries: ReadonlyMap<string, ClosedBetaAuditEntry>,
) {
  const payload = eventPayload(event);
  if (payload.schemaVersion !== "closed-beta-workflow-resolution-v1")
    throw new Error("Unsupported closed-beta resolution version");
  const incidentRecordId = validRecordId(payload.incidentRecordId);
  if (!incidentRecordId) throw new Error("Invalid incident record id");
  const auditEntryHash = String(payload.auditEntryHash ?? "");
  if (!/^sha256:[a-f0-9]{64}$/.test(auditEntryHash))
    throw new Error("Missing closed-beta resolution audit hash");
  const auditEntry = auditEntries.get(auditEntryHash);
  if (!auditEntry)
    throw new Error("Closed-beta resolution audit entry is unavailable");
  const resolution = {
    eventId: event.id,
    incidentRecordId,
    resolution: text(payload.resolution, "resolution", 2_000),
    resolvedAt: timestamp(payload.resolvedAt, "resolvedAt", now),
    resolvedBy: text(payload.resolvedBy ?? event.actor, "resolvedBy", 320),
    auditEntryHash,
  };
  const { auditEntryHash: omittedHash, ...auditedPayload } = payload;
  void omittedHash;
  if (
    auditEntry.subjectId !== `closed-beta:${incidentRecordId}` ||
    auditEntry.kind !== "closed_beta_incident_resolved" ||
    auditEntry.actor !== event.actor ||
    auditEntry.createdAt !== String(payload.recordedAt ?? event.createdAt) ||
    event.actor !== resolution.resolvedBy ||
    canonicalJson(auditEntry.payload) !== canonicalJson(auditedPayload)
  )
    throw new Error("Closed-beta resolution audit entry does not match its event");
  return resolution;
}

function targetDetail(
  target: ClosedBetaEvidenceTarget,
  supportingRecords: SupportingRecord[],
  betaWindow: BetaWindowRecord | null,
) {
  const allRecords = supportingRecords.filter(
    (record) => record.targetId === target.id,
  );
  const records = betaWindow
    ? allRecords.filter(
        (record) =>
          record.occurredAt >= betaWindow.startedAt &&
          record.occurredAt <= betaWindow.endedAt,
      )
    : [];
  return {
    ...target,
    supportingRecords: records,
    outOfWindowSupportingRecords: allRecords.filter(
      (record) => !records.includes(record),
    ),
    supportingRecordCount: records.length,
    totalSupportingRecordCount: allRecords.length,
    supportStatus: records.length ? ("attached" as const) : ("missing" as const),
  };
}

export function buildClosedBetaReviewPacket(input: {
  evidence: ClosedBetaEvidenceReport;
  events: ClosedBetaWorkflowEvent[];
  auditEntries?: readonly ClosedBetaAuditEntry[];
  generatedAt?: string;
}) {
  const generatedAt = new Date(
    input.generatedAt ?? new Date().toISOString(),
  ).toISOString();
  const now = new Date(generatedAt);
  const targetIds = input.evidence.targets.map((target) => target.id);
  const auditEntries = new Map(
    (input.auditEntries ?? []).map((entry) => [entry.entryHash, entry]),
  );
  const supportingRecords: SupportingRecord[] = [];
  const drills: DrillRecord[] = [];
  const betaWindows: BetaWindowRecord[] = [];
  const incidents = new Map<string, IncidentRecord>();
  const resolutions: ReturnType<typeof parseResolutionEvent>[] = [];
  const invalidRecords: { eventId: number; type: string; reason: string }[] = [];
  const seenRecordIds = new Set<string>();

  for (const event of [...input.events].sort((left, right) => left.id - right.id)) {
    try {
      if (event.type === "operations.closed_beta.supporting_recorded") {
        const record = parseSupportingEvent(
          event,
          targetIds,
          now,
          auditEntries,
        );
        if (seenRecordIds.has(record.recordId))
          throw new Error("Duplicate closed-beta workflow record id");
        seenRecordIds.add(record.recordId);
        supportingRecords.push(record);
      } else if (event.type === "operations.closed_beta.drill_recorded") {
        const record = parseDrillEvent(event, now, auditEntries);
        if (seenRecordIds.has(record.recordId))
          throw new Error("Duplicate closed-beta workflow record id");
        seenRecordIds.add(record.recordId);
        drills.push(record);
      } else if (event.type === "operations.closed_beta.incident_opened") {
        const record = parseIncidentEvent(event, now, auditEntries);
        if (seenRecordIds.has(record.recordId))
          throw new Error("Duplicate closed-beta workflow record id");
        seenRecordIds.add(record.recordId);
        incidents.set(record.recordId, record);
      } else if (event.type === "operations.closed_beta.beta_window_recorded") {
        const record = parseBetaWindowEvent(event, now, auditEntries);
        if (seenRecordIds.has(record.recordId))
          throw new Error("Duplicate closed-beta workflow record id");
        seenRecordIds.add(record.recordId);
        betaWindows.push(record);
      } else if (event.type === "operations.closed_beta.incident_resolved") {
        resolutions.push(parseResolutionEvent(event, now, auditEntries));
      }
    } catch (error) {
      invalidRecords.push({
        eventId: event.id,
        type: event.type,
        reason: error instanceof Error ? error.message : "Invalid record",
      });
    }
  }

  const resolvedIds = new Set<string>();
  for (const resolution of resolutions) {
    const incident = incidents.get(resolution.incidentRecordId);
    if (!incident) {
      invalidRecords.push({
        eventId: resolution.eventId,
        type: "operations.closed_beta.incident_resolved",
        reason: `Resolution references missing incident ${resolution.incidentRecordId}`,
      });
      continue;
    }
    if (
      resolvedIds.has(resolution.incidentRecordId) ||
      new Date(resolution.resolvedAt).getTime() <
        new Date(incident.occurredAt).getTime()
    ) {
      invalidRecords.push({
        eventId: resolution.eventId,
        type: "operations.closed_beta.incident_resolved",
        reason: `Invalid duplicate or pre-incident resolution for ${resolution.incidentRecordId}`,
      });
      continue;
    }
    resolvedIds.add(resolution.incidentRecordId);
    incident.status = "resolved";
    incident.resolution = resolution.resolution;
    incident.resolvedAt = resolution.resolvedAt;
    incident.resolvedBy = resolution.resolvedBy;
    incident.resolutionAuditEntryHash = resolution.auditEntryHash;
  }

  const completedBetaWindow = betaWindows.toSorted((left, right) =>
    right.recordedAt.localeCompare(left.recordedAt),
  )[0] ?? null;
  const targetDetails = input.evidence.targets.map((target) =>
    targetDetail(target, supportingRecords, completedBetaWindow),
  );
  const drillDetails = CLOSED_BETA_DRILL_TYPES.map((drillType) => {
    const records = drills.filter((record) => record.drillType === drillType);
    const passed = completedBetaWindow
      ? records.filter(
          (record) =>
            record.outcome === "pass" &&
            record.occurredAt >= completedBetaWindow.startedAt &&
            record.occurredAt <= completedBetaWindow.endedAt,
        )
      : [];
    return {
      drillType,
      status: passed.length ? ("pass" as const) : ("needs_evidence" as const),
      latestPassedAt: passed.toSorted((left, right) =>
        right.occurredAt.localeCompare(left.occurredAt),
      )[0]?.occurredAt ?? null,
      records,
    };
  });
  const incidentRecords = [...incidents.values()].toSorted((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt),
  );
  const unresolvedIncidents = incidentRecords.filter(
    (incident) => incident.status === "open",
  );
  const unresolvedCriticalHigh = unresolvedIncidents.filter((incident) =>
    ["critical", "high"].includes(incident.severity),
  );
  const missingSupportingTargets = targetDetails
    .filter((target) => !target.supportingRecordCount)
    .map((target) => target.id);
  const missingDrills = drillDetails
    .filter((drill) => drill.status !== "pass")
    .map((drill) => drill.drillType);
  const readyForExternalReview =
    input.evidence.summary.readyForExitReview &&
    !missingSupportingTargets.length &&
    !missingDrills.length &&
    Boolean(completedBetaWindow) &&
    !unresolvedCriticalHigh.length &&
    !invalidRecords.length &&
    input.events.length < 1_000;

  return {
    packetVersion: "closed-beta-review-packet-v1" as const,
    generatedAt,
    scope: {
      executionMode: "paper_only" as const,
      targetWindowDays: input.evidence.targetWindowDays,
      externallyApproved: false as const,
    },
    status: readyForExternalReview
      ? ("ready_for_external_review" as const)
      : ("needs_evidence" as const),
    summary: {
      readyForExternalReview,
      measuredTargetsPassing: input.evidence.summary.pass,
      totalTargets: input.evidence.summary.totalTargets,
      targetsMissingSupportingRecords: missingSupportingTargets,
      missingDrills,
      completedBetaWindow: Boolean(completedBetaWindow),
      unresolvedIncidentCount: unresolvedIncidents.length,
      unresolvedCriticalHighCount: unresolvedCriticalHigh.length,
      invalidRecordCount: invalidRecords.length,
      recordLimitReached: input.events.length >= 1_000,
    },
    targetDetails,
    supportingRecords,
    drills: {
      required: [...CLOSED_BETA_DRILL_TYPES],
      details: drillDetails,
    },
    betaWindow: {
      status: completedBetaWindow ? ("complete" as const) : ("needs_evidence" as const),
      selected: completedBetaWindow,
      records: betaWindows.toSorted((left, right) =>
        right.recordedAt.localeCompare(left.recordedAt),
      ),
    },
    incidents: {
      records: incidentRecords,
      unresolved: unresolvedIncidents,
      unresolvedCriticalHigh,
    },
    invalidRecords,
    measuredEvidence: input.evidence,
    limitations: [
      "This packet organizes local paper-beta evidence; it does not prove that a real beta, drill, or external review occurred.",
      "Operator-entered references are labels only; the application does not verify the referenced artifact contents.",
      "The packet is bounded to the newest 1,000 workflow events and fails readiness when that limit is reached.",
      "Ready for external review is not legal, compliance, entitlement, deployment, or live-trading approval.",
    ],
  };
}
