import { expect, test } from "bun:test";
import { applyCounterThesisReview, PortfolioQuestion, reviewedPlanAllowsOrder, SIMULATION_POLICY_VERSION, type SimulationAuthority, validCopilotOutput, validCounterThesisReview, validPortfolioQuestionOutput } from "./copilot";

const base = { symbol: "SPY", thesis: "Diversifies exposure", risk: "Can fall", invalidation: "Risk changes", confidence: 60 };
const output = (idea: object) => ({ summary: "Paper portfolio review", ideas: [idea, idea, idea] });
const simulationId = "00000000-0000-4000-8000-000000000001";
const evidenceId = `simulation:${simulationId}`;
const simulation = (overrides: Partial<SimulationAuthority> = {}): SimulationAuthority => ({
  id: simulationId,
  evidenceId,
  symbol: "SPY",
  side: "buy",
  qty: 0.1,
  status: "allowed",
  stateSnapshotId: "snapshot-1",
  policyVersion: SIMULATION_POLICY_VERSION,
  expiresAt: 2_000,
  ...overrides,
});
const actionableIdea = (overrides: object = {}) => ({
  ...base,
  action: "buy",
  suggestedQty: 0.1,
  simulationId,
  evidence: ["risk:current", evidenceId],
  ...overrides,
});

test("copilot accepts only grounded and simulated actions", () => {
  const evidence = new Set(["risk:current", evidenceId]);
  const simulations = new Map([[simulationId, simulation()]]);
  expect(validCopilotOutput(output(actionableIdea()), evidence, simulations, 1_000)).toBe(true);
  expect(validCopilotOutput(output(actionableIdea({ evidence: ["invented"] })), evidence, simulations, 1_000)).toBe(false);
  expect(validCopilotOutput(output(actionableIdea({ evidence: ["risk:current"] })), evidence, simulations, 1_000)).toBe(false);
  expect(validCopilotOutput(output({ ...base, action: "hold", suggestedQty: 1, simulationId: null, evidence: ["risk:current"] }), evidence, simulations, 1_000)).toBe(false);
  expect(validCopilotOutput(output({ ...base, action: "hold", suggestedQty: 0, simulationId: null, evidence: ["risk:current"], thesis: "Guaranteed return" }), evidence, simulations, 1_000)).toBe(false);
});

test("actionable ideas must exactly match their simulation authority", () => {
  const evidence = new Set(["risk:current", evidenceId]);
  const valid = (authority: SimulationAuthority, idea = actionableIdea()) =>
    validCopilotOutput(output(idea), evidence, new Map([[simulationId, authority]]), 1_000);

  expect(valid(simulation({ symbol: "AAPL" }))).toBe(false);
  expect(valid(simulation({ qty: 0.2 }))).toBe(false);
  expect(valid(simulation({ side: "sell" }))).toBe(false);
  expect(valid(simulation({ status: "blocked" }))).toBe(false);
  expect(valid(simulation({ expiresAt: 1_000 }))).toBe(false);
  expect(valid(simulation({ policyVersion: "old-policy" }))).toBe(false);
});

test("reduce maps to an exact sell simulation and passive ideas cannot claim one", () => {
  const evidence = new Set(["risk:current", evidenceId]);
  const sell = simulation({ side: "sell" });
  const simulations = new Map([[simulationId, sell]]);

  expect(validCopilotOutput(output(actionableIdea({ action: "reduce" })), evidence, simulations, 1_000)).toBe(true);
  expect(validCopilotOutput(output({ ...base, action: "watch", suggestedQty: 0, simulationId, evidence: ["risk:current", evidenceId] }), evidence, simulations, 1_000)).toBe(false);
});

test("portfolio Q&A accepts only bounded questions and typed-tool citations", () => {
  const evidence = new Set(["portfolio:current", "risk:current"]);
  const answer = { claims: [{ text: "AAPL is the largest position.", evidence: ["risk:current"] }], limitations: [] };
  expect(validPortfolioQuestionOutput(answer, evidence)).toBe(true);
  expect(validPortfolioQuestionOutput({ ...answer, claims: [{ ...answer.claims[0], evidence: ["invented"] }] }, evidence)).toBe(false);
  expect(validPortfolioQuestionOutput({ ...answer, claims: [{ ...answer.claims[0], text: "This is a guaranteed return." }] }, evidence)).toBe(false);
  expect(PortfolioQuestion.safeParse("What is my largest position?").success).toBe(true);
  expect(PortfolioQuestion.safeParse("x".repeat(501)).success).toBe(false);
});

test("counter-thesis review requires independent risk and symbol evidence", () => {
  const proposal = output(actionableIdea());
  const item = { symbol: "SPY", proposedAction: "buy", verdict: "approve", counterThesis: "Momentum can reverse", failureCondition: "Drawdown expands", evidence: ["risk:current", "bars:SPY:90d"] };
  const review = { summary: "Independent risk review", items: [item, item, item] };
  const evidence = new Set(["portfolio:current", "risk:current", "bars:SPY:90d"]);
  expect(validCounterThesisReview(review, proposal, evidence)).toBe(true);
  expect(validCounterThesisReview({ ...review, items: [{ ...item, evidence: ["risk:current", "invented"] }, item, item] }, proposal, evidence)).toBe(false);
  expect(validCounterThesisReview({ ...review, items: [{ ...item, evidence: ["risk:current"] }, item, item] }, proposal, evidence)).toBe(false);
  expect(validCounterThesisReview({ ...review, items: [{ ...item, proposedAction: "reduce" }, item, item] }, proposal, evidence)).toBe(false);
});

test("risk review downgrades unapproved trades and binds approved drafts exactly", () => {
  const proposal = output(actionableIdea());
  const blocked = { symbol: "SPY", proposedAction: "buy", verdict: "block", counterThesis: "Concentration is too high", failureCondition: "Risk remains above policy", evidence: ["risk:current"] };
  const approved = { ...blocked, verdict: "approve", evidence: ["risk:current", "bars:SPY:90d"] };
  const reviewed = applyCounterThesisReview(proposal, { summary: "One blocked, two approved", items: [blocked, approved, approved] }, "2026-06-29T12:00:00Z");
  expect(reviewed.ideas[0]).toMatchObject({ proposedAction: "buy", action: "watch", suggestedQty: 0, simulationId: null, actionable: false });
  expect(reviewed.ideas[1]).toMatchObject({ action: "buy", suggestedQty: 0.1, actionable: true });
  const order = { symbol: "SPY", side: "buy" as const, qty: 0.1, amountType: "quantity", type: "market", orderClass: "simple", timeInForce: "day", extendedHours: false, allowShort: false };
  expect(reviewedPlanAllowsOrder(reviewed, order)).toBe(true);
  expect(reviewedPlanAllowsOrder(reviewed, { ...order, qty: 0.2 })).toBe(false);
  expect(reviewedPlanAllowsOrder(reviewed, { ...order, type: "limit" })).toBe(false);
  expect(reviewedPlanAllowsOrder({ ...reviewed, ideas: reviewed.ideas.map(idea => idea.actionable ? { ...idea, riskReview: { ...idea.riskReview, symbol: "QQQ" } } : idea) }, order)).toBe(false);
});
