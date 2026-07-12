import { expect, test } from "bun:test";
import {
  buildClosedBetaReviewPacket,
  CLOSED_BETA_DRILL_TYPES,
  parseClosedBetaRecordInput,
} from "../../backend/features/operations/closed-beta-workflow";
import {
  CLOSED_BETA_TARGETS,
  type ClosedBetaEvidenceReport,
} from "../../backend/features/operations/production-governance";

const generatedAt = "2026-07-13T10:00:00.000Z";
const hash = (character: string) => `sha256:${character.repeat(64)}`;

function evidence(): ClosedBetaEvidenceReport {
  const targets = CLOSED_BETA_TARGETS.map((target) => ({
    ...target,
    status: "pass" as const,
    actual: `${target.metric} passed.`,
    observedEvidence: { verified: true },
  }));
  return {
    generatedAt,
    mode: "paper_accounts_only",
    targetWindowDays: 30,
    targets,
    summary: {
      totalTargets: targets.length,
      pass: targets.length,
      fail: 0,
      needsEvidence: 0,
      readyForExitReview: true,
      openTargets: [],
    },
    runbook: [],
  };
}

function workflowEvent(
  id: number,
  type: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    type,
    actor: "operator@example.com",
    createdAt: `2026-07-13T09:${String(id).padStart(2, "0")}:00.000Z`,
    payload,
  };
}

function baseRecord(id: number, kind: string) {
  return {
    schemaVersion: "closed-beta-workflow-record-v1",
    recordId: `record-${String(id).padStart(4, "0")}`,
    kind,
    title: `Evidence ${id}`,
    reference: `local://evidence/${id}`,
    occurredAt: "2026-07-12T09:00:00.000Z",
    note: null,
    recordedAt: "2026-07-13T09:00:00.000Z",
    recordedBy: "operator@example.com",
    auditEntryHash: `sha256:${id.toString(16).padStart(64, "0")}`,
  };
}

function auditEntriesFor(
  events: ReturnType<typeof workflowEvent>[],
) {
  const kinds: Record<string, string> = {
    "operations.closed_beta.supporting_recorded":
      "closed_beta_supporting_record_recorded",
    "operations.closed_beta.drill_recorded": "closed_beta_drill_recorded",
    "operations.closed_beta.beta_window_recorded":
      "closed_beta_beta_window_recorded",
    "operations.closed_beta.incident_opened": "closed_beta_incident_recorded",
    "operations.closed_beta.incident_resolved": "closed_beta_incident_resolved",
  };
  return events.map((event) => {
    const payload = event.payload as Record<string, unknown>;
    const { auditEntryHash, ...auditedPayload } = payload;
    return {
      subjectId: `closed-beta:${String(
        payload.recordId ?? payload.incidentRecordId,
      )}`,
      kind: kinds[event.type]!,
      actor: event.actor,
      payload: auditedPayload,
      entryHash: String(auditEntryHash),
      createdAt: String(payload.recordedAt ?? event.createdAt),
    };
  });
}

test("validates bounded closed-beta workflow records", () => {
  expect(
    parseClosedBetaRecordInput(
      {
        kind: "drill",
        drillType: "restore",
        outcome: "pass",
        title: "Restore drill",
        reference: "local://restore/1",
        occurredAt: "2026-07-12T09:00:00Z",
      },
      CLOSED_BETA_TARGETS.map((target) => target.id),
      new Date(generatedAt),
    ),
  ).toEqual({
    kind: "drill",
    drillType: "restore",
    outcome: "pass",
    title: "Restore drill",
    reference: "local://restore/1",
    occurredAt: "2026-07-12T09:00:00.000Z",
    note: null,
  });
  expect(() =>
    parseClosedBetaRecordInput(
      {
        kind: "supporting_record",
        targetId: "unknown",
        title: "Unknown target",
        reference: "local://unknown",
        occurredAt: "2026-07-12T09:00:00Z",
      },
      CLOSED_BETA_TARGETS.map((target) => target.id),
      new Date(generatedAt),
    ),
  ).toThrow("targetId must be one of");
  expect(() =>
    parseClosedBetaRecordInput(
      {
        kind: "incident",
        severity: "critical",
        title: "Future incident",
        reference: "local://incident/future",
        occurredAt: "2026-07-14T09:00:00Z",
      },
      CLOSED_BETA_TARGETS.map((target) => target.id),
      new Date(generatedAt),
    ),
  ).toThrow("occurredAt cannot be in the future");
  expect(
    parseClosedBetaRecordInput(
      {
        kind: "beta_window",
        title: "Thirty-day paper beta",
        reference: "local://beta/window-1",
        startedAt: "2026-06-01T09:00:00Z",
        endedAt: "2026-07-02T09:00:00Z",
        participantCount: 3,
      },
      CLOSED_BETA_TARGETS.map((target) => target.id),
      new Date(generatedAt),
    ),
  ).toMatchObject({
    kind: "beta_window",
    occurredAt: "2026-07-02T09:00:00.000Z",
    participantCount: 3,
  });
});

