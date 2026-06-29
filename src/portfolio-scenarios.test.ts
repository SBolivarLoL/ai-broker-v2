import { expect, test } from "bun:test";
import { buildPortfolioScenarioReport, CustomPortfolioScenario, isTechnologySic } from "./portfolio-scenarios";

const positions = [
  { symbol: "AAPL", marketValue: 40_000, assetClass: "US equity", sector: "Manufacturing", sic: "3571", volatility20dPercent: 20 },
  { symbol: "JPM", marketValue: 20_000, assetClass: "US equity", sector: "Finance, insurance and real estate", sic: "6021", volatility20dPercent: 10 },
  { symbol: "BTC/USD", marketValue: 10_000, assetClass: "Crypto", sector: null, sic: null, volatility20dPercent: null },
];

test("identifies the bounded technology SIC ranges", () => {
  expect(isTechnologySic("3571")).toBe(true);
  expect(isTechnologySic("3674")).toBe(true);
  expect(isTechnologySic("7372")).toBe(true);
  expect(isTechnologySic("6021")).toBe(false);
});

test("builds transparent rate, technology and volatility scenarios", () => {
  const report = buildPortfolioScenarioReport({ equity: 100_000, positions, asOf: "2026-06-29T12:00:00Z" });
  expect(report.scenarios.map(scenario => scenario.id)).toEqual(["rates_up_200bp", "technology_crash", "volatility_spike"]);
  expect(report.scenarios[0]).toMatchObject({ estimatedPnl: -4_800, resultingEquity: 95_200, coveragePercent: 85.7143 });
  expect(report.scenarios[1]).toMatchObject({ estimatedPnl: -11_600, equityImpactPercent: -11.6, coveragePercent: 85.7143 });
  expect(report.scenarios[2]).toMatchObject({ estimatedPnl: -1_889.8, coveragePercent: 85.7143 });
  expect(report.warnings.some(warning => warning.includes("not forecasts"))).toBe(true);
});

test("validates and applies held-symbol custom shocks with signed market values", () => {
  const custom = CustomPortfolioScenario.parse({ name: "My stress", shocks: [{ symbol: "aapl", shockPercent: -10 }, { symbol: "BTC/USD", shockPercent: 5 }] });
  const report = buildPortfolioScenarioReport({ equity: 100_000, positions, custom });
  expect(report.scenarios[0]).toMatchObject({ id: "custom", estimatedPnl: -3_500, coveragePercent: 100 });
  expect(() => CustomPortfolioScenario.parse({ shocks: [{ symbol: "AAPL", shockPercent: -10 }, { symbol: "AAPL", shockPercent: -20 }] })).toThrow();
  expect(() => buildPortfolioScenarioReport({ equity: 100_000, positions, custom: CustomPortfolioScenario.parse({ shocks: [{ symbol: "MSFT", shockPercent: -10 }] }) })).toThrow("held symbols");
  const short = buildPortfolioScenarioReport({ equity: 100_000, positions: [{ symbol: "AAPL", marketValue: -10_000, assetClass: "US equity" }], custom: CustomPortfolioScenario.parse({ shocks: [{ symbol: "AAPL", shockPercent: -20 }] }) });
  expect(short.scenarios[0]?.estimatedPnl).toBe(2_000);
});
