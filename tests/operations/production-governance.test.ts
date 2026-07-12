import { expect, test } from "bun:test";
import { buildClosedBetaEvidenceReport, buildProductionGovernanceReport, evaluateCryptoCapabilityRequest } from "../../backend/features/operations/production-governance";

test("builds production governance report with legal review and live-trading blockers", () => {
  const report = buildProductionGovernanceReport({ LIVE_TRADING_ENABLED: "true", LIVE_TRADING_REVIEW_ID: "review-123" }, "2026-06-26T12:00:00.000Z");

  expect(report.scope).toMatchObject({
    executionMode: "paper_only",
    brokerClient: "alpaca_trading_api_paper",
    liveTradingAvailable: false,
  });
  expect(report.liveTradingGate).toMatchObject({
    requested: true,
    reviewId: "review-123",
    available: false,
  });
  expect(report.liveTradingGate.hardBlockers).toContain("external_legal_compliance_signoff");
  expect(report.liveTradingGate.hardBlockers).toContain("closed_beta_evidence");
  expect(report.summary.domainsRequiringExternalReview).toEqual(expect.arrayContaining([
    "investment_advice_boundary",
    "crypto_disclosures",
    "automated_strategy_controls",
  ]));
  expect(report.closedBeta.safetyTargets.map(target => target.id)).toEqual(expect.arrayContaining([
    "paper_only_execution",
    "decision_audit_validity",
    "strategy_risk_blocks",
  ]));
  expect(report.closedBeta.exitCriteria.join(" ")).toContain("legal/compliance review");
  expect(report.cryptoCapabilityBoundary).toMatchObject({
    mode: "separately_approved_only",
    defaultDecision: "deny",
  });
  expect(report.cryptoCapabilityBoundary.disabledCapabilities.map(capability => capability.id)).toEqual([
    "crypto_transfers",
    "crypto_perpetual_leverage",
    "crypto_tokenization",
  ]);
  expect(report.cryptoCapabilityBoundary.disabledCapabilities.every(capability => capability.available === false)).toBe(true);
  expect(report.runbook.join(" ")).toContain("do not mark it complete from code evidence alone");
});

test("keeps unsupported crypto capabilities disabled until separate approval", () => {
  expect(evaluateCryptoCapabilityRequest("crypto_transfers")).toMatchObject({
    allowed: false,
    requiredApproval: expect.arrayContaining(["custody_security_review", "external_legal_compliance_signoff"]),
  });
  expect(evaluateCryptoCapabilityRequest("crypto_perpetual_leverage")).toMatchObject({
    allowed: false,
    requiredApproval: expect.arrayContaining(["leverage_risk_model", "external_legal_compliance_signoff"]),
  });
  expect(evaluateCryptoCapabilityRequest("crypto_tokenization")).toMatchObject({
    allowed: false,
    requiredApproval: expect.arrayContaining(["asset_availability_review", "external_legal_compliance_signoff"]),
  });
  expect(evaluateCryptoCapabilityRequest("crypto_unlisted_feature")).toEqual({
    id: "crypto_unlisted_feature",
    allowed: false,
    reason: "Unknown crypto capabilities fail closed until they are added to the production-governance boundary.",
    requiredApproval: ["explicit_capability_record", "external_legal_compliance_signoff"],
  });
});

test("measures closed beta targets from persisted paper evidence", () => {
  const drillHashes = ["1", "2", "3", "4"].map(
    (value) => `sha256:${value.repeat(64)}`,
  );
  const betaWindowHash = `sha256:${"5".repeat(64)}`;
  const report = buildClosedBetaEvidenceReport({
    paperClient: true,
    decisionAuditVerification: { valid: true, entries: 2, invalidEntryId: null },
    decisionAuditEntryHashes: [...drillHashes, betaWindowHash],
    receipts: [{ id: "receipt-1", orderId: "paper-order-1", idempotencyKey: "key-1", preview: { symbol: "BTC/USD" }, createdAt: "2026-06-26T10:30:00.000Z" }],
    events: [
      { type: "operations.backup.exported", actor: "operator@example.com", payload: {}, createdAt: "2026-06-26T10:00:00.000Z" },
      { type: "operations.kill_switch.activated", actor: "operator@example.com", payload: {}, createdAt: "2026-06-26T10:05:00.000Z" },
      { type: "operations.kill_switch.cleared", actor: "operator@example.com", payload: {}, createdAt: "2026-06-26T10:10:00.000Z" },
      ...["backup_export", "restore", "kill_switch", "incident_response"].map((drillType, index) => ({
        type: "operations.closed_beta.drill_recorded",
        actor: "operator@example.com",
        payload: {
          schemaVersion: "closed-beta-workflow-record-v1",
          recordId: `drill-record-${index}`,
          kind: "drill",
          drillType,
          outcome: "pass",
          title: `${drillType} drill`,
          reference: `local://drill/${drillType}`,
          occurredAt: `2026-06-26T10:${20 + index}:00.000Z`,
          auditEntryHash: drillHashes[index],
        },
        createdAt: `2026-06-26T10:${20 + index}:00.000Z`,
      })),
      {
        type: "operations.closed_beta.beta_window_recorded",
        actor: "operator@example.com",
        payload: {
          schemaVersion: "closed-beta-workflow-record-v1",
          recordId: "beta-window-record-1",
          kind: "beta_window",
          title: "Paper beta window",
          reference: "local://beta/window-1",
          occurredAt: "2026-06-26T11:00:00.000Z",
          startedAt: "2026-05-20T09:00:00.000Z",
          endedAt: "2026-06-26T11:00:00.000Z",
          participantCount: 3,
          auditEntryHash: betaWindowHash,
        },
        createdAt: "2026-06-26T11:00:00.000Z",
      },
    ],
    strategyRuns: [{ id: "run-1", status: "paper", config: { paperApproval: {} }, reviewCount: 1, reviewTimes: ["2026-06-26T10:40:00.000Z"] }],
    strategyDecisions: [{
      runId: "run-1",
      decision: "block",
      riskChecks: { mode: "paper", allowed: false, reasons: ["stale_data"], submittedOrder: false },
      paperOrderId: null,
      orderOutcome: "none",
      createdAt: "2026-06-26T10:45:00.000Z",
    }],
    backupMetadata: { sha256: "sha256:backup", sizeBytes: 1024, createdAt: "2026-06-26T10:00:00.000Z" },
  }, "2026-06-26T12:00:00.000Z");

  expect(report.summary).toMatchObject({ totalTargets: 8, pass: 8, fail: 0, needsEvidence: 0, readyForExitReview: true });
  expect(report.targets.find(target => target.id === "stale_data")).toMatchObject({ status: "pass" });
  expect(report.targets.find(target => target.id === "operations_drills")).toMatchObject({ status: "pass" });
  expect(report.targets.find(target => target.id === "operations_drills")?.observedEvidence).toMatchObject({
    requiredDrills: ["backup_export", "restore", "kill_switch", "incident_response"],
  });
});

