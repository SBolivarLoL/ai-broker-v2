/**
 * Produces release-readiness evidence for compliance, security, reliability,
 * and operational ownership without claiming automated legal approval.
 */
export type ComplianceReviewDomain = {
  id: string;
  name: string;
  status: "implemented_for_paper" | "requires_external_legal_review" | "blocked_until_live_review";
  currentControls: string[];
  requiredBeforeLive: string[];
  evidenceUrls: string[];
};

export type ClosedBetaSafetyTarget = {
  id: string;
  metric: string;
  target: string;
  evidence: string;
};

export type LiveTradingGate = {
  requested: boolean;
  reviewId: string | null;
  available: false;
  reason: string;
  hardBlockers: string[];
  requiredEvidence: string[];
};

export type DisabledCryptoCapability = {
  id: "crypto_transfers" | "crypto_perpetual_leverage" | "crypto_tokenization";
  name: string;
  available: false;
  status: "disabled_until_separate_approval";
  reason: string;
  requiredApproval: string[];
};

export type CryptoCapabilityDecision = {
  id: string;
  allowed: false;
  reason: string;
  requiredApproval: string[];
};

export type ProductionGovernanceReport = {
  generatedAt: string;
  scope: {
    executionMode: "paper_only";
    brokerClient: "alpaca_trading_api_paper";
    legalAdvice: false;
    liveTradingAvailable: false;
  };
  complianceReview: ComplianceReviewDomain[];
  closedBeta: {
    mode: "paper_accounts_only";
    minimumDurationDays: number;
    maximumParticipants: number;
    safetyTargets: ClosedBetaSafetyTarget[];
    exitCriteria: string[];
  };
  cryptoCapabilityBoundary: {
    mode: "separately_approved_only";
    paperCapabilities: string[];
    disabledCapabilities: DisabledCryptoCapability[];
    defaultDecision: "deny";
  };
  liveTradingGate: LiveTradingGate;
  summary: {
    complianceDomains: number;
    domainsRequiringExternalReview: string[];
    closedBetaTargets: number;
    openBlockers: string[];
  };
  runbook: string[];
};

export type ClosedBetaEvidenceStatus = "pass" | "fail" | "needs_evidence";

export type ClosedBetaEvidenceTarget = ClosedBetaSafetyTarget & {
  status: ClosedBetaEvidenceStatus;
  actual: string;
  observedEvidence: Record<string, unknown>;
};

export type ClosedBetaEvidenceInput = {
  paperClient: boolean;
  decisionAuditVerification: { valid: boolean; entries: number; invalidEntryId: number | null };
  receipts: Record<string, unknown>[];
  events: { type: string; actor: string; payload: unknown; createdAt: string }[];
  strategyRuns: { id: string; status: string; config: Record<string, unknown>; reviewCount: number }[];
  strategyDecisions: {
    runId: string;
    decision: string;
    riskChecks: Record<string, unknown>;
    paperOrderId?: string | null;
    orderOutcome?: string | null;
  }[];
  backupMetadata: { sha256: string; sizeBytes: number; createdAt: string } | null;
};

export type ClosedBetaEvidenceReport = {
  generatedAt: string;
  mode: "paper_accounts_only";
  targetWindowDays: number;
  targets: ClosedBetaEvidenceTarget[];
  summary: {
    totalTargets: number;
    pass: number;
    fail: number;
    needsEvidence: number;
    readyForExitReview: boolean;
    openTargets: string[];
  };
  runbook: string[];
};

