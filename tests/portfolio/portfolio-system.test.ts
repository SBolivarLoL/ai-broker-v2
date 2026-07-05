import { describe, expect, test } from "bun:test";
import { buildPortfolioExposureReport, type ExposureBar, type ExposurePosition } from "../../backend/features/portfolio/portfolio-exposure";
import { buildPortfolioOptimizerReport } from "../../backend/features/portfolio/portfolio-optimizer";
import { buildPortfolioScenarioReport } from "../../backend/features/portfolio/portfolio-scenarios";
import { buildConstrainedRebalancePlan } from "../../backend/features/portfolio/rebalance-planner";

const asOf = "2026-06-30T12:00:00.000Z";
const equity = 100_000;
const cash = 20_000;

function fixtureBars(start: number, drift: number, wobble: number): ExposureBar[] {
  let close = start;
  return Array.from({ length: 80 }, (_, index) => {
    if (index) close *= 1 + drift + Math.sin(index / 3) * wobble;
    return { date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), close: Number(close.toFixed(2)) };
  });
}

const benchmarkBars = fixtureBars(400, 0.0005, 0.002);
const holdings: ExposurePosition[] = [
  { symbol: "AAPL", marketValue: 40_000, assetClass: "us_equity", bars: fixtureBars(180, 0.001, 0.005), classification: { sic: "3571", industry: "Electronic Computers", sourceUrl: "https://data.sec.gov/aapl" }, marketDataSource: "fixture" },
  { symbol: "JPM", marketValue: 25_000, assetClass: "us_equity", bars: fixtureBars(140, 0.0003, 0.001), classification: { sic: "6021", industry: "National Commercial Banks", sourceUrl: "https://data.sec.gov/jpm" }, marketDataSource: "fixture" },
  { symbol: "XOM", marketValue: 15_000, assetClass: "us_equity", bars: fixtureBars(90, -0.0001, 0.004), classification: { sic: "2911", industry: "Petroleum Refining", sourceUrl: "https://data.sec.gov/xom" }, marketDataSource: "fixture" },
];

describe("portfolio backend system flow", () => {
  test("turns holdings into scenario, optimizer and rebalance evidence without UI automation", () => {
    const exposure = buildPortfolioExposureReport({ equity, cash, positions: holdings, benchmarkBars, asOf });
    expect(exposure.quality.classificationCoveragePercent).toBe(100);
    expect(exposure.factors.every(factor => factor.coveragePercent === 100)).toBeTrue();
    expect(exposure.assetClasses.find(item => item.label === "Cash")?.netPercent).toBe(20);

    const scenario = buildPortfolioScenarioReport({
      equity,
      asOf,
      positions: exposure.positions.map(position => ({
        symbol: position.symbol,
        marketValue: position.marketValue,
        assetClass: position.assetClass,
        sector: position.sector,
        sic: position.sic,
        volatility20dPercent: position.factors.volatility20dPercent,
      })),
    });
    const rates = scenario.scenarios.find(item => item.id === "rates_up_200bp")!;
    const technology = scenario.scenarios.find(item => item.id === "technology_crash")!;
    expect(technology.coveragePercent).toBe(100);
    expect(technology.estimatedLoss).toBeGreaterThan(rates.estimatedLoss);

    const optimizer = buildPortfolioOptimizerReport({
      equity,
      asOf,
      positions: holdings.map(position => ({ symbol: position.symbol, marketValue: position.marketValue, closes: position.bars!.map(bar => bar.close) })),
      request: { maxWeightPercent: 35, maxTurnoverPercent: 12, cashReservePercent: 20, minObservations: 30 },
    });
    expect(optimizer.coverage.optimizedSymbols).toEqual(["AAPL", "JPM", "XOM"]);
    for (const proposal of optimizer.proposals) {
      expect(proposal.turnoverPercent).toBeLessThanOrEqual(12);
      expect(proposal.weights.some(weight => Math.abs(weight.deltaPercent) > 0)).toBeTrue();
    }

    const riskParity = optimizer.proposals.find(proposal => proposal.id === "risk_parity")!;
    const plan = buildConstrainedRebalancePlan({
      asOf,
      account: { equity, cash },
      request: {
        targets: riskParity.weights.map(weight => ({ symbol: weight.symbol, targetWeightPercent: weight.targetWeightPercent })),
        maxTurnoverPercent: 12,
        cashBufferPercent: 15,
        feeBps: 1,
        shortTermTaxRatePercent: 35,
        longTermTaxRatePercent: 15,
        maxEstimatedTax: null,
        minTradeNotional: 25,
      },
      positions: [
        { symbol: "AAPL", qty: 200, marketValue: 40_000, price: 200, fractionable: true },
        { symbol: "JPM", qty: 200, marketValue: 25_000, price: 125, fractionable: true },
        { symbol: "XOM", qty: 150, marketValue: 15_000, price: 100, fractionable: true },
      ],
      market: [
        { symbol: "AAPL", price: 200, fractionable: true },
        { symbol: "JPM", price: 125, fractionable: true },
        { symbol: "XOM", price: 100, fractionable: true },
      ],
      openLots: [
        { symbol: "AAPL", quantity: 200, price: 150, acquiredAt: "2024-01-02T00:00:00.000Z" },
        { symbol: "JPM", quantity: 200, price: 100, acquiredAt: "2024-01-02T00:00:00.000Z" },
        { symbol: "XOM", quantity: 150, price: 95, acquiredAt: "2024-01-02T00:00:00.000Z" },
      ],
      taxLotsComplete: true,
      currentTurnoverNotional: 0,
      policyMaxTurnoverPercent: 12,
    });
    expect(plan.withinConstraints).toBeTrue();
    expect(plan.summary.turnoverAfterPercent).toBeLessThanOrEqual(12);
    expect(plan.tax.evidenceStatus).toBe("complete");
    expect(plan.legs.length).toBeGreaterThanOrEqual(2);
    expect(plan.basketDraft).toContain(" ");
  });
});
