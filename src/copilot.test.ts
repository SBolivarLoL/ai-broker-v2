import { expect, test } from "bun:test";
import { validCopilotOutput } from "./copilot";

const base = { symbol: "SPY", thesis: "Diversifies exposure", risk: "Can fall", invalidation: "Risk changes", confidence: 60 };
const output = (idea: object) => ({ summary: "Paper portfolio review", ideas: [idea, idea, idea] });

test("copilot accepts only grounded and simulated actions", () => {
  const evidence = new Set(["risk:current", "simulation:SPY:buy:0.1"]);
  const allowed = new Set(["simulation:SPY:buy:0.1"]);
  expect(validCopilotOutput(output({ ...base, action: "buy", suggestedQty: 0.1, evidence: ["risk:current", "simulation:SPY:buy:0.1"] }), evidence, allowed)).toBe(true);
  expect(validCopilotOutput(output({ ...base, action: "buy", suggestedQty: 0.1, evidence: ["invented"] }), evidence, allowed)).toBe(false);
  expect(validCopilotOutput(output({ ...base, action: "buy", suggestedQty: 0.1, evidence: ["risk:current"] }), evidence, allowed)).toBe(false);
  expect(validCopilotOutput(output({ ...base, action: "hold", suggestedQty: 1, evidence: ["risk:current"] }), evidence, allowed)).toBe(false);
  expect(validCopilotOutput(output({ ...base, action: "hold", suggestedQty: 0, evidence: ["risk:current"], thesis: "Guaranteed return" }), evidence, allowed)).toBe(false);
});
