/** Server-owned Strategy Lab paper-automation capability and lifecycle gate. */
import type { StrategyId } from "./strategy-backtest";

export const SHADOW_EVIDENCE_STRATEGY_IDS = [
  "volatility-targeted-trend",
  "donchian-atr-breakout",
  "regime-filtered-mean-reversion",
] as const satisfies readonly StrategyId[];

export const STATE_MODEL_BLOCKED_STRATEGY_IDS = [
  "time-sliced-accumulation",
  "breakout-momentum",
  "mean-reversion",
  "order-book-liquidity-scout",
] as const satisfies readonly StrategyId[];

export const PAPER_BLOCKED_STRATEGY_IDS = [
  ...SHADOW_EVIDENCE_STRATEGY_IDS,
  ...STATE_MODEL_BLOCKED_STRATEGY_IDS,
] as const satisfies readonly StrategyId[];

export const PAPER_AUTOMATION_STRATEGY_IDS = [
  "cash",
  "buy-and-hold",
  "moving-average-trend",
  "volatility-filter",
  "btc-eth-relative-strength",
] as const satisfies readonly StrategyId[];

type ReadinessRun = {
  strategyId: string;
  status: string;
  config?: any;
};

export type StrategyPaperReadiness = {
  version: "strategy-paper-readiness-v1";
  status:
    | "research_only"
    | "protocol_required"
    | "ready_for_approval"
    | "paper_active"
    | "run_state_blocked";
  code: string;
  paperAutomationSupported: boolean;
  canRegisterProtocol: boolean;
  canApprovePaper: boolean;
  retryable: boolean;
  nextAction:
    | "collect_shadow_evidence"
    | "register_experiment_protocol"
    | "refresh_strategy_run"
    | "select_shadow_or_paused_run";
  summary: string;
  reasons: string[];
};

function includes(values: readonly string[], strategyId: string) {
  return values.includes(strategyId);
}

export function strategySupportsPaperAutomation(strategyId: string) {
  return includes(PAPER_AUTOMATION_STRATEGY_IDS, strategyId);
}

export function strategyPaperReadiness(run: ReadinessRun): StrategyPaperReadiness {
  if (includes(SHADOW_EVIDENCE_STRATEGY_IDS, run.strategyId)) {
    return {
      version: "strategy-paper-readiness-v1",
      status: "research_only",
      code: "strategy_shadow_evidence_required",
      paperAutomationSupported: false,
      canRegisterProtocol: false,
      canApprovePaper: false,
      retryable: false,
      nextAction: "collect_shadow_evidence",
      summary: "Shadow evidence is required before paper automation.",
      reasons: [
        "This strategy is implemented for backtest and shadow evaluation, but prospective shadow evidence and an explicit paper experiment have not been approved.",
      ],
    };
  }
  if (includes(STATE_MODEL_BLOCKED_STRATEGY_IDS, run.strategyId)) {
    const reason =
      run.strategyId === "time-sliced-accumulation"
        ? "Historical-bar index progress does not represent durable cross-tick paper execution state."
        : run.strategyId === "order-book-liquidity-scout"
          ? "The paper runtime does not provide the order-book depth required by this strategy."
          : "The paper runtime does not reconstruct the strategy's required cross-tick entry and exit state.";
    return {
      version: "strategy-paper-readiness-v1",
      status: "research_only",
      code: "strategy_state_model_unsupported",
      paperAutomationSupported: false,
      canRegisterProtocol: false,
      canApprovePaper: false,
      retryable: false,
      nextAction: "collect_shadow_evidence",
      summary: "The strategy state model is not safe for paper automation.",
      reasons: [
        reason,
        "Paper automation remains blocked until the mismatch is corrected and directly validated.",
      ],
    };
  }
  if (!includes(PAPER_AUTOMATION_STRATEGY_IDS, run.strategyId)) {
    return {
      version: "strategy-paper-readiness-v1",
      status: "research_only",
      code: "strategy_capability_unknown",
      paperAutomationSupported: false,
      canRegisterProtocol: false,
      canApprovePaper: false,
      retryable: false,
      nextAction: "collect_shadow_evidence",
      summary: "This strategy has no reviewed paper-automation capability.",
      reasons: ["Unknown strategy capabilities fail closed."],
    };
  }
  if (run.status === "paper") {
    return {
      version: "strategy-paper-readiness-v1",
      status: "paper_active",
      code: "strategy_paper_active",
      paperAutomationSupported: true,
      canRegisterProtocol: false,
      canApprovePaper: false,
      retryable: false,
      nextAction: "refresh_strategy_run",
      summary: "A bounded paper experiment is active.",
      reasons: [],
    };
  }
  if (!["shadow", "paused"].includes(run.status)) {
    return {
      version: "strategy-paper-readiness-v1",
      status: "run_state_blocked",
      code: "strategy_run_state_conflict",
      paperAutomationSupported: true,
      canRegisterProtocol: false,
      canApprovePaper: false,
      retryable: true,
      nextAction: "select_shadow_or_paused_run",
      summary: `Paper controls are unavailable while the run is ${run.status}.`,
      reasons: ["Only shadow or paused runs can register or approve a paper experiment."],
    };
  }
  const protocol = run.config?.experimentProtocol;
  if (!protocol) {
    return {
      version: "strategy-paper-readiness-v1",
      status: "protocol_required",
      code: "strategy_protocol_required",
      paperAutomationSupported: true,
      canRegisterProtocol: true,
      canApprovePaper: false,
      retryable: true,
      nextAction: "register_experiment_protocol",
      summary: "Register a falsifiable protocol before paper approval.",
      reasons: ["A current experiment protocol is required before paper approval."],
    };
  }
  return {
    version: "strategy-paper-readiness-v1",
    status: "ready_for_approval",
    code: "strategy_ready_for_paper_approval",
    paperAutomationSupported: true,
    canRegisterProtocol: true,
    canApprovePaper: true,
    retryable: false,
    nextAction: "refresh_strategy_run",
    summary: "The protocol is registered and the run can be reviewed for paper approval.",
    reasons: [],
  };
}