test("builds a complete review packet only from attached support drills and resolved incidents", () => {
  let id = 1;
  const events = CLOSED_BETA_TARGETS.map((target) =>
    workflowEvent(
      id,
      "operations.closed_beta.supporting_recorded",
      { ...baseRecord(id++, "supporting_record"), targetId: target.id },
    ),
  );
  for (const drillType of CLOSED_BETA_DRILL_TYPES) {
    events.push(
      workflowEvent(id, "operations.closed_beta.drill_recorded", {
        ...baseRecord(id++, "drill"),
        drillType,
        outcome: "pass",
      }),
    );
  }
  events.push(
    workflowEvent(id, "operations.closed_beta.beta_window_recorded", {
      ...baseRecord(id++, "beta_window"),
      occurredAt: "2026-07-13T09:00:00.000Z",
      startedAt: "2026-06-11T09:00:00.000Z",
      endedAt: "2026-07-13T09:00:00.000Z",
      participantCount: 3,
    }),
  );
  const incidentId = `record-${String(id).padStart(4, "0")}`;
  events.push(
    workflowEvent(id, "operations.closed_beta.incident_opened", {
      ...baseRecord(id++, "incident"),
      severity: "high",
    }),
  );
  events.push(
    workflowEvent(id, "operations.closed_beta.incident_resolved", {
      schemaVersion: "closed-beta-workflow-resolution-v1",
      incidentRecordId: incidentId,
      resolution: "Reconciled the fixture and reviewed the runbook.",
      resolvedAt: "2026-07-12T10:00:00.000Z",
      resolvedBy: "operator@example.com",
      recordedAt: "2026-07-13T09:30:00.000Z",
      auditEntryHash: hash("f"),
    }),
  );

  const packet = buildClosedBetaReviewPacket({
    evidence: evidence(),
    events,
    auditEntries: auditEntriesFor(events),
    generatedAt,
  });
  expect(packet).toMatchObject({
    packetVersion: "closed-beta-review-packet-v1",
    status: "ready_for_external_review",
    scope: { executionMode: "paper_only", externallyApproved: false },
    summary: {
      readyForExternalReview: true,
      targetsMissingSupportingRecords: [],
      missingDrills: [],
      completedBetaWindow: true,
      unresolvedCriticalHighCount: 0,
      invalidRecordCount: 0,
    },
  });
  expect(packet.targetDetails).toHaveLength(8);
  expect(
    packet.targetDetails.every(
      (target) => target.supportingRecordCount === 1,
    ),
  ).toBe(true);
  expect(packet.drills.details.map((drill) => drill.status)).toEqual([
    "pass",
    "pass",
    "pass",
    "pass",
  ]);
  expect(packet.betaWindow).toMatchObject({
    status: "complete",
    selected: { participantCount: 3, durationDays: 32 },
  });
  expect(packet.incidents.records).toMatchObject([
    { recordId: incidentId, severity: "high", status: "resolved" },
  ]);
});

test("keeps unresolved serious incidents and malformed records visible", () => {
  const packet = buildClosedBetaReviewPacket({
    evidence: evidence(),
    generatedAt,
    events: [
      workflowEvent(1, "operations.closed_beta.incident_opened", {
        ...baseRecord(1, "incident"),
        severity: "critical",
      }),
      workflowEvent(2, "operations.closed_beta.drill_recorded", {
        ...baseRecord(2, "drill"),
        drillType: "restore",
        outcome: "pass",
        auditEntryHash: null,
      }),
    ],
    auditEntries: auditEntriesFor([
      workflowEvent(1, "operations.closed_beta.incident_opened", {
        ...baseRecord(1, "incident"),
        severity: "critical",
      }),
    ]),
  });

  expect(packet.status).toBe("needs_evidence");
  expect(packet.summary).toMatchObject({
    readyForExternalReview: false,
    unresolvedCriticalHighCount: 1,
    invalidRecordCount: 1,
    completedBetaWindow: false,
  });
  expect(packet.summary.targetsMissingSupportingRecords).toHaveLength(8);
  expect(packet.summary.missingDrills).toEqual([
    "backup_export",
    "restore",
    "kill_switch",
    "incident_response",
  ]);
  expect(packet.invalidRecords[0]?.reason).toContain("audit hash");
});