const COMPLIANCE_REVIEW: ComplianceReviewDomain[] = [
  {
    id: "investment_advice_boundary",
    name: "Advice, recommendations and personalization boundary",
    status: "requires_external_legal_review",
    currentControls: [
      "Agents can research, explain and draft ideas, but cannot place orders.",
      "Actionable orders pass through deterministic preview, signed approval, fresh revalidation and receipt storage.",
      "Strategy output is labeled experimental evidence and is compared against baselines instead of presented as live edge.",
    ],
    requiredBeforeLive: [
      "External counsel review of whether app output creates regulated investment advice, broker-dealer recommendations, adviser activity or user-specific suitability duties.",
      "Approved user disclosures covering scope, monitoring frequency, limitations, conflicts, fees/costs and risks.",
      "A reviewed process for handling user profile, objective, time-horizon, liquidity, tax and risk-tolerance inputs before personalized recommendations.",
    ],
    evidenceUrls: [
      "https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/regulation-best-interest",
      "https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/investor-56",
      "https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-45",
    ],
  },
  {
    id: "execution_controls",
    name: "Execution controls and order supervision",
    status: "implemented_for_paper",
    currentControls: [
      "All manual, option, basket, crypto and strategy paper orders use signed previews and fresh confirmation checks.",
      "Global operations policy enforces kill switch, order notional, exposure and turnover caps across execution surfaces.",
      "Broker order reconciliation, order receipts and decision-audit chain preserve execution evidence.",
    ],
    requiredBeforeLive: [
      "Independent review of live order types, cancel/replace behavior, idempotency recovery, account eligibility and market-session edge cases.",
      "Production incident-response drill for failed submissions, broker outages, duplicated client order ids and reconciliation drift.",
      "Written live-order supervision and exception review process.",
    ],
    evidenceUrls: [
      "https://docs.alpaca.markets/us/docs/orders-at-alpaca",
      "https://www.finra.org/rules-guidance/key-topics/algorithmic-trading",
    ],
  },
  {
    id: "crypto_disclosures",
    name: "Crypto-specific disclosures and asset-class limits",
    status: "requires_external_legal_review",
    currentControls: [
      "Crypto automation is paper-only, bounded by explicit run-level approval, stale-data gates and 24/7 session handling.",
      "Transfers, wallets, leverage, perpetual futures, funding flows and tokenized assets remain unavailable.",
      "Backtests and paper runs expose fees, spread, slippage, latency, missed-fill and liquidity assumptions.",
    ],
    requiredBeforeLive: [
      "External legal review of crypto product availability, jurisdiction, risk disclosures, custody/funding exclusions and marketing language.",
      "Approved disclosure that paper crypto fills do not prove live fill quality, queue position, price improvement, fee impact or market impact.",
      "Venue/data-subscription review for crypto bars, quotes, trades and order books used in live decisioning.",
    ],
    evidenceUrls: [
      "https://www.investor.gov/additional-resources/spotlight/crypto-assets",
      "https://docs.alpaca.markets/us/docs/crypto-pricing-data",
    ],
  },
  {
    id: "automated_strategy_controls",
    name: "Automated strategy controls",
    status: "blocked_until_live_review",
    currentControls: [
      "Strategies start as backtests and shadow runs, then require explicit run-level approval for paper automation.",
      "Paper strategy orders are blocked by stale data, expired approval, cash/buying-power, loss, drawdown, turnover, spread and error-cooldown gates.",
      "Every strategy decision stores inputs, features, thresholds, risk checks, order evidence, receipts, spans and metrics.",
    ],
    requiredBeforeLive: [
      "Closed-beta evidence that strategy decisions remain reconstructable and bounded over the review period.",
      "Separate live-trading architecture review for scheduling, broker throttling, stop controls, deployment rollback and exception escalation.",
      "External compliance review of automated trading supervision, testing, code-change approval and post-deployment surveillance.",
    ],
    evidenceUrls: [
      "https://www.finra.org/rules-guidance/key-topics/algorithmic-trading",
    ],
  },
  {
    id: "communications_records",
    name: "Communications, records and retention",
    status: "implemented_for_paper",
    currentControls: [
      "Decision receipts, agent plans, strategy decisions and strategy audits are appended to hash-chained records.",
      "Operations exports include observability, incident packet, decision-audit verification and database backup evidence.",
      "Secret-vault reads return metadata only; plaintext credentials are not exposed through the API.",
    ],
    requiredBeforeLive: [
      "Retention schedule review for account records, communications, receipts, model outputs and incident evidence.",
      "Disclosure and marketing review for UI text, exports, reports, strategy labels and performance claims.",
      "Backup restore drill and access-control review for production evidence exports.",
    ],
    evidenceUrls: [
      "https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/regulation-best-interest",
    ],
  },
];