test("regression: closed beta evidence fails closed when safety evidence is incomplete", () => {
  const report = buildClosedBetaEvidenceReport({
    paperClient: false,
    decisionAuditVerification: { valid: false, entries: 3, invalidEntryId: 2 },
    receipts: [
      { orderId: "paper-order-1" },
      { paperOrderId: "paper-order-2", traceId: "trace-2" },
    ],
    events: [
      { type: "operations.unauthorized.secret_access", actor: "intruder@example.com", payload: {}, createdAt: "2026-06-26T10:00:00.000Z" },
    ],
    strategyRuns: [{ id: "run-1", status: "paper", config: { paperApproval: {} }, reviewCount: 0 }],
    strategyDecisions: [
      { runId: "run-1", decision: "enter", riskChecks: { mode: "paper", allowed: true }, paperOrderId: "paper-order-1", orderOutcome: "submitted" },
      { runId: "run-1", decision: "block", riskChecks: { mode: "paper", allowed: false, reasons: ["stale_data"], submittedOrder: true }, paperOrderId: null, orderOutcome: "none" },
    ],
    backupMetadata: null,
  }, "2026-06-26T12:00:00.000Z");

  expect(report.summary).toMatchObject({ pass: 0, fail: 6, needsEvidence: 2, readyForExitReview: false });
  expect(report.summary.openTargets).toEqual([
    "paper_only_execution",
    "authorization_integrity",
    "decision_audit_validity",
    "signed_preview_coverage",
    "strategy_risk_blocks",
    "stale_data",
    "operations_drills",
    "review_cadence",
  ]);
  expect(report.targets.find(target => target.id === "signed_preview_coverage")).toMatchObject({
    status: "fail",
    actual: "2 submitted order receipts lack a usable evidence time.",
  });
  expect(report.targets.find(target => target.id === "stale_data")).toMatchObject({
    status: "fail",
    observedEvidence: { staleSubmittedCount: 1 },
  });
});

test("ordinary backup and kill-switch events do not masquerade as completed drills", () => {
  const report = buildClosedBetaEvidenceReport(
    {
      paperClient: true,
      decisionAuditVerification: {
        valid: true,
        entries: 1,
        invalidEntryId: null,
      },
      decisionAuditEntryHashes: [],
      receipts: [],
      events: [
        {
          type: "operations.backup.exported",
          actor: "operator@example.com",
          payload: {},
          createdAt: "2026-07-12T09:00:00.000Z",
        },
        {
          type: "operations.kill_switch.activated",
          actor: "operator@example.com",
          payload: {},
          createdAt: "2026-07-12T09:05:00.000Z",
        },
        {
          type: "operations.kill_switch.cleared",
          actor: "operator@example.com",
          payload: {},
          createdAt: "2026-07-12T09:10:00.000Z",
        },
      ],
      strategyRuns: [],
      strategyDecisions: [],
      backupMetadata: {
        sha256: "sha256:backup",
        sizeBytes: 1_024,
        createdAt: "2026-07-12T09:00:00.000Z",
      },
    },
    "2026-07-13T10:00:00.000Z",
  );

  expect(
    report.targets.find((target) => target.id === "operations_drills"),
  ).toMatchObject({
    status: "needs_evidence",
    observedEvidence: {
      backupExportsInWindow: 0,
      killSwitchActivationsInWindow: 0,
      killSwitchClearsInWindow: 0,
      totalBackupExports: 1,
      totalKillSwitchActivations: 1,
      totalKillSwitchClears: 1,
      drillEvidence: [
        { drillType: "backup_export", passed: false },
        { drillType: "restore", passed: false },
        { drillType: "kill_switch", passed: false },
        { drillType: "incident_response", passed: false },
      ],
    },
  });
});
