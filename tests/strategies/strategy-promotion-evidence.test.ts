import { expect, test } from "bun:test";
import { buildStrategyPromotionEvidence } from "../../backend/features/strategies/strategy-promotion-evidence";

const paperApproval = {
  approvedAt: "2026-06-01T00:00:00.000Z",
  budget: 1_000,
};
const experimentProtocol = {
  protocolHash: `sha256:${"a".repeat(64)}`,
  minimumObservations: 30,
  startAt: "2026-06-01T00:00:00.000Z",
  stopAt: "2026-07-15T00:00:00.000Z",
};

test("promotion evidence distinguishes needs_evidence from pass", () => {
  const evidence = buildStrategyPromotionEvidence({
    reviewedAt: "2026-06-15T00:00:00.000Z",
    run: {
      id: "run-young",
      status: "paper",
      config: { paperApproval, experimentProtocol },
    },
    decisions: Array.from({ length: 12 }, () => ({})),
    orders: Array.from({ length: 4 }, () => ({
      status: "filled",
      payload: { broker: { status: "filled" } },
    })),
  });

  expect(evidence).toMatchObject({
    promotionEvidenceVersion: "strategy-promotion-evidence-v1",
    status: "needs_evidence",
    thresholds: {
      minimumPaperDays: 30,
      minimumDecisions: 30,
      minimumFills: 20,
    },
    observations: {
      paperWindowDays: 14,
      decisionCount: 12,
      filledOrders: 4,
      protocolHash: experimentProtocol.protocolHash,
    },
    checks: [
      { name: "paper_status", status: "pass" },
      { name: "paper_window", status: "needs_evidence" },
      { name: "decision_count", status: "needs_evidence" },
      { name: "fill_count", status: "needs_evidence" },
    ],
  });
});

test("promotion evidence passes only after window decisions and fills meet thresholds", () => {
  const evidence = buildStrategyPromotionEvidence({
    reviewedAt: "2026-07-02T00:00:00.000Z",
    run: {
      id: "run-ready",
      status: "paper",
      config: { paperApproval, experimentProtocol },
    },
    decisions: Array.from({ length: 30 }, () => ({})),
    orders: Array.from({ length: 20 }, () => ({
      status: "accepted",
      payload: { broker: { status: "filled" } },
    })),
  });

  expect(evidence.status).toBe("pass");
  expect(evidence.warnings).toEqual([]);
  expect(evidence.checks.map((check) => check.status)).toEqual([
    "pass",
    "pass",
    "pass",
    "pass",
  ]);
});