const DISABLED_CRYPTO_CAPABILITIES: DisabledCryptoCapability[] = [
  {
    id: "crypto_transfers",
    name: "Crypto wallets, transfers and whitelisted addresses",
    available: false,
    status: "disabled_until_separate_approval",
    reason: "Wallet movement, custody and funding flows are outside the personal paper-trading scope.",
    requiredApproval: ["custody_security_review", "funding_fraud_controls", "external_legal_compliance_signoff"],
  },
  {
    id: "crypto_perpetual_leverage",
    name: "Crypto perpetual futures, leverage and funding-rate execution",
    available: false,
    status: "disabled_until_separate_approval",
    reason: "Perpetuals and leverage require venue-level risk controls, liquidation modeling and a separate product review.",
    requiredApproval: ["leverage_risk_model", "venue_microstructure_review", "external_legal_compliance_signoff"],
  },
  {
    id: "crypto_tokenization",
    name: "Tokenized products and synthetic crypto assets",
    available: false,
    status: "disabled_until_separate_approval",
    reason: "Tokenized products are not part of the approved broker capability set for this paper account.",
    requiredApproval: ["asset_availability_review", "jurisdiction_review", "external_legal_compliance_signoff"],
  },
];

const CLOSED_BETA_TARGETS: ClosedBetaSafetyTarget[] = [
  {
    id: "paper_only_execution",
    metric: "Live order submissions",
    target: "0 live orders; all broker submissions must use the Alpaca paper client.",
    evidence: "Operational readiness, order receipts and broker client configuration.",
  },
  {
    id: "authorization_integrity",
    metric: "Unauthorized privileged operations",
    target: "0 successful privileged operations without the required role.",
    evidence: "Auth tests, operations events and secret/backup access logs.",
  },
  {
    id: "decision_audit_validity",
    metric: "Decision audit verification",
    target: "100% valid hash-chain verification for manual receipts, agent plans and strategy receipts.",
    evidence: "GET /api/decision-audit and GET /api/operations/observability-export.",
  },
  {
    id: "signed_preview_coverage",
    metric: "Submitted orders with signed fresh preview evidence",
    target: "100% of submitted paper orders have a receipt linked to signed preview or strategy decision evidence.",
    evidence: "Receipt export, strategy trace API and order reconciliation metadata.",
  },
  {
    id: "strategy_risk_blocks",
    metric: "Required risk gates active",
    target: "100% of paper strategy ticks evaluate stale-data, spread, approval, budget, loss, drawdown, turnover and kill-switch gates.",
    evidence: "Strategy decision traces and strategy metrics.",
  },
  {
    id: "stale_data",
    metric: "Unblocked stale-data strategy submissions",
    target: "0 strategy paper submissions when the decision snapshot is stale.",
    evidence: "Strategy decision traces filtered by stale_data and submittedOrder.",
  },
  {
    id: "operations_drills",
    metric: "Operational readiness drill",
    target: "At least one backup export, incident packet export, kill-switch activation/clear drill and restore checklist review during beta.",
    evidence: "GET /api/operations/readiness, POST /api/operations/backup and event log.",
  },
  {
    id: "review_cadence",
    metric: "Experiment review coverage",
    target: "Every approved paper strategy run has a continue, pause, retire, revise or promote review note before beta exit.",
    evidence: "Strategy experiment report export.",
  },
];

