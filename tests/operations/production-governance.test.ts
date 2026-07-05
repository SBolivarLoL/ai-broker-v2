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
  const report = buildClosedBetaEvidenceReport({
    paperClient: true,
    decisionAuditVerification: { valid: true, entries: 2, invalidEntryId: null },
    receipts: [{ id: "receipt-1", orderId: "paper-order-1", idempotencyKey: "key-1", preview: { symbol: "BTC/USD" } }],
    events: [
      { type: "operations.backup.exported", actor: "operator@example.com", payload: {}, createdAt: "2026-06-26T10:00:00.000Z" },
      { type: "operations.kill_switch.activated", actor: "operator@example.com", payload: {}, createdAt: "2026-06-26T10:05:00.000Z" },
      { type: "operations.kill_switch.cleared", actor: "operator@example.com", payload: {}, createdAt: "2026-06-26T10:10:00.000Z" },
    ],
    strategyRuns: [{ id: "run-1", status: "paper", config: { paperApproval: {} }, reviewCount: 1 }],
    strategyDecisions: [{
      runId: "run-1",
      decision: "block",
      riskChecks: { mode: "paper", allowed: false, reasons: ["stale_data"], submittedOrder: false },
      paperOrderId: null,
      orderOutcome: "none",
    }],
    backupMetadata: { sha256: "sha256:backup", sizeBytes: 1024, createdAt: "2026-06-26T10:00:00.000Z" },
  }, "2026-06-26T12:00:00.000Z");

  expect(report.summary).toMatchObject({ totalTargets: 8, pass: 8, fail: 0, needsEvidence: 0, readyForExitReview: true });
  expect(report.targets.find(target => target.id === "stale_data")).toMatchObject({ status: "pass" });
  expect(report.targets.find(target => target.id === "operations_drills")).toMatchObject({ status: "pass" });
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

  expect(report.summary).toMatchObject({ pass: 0, fail: 7, needsEvidence: 1, readyForExitReview: false });
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
    actual: "1/2 submitted order receipts have preview or trace evidence.",
  });
  expect(report.targets.find(target => target.id === "stale_data")).toMatchObject({
    status: "fail",
    observedEvidence: { staleSubmittedCount: 1 },
  });
});
