/** Promotion evidence gate for paper strategy experiments. */

type PromotionRun = {
  id: string;
  status: string;
  config?: any;
  createdAt?: string;
};
type PromotionDecision = {
  createdAt?: string;
  decision?: string;
};
type PromotionOrder = {
  status: string;
  payload?: any;
  createdAt?: string;
  updatedAt?: string;
};

export const STRATEGY_PROMOTION_MIN_PAPER_DAYS = 30;
export const STRATEGY_PROMOTION_MIN_FILLS = 20;
export const STRATEGY_PROMOTION_DEFAULT_MIN_DECISIONS = 30;

function validDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function currentProtocol(config: any) {
  return config?.experimentProtocol && typeof config.experimentProtocol === "object"
    ? config.experimentProtocol
    : null;
}

function filledOrders(orders: PromotionOrder[]) {
  return orders.filter((order) => {
    const payload = order.payload ?? {};
    const broker = payload.broker ?? {};
    return String(broker.status ?? order.status).toLowerCase() === "filled";
  });
}

function daysBetween(start: Date | null, end: Date) {
  return start ? Math.max(0, (end.getTime() - start.getTime()) / 86_400_000) : 0;
}

function check(name: string, passed: boolean, actual: unknown, required: unknown, detail: string) {
  return {
    name,
    status: passed ? "pass" as const : "needs_evidence" as const,
    actual,
    required,
    detail,
  };
}

export function buildStrategyPromotionEvidence(input: {
  run: PromotionRun;
  decisions: PromotionDecision[];
  orders: PromotionOrder[];
  reviewedAt?: string;
}) {
  const reviewedAt = validDate(input.reviewedAt) ?? new Date();
  const protocol = currentProtocol(input.run.config);
  const approval = input.run.config?.paperApproval;
  const paperStart =
    validDate(approval?.approvedAt) ??
    validDate(protocol?.startAt) ??
    validDate(input.run.createdAt);
  const paperWindowDays = daysBetween(paperStart, reviewedAt);
  const requiredDecisions = Math.max(
    STRATEGY_PROMOTION_DEFAULT_MIN_DECISIONS,
    Number(protocol?.minimumObservations) || 0,
  );
  const fillCount = filledOrders(input.orders).length;
  const decisionCount = input.decisions.length;
  const checks = [
    check(
      "paper_status",
      input.run.status === "paper",
      input.run.status,
      "paper",
      "Run must still be an active paper experiment before promotion.",
    ),
    check(
      "paper_window",
      paperWindowDays >= STRATEGY_PROMOTION_MIN_PAPER_DAYS,
      Number(paperWindowDays.toFixed(2)),
      STRATEGY_PROMOTION_MIN_PAPER_DAYS,
      "Paper experiment must run for at least 30 calendar days before promotion.",
    ),
    check(
      "decision_count",
      decisionCount >= requiredDecisions,
      decisionCount,
      requiredDecisions,
      "Paper experiment needs enough recorded decisions to evaluate behavior.",
    ),
    check(
      "fill_count",
      fillCount >= STRATEGY_PROMOTION_MIN_FILLS,
      fillCount,
      STRATEGY_PROMOTION_MIN_FILLS,
      "Paper experiment needs enough filled orders for fill-quality, attribution, and performance metrics.",
    ),
  ];
  const status = checks.every((item) => item.status === "pass")
    ? "pass"
    : "needs_evidence";
  return {
    promotionEvidenceVersion: "strategy-promotion-evidence-v1",
    status,
    reviewedAt: reviewedAt.toISOString(),
    runId: input.run.id,
    thresholds: {
      minimumPaperDays: STRATEGY_PROMOTION_MIN_PAPER_DAYS,
      minimumDecisions: requiredDecisions,
      minimumFills: STRATEGY_PROMOTION_MIN_FILLS,
    },
    observations: {
      paperStartAt: paperStart?.toISOString() ?? null,
      paperWindowDays: Number(paperWindowDays.toFixed(2)),
      decisionCount,
      filledOrders: fillCount,
      protocolHash: protocol?.protocolHash ?? null,
    },
    checks,
    warnings: checks
      .filter((item) => item.status === "needs_evidence")
      .map((item) => item.detail),
  };
}