function target(id: string) {
  const item = CLOSED_BETA_TARGETS.find(record => record.id === id);
  if (!item) throw new Error(`Unknown closed beta target: ${id}`);
  return item;
}

function measuredTarget(id: string, status: ClosedBetaEvidenceStatus, actual: string, observedEvidence: Record<string, unknown>): ClosedBetaEvidenceTarget {
  return { ...target(id), status, actual, observedEvidence };
}

function eventCount(input: ClosedBetaEvidenceInput, type: string) {
  return input.events.filter(event => event.type === type).length;
}

function riskReasons(value: Record<string, unknown>) {
  return Array.isArray(value.reasons) ? value.reasons.map(reason => String(reason)) : [];
}

function isPaperStrategyDecision(decision: ClosedBetaEvidenceInput["strategyDecisions"][number]) {
  return decision.riskChecks.mode === "paper" || Boolean(decision.paperOrderId) || Boolean(decision.riskChecks.submittedOrder);
}

export function evaluateCryptoCapabilityRequest(id: string): CryptoCapabilityDecision {
  const capability = DISABLED_CRYPTO_CAPABILITIES.find(item => item.id === id);
  if (capability) return { id: capability.id, allowed: false, reason: capability.reason, requiredApproval: capability.requiredApproval };
  return {
    id,
    allowed: false,
    reason: "Unknown crypto capabilities fail closed until they are added to the production-governance boundary.",
    requiredApproval: ["explicit_capability_record", "external_legal_compliance_signoff"],
  };
}

function receiptLooksLikeSubmittedOrder(receipt: Record<string, unknown>) {
  return Boolean(receipt.orderId || receipt.orderIds || receipt.paperOrderId || receipt.idempotencyKey || receipt.kind === "strategy_paper_decision");
}

function receiptHasSignedEvidence(receipt: Record<string, unknown>) {
  return Boolean(receipt.preview || receipt.originalPreview || receipt.traceId || receipt.kind === "strategy_paper_decision");
}

