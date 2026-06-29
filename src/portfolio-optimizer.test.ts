import { expect, test } from "bun:test";
import { buildPortfolioOptimizerReport } from "./portfolio-optimizer";

const trend = (start: number, step: number, length = 80) => Array.from({ length }, (_, index) => start + step * index);
const choppy = (start: number, length = 80) => Array.from({ length }, (_, index) => start + (index % 2 ? 8 : -8) + index * 0.1);

test("risk parity gives less weight to the noisier holding and respects caps", () => {
  const report = buildPortfolioOptimizerReport({
    equity: 100_000,
    positions: [
      { symbol: "CALM", marketValue: 50_000, closes: trend(100, 0.2) },
      { symbol: "JUMP", marketValue: 50_000, closes: choppy(100) },
    ],
    request: { maxWeightPercent: 60, maxTurnoverPercent: 100, cashReservePercent: 0, minObservations: 30 },
  });
  const riskParity = report.proposals.find(proposal => proposal.id === "risk_parity")!;
  const calm = riskParity.weights.find(row => row.symbol === "CALM")!;
  const jump = riskParity.weights.find(row => row.symbol === "JUMP")!;
  expect(calm.targetWeightPercent).toBeGreaterThan(jump.targetWeightPercent);
  expect(riskParity.maxPositionWeightPercent).toBeLessThanOrEqual(60);
  expect(riskParity.targetDraft).toContain("CALM");
});

test("mean-variance tilt favors the better shrunk return-to-variance score", () => {
  const report = buildPortfolioOptimizerReport({
    equity: 100_000,
    positions: [
      { symbol: "UP", marketValue: 50_000, closes: trend(100, 0.9) },
      { symbol: "NOISY", marketValue: 50_000, closes: choppy(100) },
    ],
    request: { maxWeightPercent: 80, maxTurnoverPercent: 100, cashReservePercent: 0, minObservations: 30 },
  });
  const meanVariance = report.proposals.find(proposal => proposal.id === "mean_variance")!;
  expect(meanVariance.weights.find(row => row.symbol === "UP")!.targetWeightPercent).toBeGreaterThan(meanVariance.weights.find(row => row.symbol === "NOISY")!.targetWeightPercent);
});

test("turnover scaling keeps proposals inside the turnover budget", () => {
  const report = buildPortfolioOptimizerReport({
    equity: 100_000,
    positions: [
      { symbol: "A", marketValue: 90_000, closes: choppy(100) },
      { symbol: "B", marketValue: 10_000, closes: trend(100, 0.2) },
    ],
    request: { maxWeightPercent: 90, maxTurnoverPercent: 5, cashReservePercent: 0, minObservations: 30 },
  });
  for (const proposal of report.proposals) {
    expect(proposal.turnoverPercent).toBeLessThanOrEqual(5.0001);
    expect(proposal.bindingConstraints).toContain("turnover_budget");
  }
});

test("omits holdings without enough shared return history", () => {
  const report = buildPortfolioOptimizerReport({
    equity: 100_000,
    positions: [{ symbol: "NEW", marketValue: 20_000, closes: [10, 11, 12] }],
    request: { minObservations: 30 },
  });
  expect(report.proposals).toHaveLength(0);
  expect(report.coverage.omittedSymbols).toEqual(["NEW"]);
  expect(report.warnings[0]).toContain("NEW");
});
