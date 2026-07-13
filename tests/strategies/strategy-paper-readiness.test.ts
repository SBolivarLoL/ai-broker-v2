import { expect, test } from "bun:test";
import {
  PAPER_BLOCKED_STRATEGY_IDS,
  strategyPaperReadiness,
  strategySupportsPaperAutomation,
} from "../../backend/features/strategies/strategy-paper-readiness";

test("paper capability fails closed for evidence and state-model gaps", () => {
  expect(PAPER_BLOCKED_STRATEGY_IDS).toEqual([
    "volatility-targeted-trend",
    "donchian-atr-breakout",
    "regime-filtered-mean-reversion",
    "time-sliced-accumulation",
    "breakout-momentum",
    "mean-reversion",
    "order-book-liquidity-scout",
  ]);
  for (const strategyId of PAPER_BLOCKED_STRATEGY_IDS)
    expect(strategySupportsPaperAutomation(strategyId)).toBe(false);
  for (const strategyId of [
    "cash",
    "buy-and-hold",
    "moving-average-trend",
    "volatility-filter",
    "btc-eth-relative-strength",
  ])
    expect(strategySupportsPaperAutomation(strategyId)).toBe(true);
  expect(strategySupportsPaperAutomation("unknown-strategy")).toBe(false);
});

test("paper readiness derives protocol controls from server state", () => {
  expect(
    strategyPaperReadiness({
      strategyId: "volatility-targeted-trend",
      status: "shadow",
      config: {},
    }),
  ).toMatchObject({
    status: "research_only",
    code: "strategy_shadow_evidence_required",
    paperAutomationSupported: false,
    canRegisterProtocol: false,
    canApprovePaper: false,
    nextAction: "collect_shadow_evidence",
  });
  expect(
    strategyPaperReadiness({
      strategyId: "moving-average-trend",
      status: "shadow",
      config: {},
    }),
  ).toMatchObject({
    status: "protocol_required",
    canRegisterProtocol: true,
    canApprovePaper: false,
    nextAction: "register_experiment_protocol",
  });
  expect(
    strategyPaperReadiness({
      strategyId: "moving-average-trend",
      status: "paused",
      config: { experimentProtocol: { protocolHash: "sha256:test" } },
    }),
  ).toMatchObject({
    status: "ready_for_approval",
    canRegisterProtocol: true,
    canApprovePaper: true,
  });
  expect(
    strategyPaperReadiness({
      strategyId: "moving-average-trend",
      status: "retired",
      config: {},
    }),
  ).toMatchObject({
    status: "run_state_blocked",
    retryable: true,
    nextAction: "select_shadow_or_paused_run",
  });
  expect(
    strategyPaperReadiness({
      strategyId: "moving-average-trend",
      status: "paper",
      config: { experimentProtocol: {} },
    }),
  ).toMatchObject({
    status: "paper_active",
    code: "strategy_paper_active",
    canRegisterProtocol: false,
    canApprovePaper: false,
  });
  expect(
    strategyPaperReadiness({
      strategyId: "unknown-strategy",
      status: "shadow",
      config: {},
    }),
  ).toMatchObject({
    status: "research_only",
    code: "strategy_capability_unknown",
    paperAutomationSupported: false,
  });
});