export function buildClosedBetaEvidenceReport(input: ClosedBetaEvidenceInput, generatedAt = new Date().toISOString()): ClosedBetaEvidenceReport {
  const orderReceipts = input.receipts.filter(receiptLooksLikeSubmittedOrder);
  const signedOrderReceipts = orderReceipts.filter(receiptHasSignedEvidence);
  const paperStrategyDecisions = input.strategyDecisions.filter(isPaperStrategyDecision);
  const paperStrategyDecisionsWithRiskEvidence = paperStrategyDecisions.filter(decision => typeof decision.riskChecks.allowed === "boolean" && Array.isArray(decision.riskChecks.reasons));
  const staleSubmitted = paperStrategyDecisions.filter(decision => riskReasons(decision.riskChecks).includes("stale_data") && (decision.riskChecks.submittedOrder === true || Boolean(decision.paperOrderId)));
  const approvedPaperRuns = input.strategyRuns.filter(run => run.status === "paper" || Boolean(run.config.paperApproval));
  const reviewedPaperRuns = approvedPaperRuns.filter(run => run.reviewCount > 0);
  const backupExports = eventCount(input, "operations.backup.exported");
  const killSwitchActivations = eventCount(input, "operations.kill_switch.activated");
  const killSwitchClears = eventCount(input, "operations.kill_switch.cleared");
  const unauthorizedSuccesses = input.events.filter(event => /unauthorized|forbidden/i.test(event.type) && !/blocked|rejected|failed/i.test(event.type));
  const targets = [
    measuredTarget(
      "paper_only_execution",
      input.paperClient ? "pass" : "fail",
      input.paperClient ? "Broker client reports paper-only execution mode." : "Broker client is not confirmed paper-only.",
      { paperClient: input.paperClient, orderReceiptCount: orderReceipts.length },
    ),
    measuredTarget(
      "authorization_integrity",
      unauthorizedSuccesses.length ? "fail" : input.events.length ? "pass" : "needs_evidence",
      unauthorizedSuccesses.length ? `${unauthorizedSuccesses.length} suspicious privileged auth events need review.` : input.events.length ? "No successful unauthorized privileged operation events were found." : "No operations event history is available yet.",
      { checkedEvents: input.events.length, suspiciousEvents: unauthorizedSuccesses.map(event => ({ type: event.type, createdAt: event.createdAt, actor: event.actor })) },
    ),
    measuredTarget(
      "decision_audit_validity",
      input.decisionAuditVerification.entries ? input.decisionAuditVerification.valid ? "pass" : "fail" : "needs_evidence",
      input.decisionAuditVerification.entries ? `${input.decisionAuditVerification.entries} decision-audit entries verified.` : "No decision-audit entries have been recorded yet.",
      { verification: input.decisionAuditVerification },
    ),
    measuredTarget(
      "signed_preview_coverage",
      orderReceipts.length ? signedOrderReceipts.length === orderReceipts.length ? "pass" : "fail" : "needs_evidence",
      orderReceipts.length ? `${signedOrderReceipts.length}/${orderReceipts.length} submitted order receipts have preview or trace evidence.` : "No submitted order receipts have been recorded yet.",
      { orderReceiptCount: orderReceipts.length, signedEvidenceCount: signedOrderReceipts.length },
    ),
    measuredTarget(
      "strategy_risk_blocks",
      paperStrategyDecisions.length ? paperStrategyDecisionsWithRiskEvidence.length === paperStrategyDecisions.length ? "pass" : "fail" : "needs_evidence",
      paperStrategyDecisions.length ? `${paperStrategyDecisionsWithRiskEvidence.length}/${paperStrategyDecisions.length} paper strategy decisions include persisted risk-check evidence.` : "No paper strategy decisions have been recorded yet.",
      { paperStrategyDecisionCount: paperStrategyDecisions.length, withRiskEvidence: paperStrategyDecisionsWithRiskEvidence.length },
    ),
    measuredTarget(
      "stale_data",
      paperStrategyDecisions.length ? staleSubmitted.length ? "fail" : "pass" : "needs_evidence",
      paperStrategyDecisions.length ? `${staleSubmitted.length} stale-data decisions submitted a paper order.` : "No paper strategy decisions have been recorded yet.",
      { staleSubmittedCount: staleSubmitted.length, checkedPaperStrategyDecisions: paperStrategyDecisions.length },
    ),
    measuredTarget(
      "operations_drills",
      backupExports > 0 && killSwitchActivations > 0 && killSwitchClears > 0 && input.backupMetadata ? "pass" : "needs_evidence",
      `Backup exports: ${backupExports}; kill-switch activations: ${killSwitchActivations}; kill-switch clears: ${killSwitchClears}.`,
      { backupExports, killSwitchActivations, killSwitchClears, latestBackup: input.backupMetadata },
    ),
    measuredTarget(
      "review_cadence",
      approvedPaperRuns.length ? reviewedPaperRuns.length === approvedPaperRuns.length ? "pass" : "fail" : "needs_evidence",
      approvedPaperRuns.length ? `${reviewedPaperRuns.length}/${approvedPaperRuns.length} approved paper strategy runs have review notes.` : "No approved paper strategy runs have been recorded yet.",
      { approvedPaperRuns: approvedPaperRuns.map(run => ({ id: run.id, status: run.status, reviewCount: run.reviewCount })), reviewedPaperRunCount: reviewedPaperRuns.length },
    ),
  ];
  const summary = {
    totalTargets: targets.length,
    pass: targets.filter(item => item.status === "pass").length,
    fail: targets.filter(item => item.status === "fail").length,
    needsEvidence: targets.filter(item => item.status === "needs_evidence").length,
    readyForExitReview: targets.every(item => item.status === "pass"),
    openTargets: targets.filter(item => item.status !== "pass").map(item => item.id),
  };
  return {
    generatedAt,
    mode: "paper_accounts_only",
    targetWindowDays: 30,
    targets,
    summary,
    runbook: [
      "Run the paper beta long enough for each target to collect real local evidence.",
      "Investigate any fail status before adding participants or approving more strategy paper runs.",
      "A needs_evidence status is not a pass; export fresh receipts, decisions, metrics, operations events and backup evidence.",
      "Use this measured report alongside the production-governance packet; it does not replace external legal/compliance review.",
    ],
  };
}