test("uses the newest recorded beta window and rejects orphan or duplicate resolutions", () => {
  const incident = {
    ...baseRecord(1, "incident"),
    severity: "high",
  };
  const olderWindow = {
    ...baseRecord(2, "beta_window"),
    occurredAt: "2026-07-12T09:00:00.000Z",
    startedAt: "2026-06-01T09:00:00.000Z",
    endedAt: "2026-07-12T09:00:00.000Z",
    participantCount: 2,
    recordedAt: "2026-07-13T08:00:00.000Z",
  };
  const correctedWindow = {
    ...baseRecord(3, "beta_window"),
    occurredAt: "2026-07-10T09:00:00.000Z",
    startedAt: "2026-06-01T09:00:00.000Z",
    endedAt: "2026-07-10T09:00:00.000Z",
    participantCount: 3,
    recordedAt: "2026-07-13T09:00:00.000Z",
  };
  const resolution = (id: number, incidentRecordId: string) => ({
    schemaVersion: "closed-beta-workflow-resolution-v1",
    incidentRecordId,
    resolution: `Resolution ${id}`,
    resolvedAt: "2026-07-12T10:00:00.000Z",
    resolvedBy: "operator@example.com",
    recordedAt: `2026-07-13T09:${id}:00.000Z`,
    auditEntryHash: hash(String(id)),
  });
  const events = [
    workflowEvent(1, "operations.closed_beta.incident_opened", incident),
    workflowEvent(
      2,
      "operations.closed_beta.beta_window_recorded",
      olderWindow,
    ),
    workflowEvent(
      3,
      "operations.closed_beta.beta_window_recorded",
      correctedWindow,
    ),
    workflowEvent(
      4,
      "operations.closed_beta.incident_resolved",
      resolution(4, "missing-incident"),
    ),
    workflowEvent(
      5,
      "operations.closed_beta.incident_resolved",
      resolution(5, incident.recordId),
    ),
    workflowEvent(
      6,
      "operations.closed_beta.incident_resolved",
      resolution(6, incident.recordId),
    ),
  ];
  const packet = buildClosedBetaReviewPacket({
    evidence: evidence(),
    events,
    auditEntries: auditEntriesFor(events),
    generatedAt,
  });

  expect(packet.betaWindow.selected).toMatchObject({
    participantCount: 3,
    endedAt: "2026-07-10T09:00:00.000Z",
  });
  expect(packet.incidents.records).toMatchObject([
    { recordId: incident.recordId, status: "resolved" },
  ]);
  expect(packet.summary).toMatchObject({
    readyForExternalReview: false,
    invalidRecordCount: 2,
    unresolvedCriticalHighCount: 0,
  });
  expect(packet.invalidRecords.map((record) => record.reason)).toEqual([
    expect.stringContaining("missing incident"),
    expect.stringContaining("duplicate or pre-incident"),
  ]);
});

test("rejects a valid audit hash borrowed from mismatched audit content", () => {
  const event = workflowEvent(
    1,
    "operations.closed_beta.supporting_recorded",
    {
      ...baseRecord(1, "supporting_record"),
      targetId: CLOSED_BETA_TARGETS[0]!.id,
    },
  );
  const [auditEntry] = auditEntriesFor([event]);
  const packet = buildClosedBetaReviewPacket({
    evidence: evidence(),
    events: [event],
    auditEntries: [
      {
        ...auditEntry!,
        payload: { ...(auditEntry!.payload as object), title: "Changed title" },
      },
    ],
    generatedAt,
  });

  expect(packet.summary.invalidRecordCount).toBe(1);
  expect(packet.invalidRecords[0]?.reason).toContain(
    "does not match its event",
  );
});
