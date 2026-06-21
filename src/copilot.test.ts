import { expect, test } from "bun:test";
import { SIMULATION_POLICY_VERSION, type SimulationAuthority, validCopilotOutput } from "./copilot";

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