export function buildProductionGovernanceReport(env: Record<string, string | undefined> = process.env, generatedAt = new Date().toISOString()): ProductionGovernanceReport {
  const liveRequested = env.LIVE_TRADING_ENABLED === "true";
  const reviewId = env.LIVE_TRADING_REVIEW_ID?.trim() || null;
  const domainsRequiringExternalReview = COMPLIANCE_REVIEW
    .filter(domain => domain.status !== "implemented_for_paper")
    .map(domain => domain.id);
  const hardBlockers = [
    "paper_client_hardcoded",
    "external_legal_compliance_signoff",
    "closed_beta_evidence",
    "live_trading_deployment_review",
    "data_entitlement_review",
  ];
  return {
    generatedAt,
    scope: {
      executionMode: "paper_only",
      brokerClient: "alpaca_trading_api_paper",
      legalAdvice: false,
      liveTradingAvailable: false,
    },
    complianceReview: COMPLIANCE_REVIEW,
    closedBeta: {
      mode: "paper_accounts_only",
      minimumDurationDays: 30,
      maximumParticipants: 5,
      safetyTargets: CLOSED_BETA_TARGETS,
      exitCriteria: [
        "All required safety targets have explicit evidence attached to a beta report.",
        "No unresolved critical or high severity incident remains open.",
        "External legal/compliance review has accepted, rejected or rewritten the advice, execution, crypto and automation controls.",
        "Live trading remains disabled unless a separate deployment review creates and approves a new gate.",
      ],
    },
    cryptoCapabilityBoundary: {
      mode: "separately_approved_only",
      paperCapabilities: [
        "crypto_market_data",
        "crypto_spot_paper_order_tickets",
        "crypto_strategy_shadow_runs",
        "crypto_strategy_paper_orders",
      ],
      disabledCapabilities: DISABLED_CRYPTO_CAPABILITIES,
      defaultDecision: "deny",
    },
    liveTradingGate: {
      requested: liveRequested,
      reviewId,
      available: false,
      reason: "Live trading is intentionally unavailable: the Alpaca client is constructed in paper mode and live promotion requires a separate legal, compliance, data, operational and deployment review.",
      hardBlockers,
      requiredEvidence: [
        "External legal/compliance signoff for advice, execution, crypto disclosures and automated strategy controls.",
        "Closed-beta report proving safety targets with paper accounts.",
        "Data entitlement and subscription review for every live decision input.",
        "Production incident-response, backup-restore and broker-reconciliation drills.",
        "A new reviewed deployment mode that does not reuse paper-only assumptions.",
      ],
    },
    summary: {
      complianceDomains: COMPLIANCE_REVIEW.length,
      domainsRequiringExternalReview,
      closedBetaTargets: CLOSED_BETA_TARGETS.length,
      openBlockers: [...new Set([...domainsRequiringExternalReview, ...hardBlockers])],
    },
    runbook: [
      "Export data-governance, production-governance, observability and incident packets before each beta review.",
      "Treat legal/compliance review as external approval; do not mark it complete from code evidence alone.",
      "Keep beta paper-only and record every exception, rejected order, stale-data block, kill-switch drill and strategy review note.",
      "Create a separate live-trading deployment plan only after paper beta evidence, data entitlements and external review are accepted.",
    ],
  };
}
