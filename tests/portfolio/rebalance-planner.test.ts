import { expect, test } from "bun:test";
import { buildConstrainedRebalancePlan, ConstrainedRebalancePlanRequest } from "../../backend/features/portfolio/rebalance-planner";

const asOf = "2026-06-29T12:00:00.000Z";

test("scales target deltas to the remaining turnover budget", () => {
  const plan = buildConstrainedRebalancePlan({
    asOf,
    account: { equity: 100_000, cash: 20_000 },
    positions: [
      { symbol: "AAPL", qty: 400, marketValue: 40_000, price: 100, fractionable: true },
      { symbol: "MSFT", qty: 400, marketValue: 40_000, price: 100, fractionable: true },
    ],
    market: [{ symbol: "AAPL", price: 100, fractionable: true }, { symbol: "MSFT", price: 100, fractionable: true }],
    request: { targets: [{ symbol: "AAPL", targetWeightPercent: 20 }, { symbol: "MSFT", targetWeightPercent: 60 }], maxTurnoverPercent: 10 },
    policyMaxTurnoverPercent: 10,
  });
  expect(plan.scales.turnoverScale).toBe(0.25);
  expect(plan.summary.plannedTurnoverNotional).toBe(10_000);
  expect(plan.legs).toMatchObject([{ symbol: "AAPL", side: "sell", quantity: 50 }, { symbol: "MSFT", side: "buy", quantity: 50 }]);
});

test("limits buys to current cash after fees without using sell proceeds", () => {
  const plan = buildConstrainedRebalancePlan({
    asOf,
    account: { equity: 100_000, cash: 1_000 },
    positions: [],
    market: [{ symbol: "AAPL", price: 100, fractionable: true }],
    request: { targets: [{ symbol: "AAPL", targetWeightPercent: 10 }], maxTurnoverPercent: 20, feeBps: 10, cashBufferPercent: 0 },
    policyMaxTurnoverPercent: 20,
  });
  expect(plan.scales.buyScale).toBeLessThan(0.1);
  expect(plan.summary.buyNotional + plan.summary.feeEstimate).toBeLessThanOrEqual(1_000);
  expect(plan.legs[0]).toMatchObject({ symbol: "AAPL", side: "buy" });
});

test("uses binary-search FIFO tax scaling for a max estimated tax", () => {
  const plan = buildConstrainedRebalancePlan({
    asOf,
    account: { equity: 100_000, cash: 80_000 },
    positions: [{ symbol: "AAPL", qty: 100, marketValue: 20_000, price: 200, fractionable: true }],
    market: [{ symbol: "AAPL", price: 200, fractionable: true }],
    openLots: [
      { symbol: "AAPL", quantity: 50, price: 100, acquiredAt: "2024-01-01T00:00:00.000Z" },
      { symbol: "AAPL", quantity: 50, price: 180, acquiredAt: "2026-01-01T00:00:00.000Z" },
    ],
    taxLotsComplete: true,
    request: {
      targets: [{ symbol: "AAPL", targetWeightPercent: 0 }],
      maxTurnoverPercent: 100,
      longTermTaxRatePercent: 20,
      shortTermTaxRatePercent: 40,
      maxEstimatedTax: 700,
    },
    policyMaxTurnoverPercent: 100,
  });
  expect(plan.bindingConstraints).toContain("tax_cap");
  expect(plan.tax.estimatedTax).toBeLessThanOrEqual(700);
  expect(plan.legs[0]?.quantity).toBeCloseTo(35, 3);
});

test("does not claim a tax-capped plan is valid when lot coverage is incomplete", () => {
  const plan = buildConstrainedRebalancePlan({
    asOf,
    account: { equity: 100_000, cash: 80_000 },
    positions: [{ symbol: "AAPL", qty: 100, marketValue: 20_000, price: 200, fractionable: true }],
    market: [{ symbol: "AAPL", price: 200, fractionable: true }],
    openLots: [],
    taxLotsComplete: false,
    request: { targets: [{ symbol: "AAPL", targetWeightPercent: 0 }], maxTurnoverPercent: 100, maxEstimatedTax: 700 },
    policyMaxTurnoverPercent: 100,
  });
  expect(plan.withinConstraints).toBeFalse();
  expect(plan.basketDraft).toBeNull();
  expect(plan.tax.evidenceStatus).toBe("incomplete");
});

test("rejects duplicate target symbols", () => {
  expect(ConstrainedRebalancePlanRequest.safeParse({ targets: [{ symbol: "AAPL", targetWeightPercent: 10 }, { symbol: "aapl", targetWeightPercent: 20 }] }).success).toBeFalse();
});
