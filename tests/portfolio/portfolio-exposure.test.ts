import { expect, test } from "bun:test";
import { buildPortfolioExposureReport, secSicDivision } from "../../backend/features/portfolio/portfolio-exposure";

const bars = (start: number, dailyReturn: number, count = 70) => Array.from({ length: count }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), close: start * (1 + dailyReturn) ** index * (1 + (index % 3 - 1) * .001) }));

test("maps official SIC codes to their published broad divisions", () => {
  expect(secSicDivision("0100")).toBe("Agriculture, forestry and fishing");
  expect(secSicDivision("3571")).toBe("Manufacturing");
  expect(secSicDivision("6021")).toBe("Finance, insurance and real estate");
  expect(secSicDivision("7372")).toBe("Services");
  expect(secSicDivision("x")).toBeNull();
});

test("aggregates asset class, SIC sector, industry and return-derived factor exposure", () => {
  const report = buildPortfolioExposureReport({
    equity: 100_000,
    cash: 20_000,
    benchmarkBars: bars(400, .001),
    asOf: "2026-06-29T12:00:00Z",
    positions: [
      { symbol: "AAPL", marketValue: 40_000, assetClass: "us_equity", bars: bars(100, .0012), classification: { sic: "3571", industry: "Electronic Computers", sourceUrl: "https://data.sec.gov/aapl" }, marketDataSource: "alpaca:iex" },
      { symbol: "JPM", marketValue: 30_000, assetClass: "us_equity", bars: bars(100, .0008), classification: { sic: "6021", industry: "National Commercial Banks", sourceUrl: "https://data.sec.gov/jpm" }, marketDataSource: "alpaca:iex" },
      { symbol: "BTC/USD", marketValue: 10_000, assetClass: "crypto" },
    ],
  });
  expect(report.assetClasses).toMatchObject([{ label: "US equity", netPercent: 70 }, { label: "Cash", netPercent: 20 }, { label: "Crypto", netPercent: 10 }]);
  expect(report.sectors).toMatchObject([{ label: "Manufacturing", grossPercent: 40 }, { label: "Finance, insurance and real estate", grossPercent: 30 }]);
  expect(report.industries.map(item => item.label)).toEqual(["Electronic Computers", "National Commercial Banks"]);
  expect(report.quality).toMatchObject({ classificationScheme: "SEC SIC", classificationCoveragePercent: 100, grossInvestedPercent: 80 });
  expect(report.factors.every(factor => factor.value !== null && factor.coveragePercent === 87.5)).toBe(true);
  expect(report.warnings.some(warning => warning.includes("not GICS"))).toBe(true);
});

test("keeps missing classifications and factor history explicit", () => {
  const report = buildPortfolioExposureReport({ equity: 10_000, cash: 5_000, benchmarkBars: bars(400, .001), positions: [{ symbol: "ETF", marketValue: 5_000, assetClass: "us_equity", bars: bars(100, .001, 10), classification: null }] });
  expect(report.sectors).toMatchObject([{ label: "Unclassified", grossPercent: 50 }]);
  expect(report.quality.classificationCoveragePercent).toBe(0);
  expect(report.factors.every(factor => factor.value === null || factor.coveragePercent === 0)).toBe(true);
  expect(report.warnings.some(warning => warning.includes("no usable SEC SIC"))).toBe(true);
});
