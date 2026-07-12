import { expect, test } from "bun:test";
import type { ComparableValuationRow } from "../../backend/features/research/comparable-valuation";
import { canonicalEvidence } from "../../backend/shared/evidence";
import {
  buildValuationScenarioMemo,
  ValuationScenarioInput,
} from "../../backend/features/research/valuation-scenario";

const asOf = "2026-06-29T12:00:00.000Z";
const row: ComparableValuationRow = {
  symbol: "TEST",
  companyName: "Test Corp",
  subject: true,
  price: 10,
  marketCap: 1_000,
  annualRevenue: 1_000,
  annualNetIncome: 100,
  annualDilutedEps: 1,
  stockholdersEquity: 500,
  sharesOutstanding: 100,
  revenueGrowthPercent: 5,
  netMarginPercent: 10,
  priceToSales: 1,
  priceToEarnings: 10,
  priceToBook: 2,
  periods: {
    revenue: "2025-12-31",
    netIncome: "2025-12-31",
    dilutedEps: "2025-12-31",
    stockholdersEquity: "2026-03-31",
    sharesOutstanding: "2026-03-31",
    price: asOf,
  },
  evidence: {
    sec: "sec:valuation-inputs:TEST",
    price: "market:valuation-price:TEST",
    valuation: "valuation:comparables:TEST",
  },
  warnings: [],
};
const sources = [
  canonicalEvidence({
    id: row.evidence.sec,
    provider: "sec",
    sourceId: "test:sec",
    category: "fundamentals",
    authority: "official",
    claimStatus: "official_record",
    title: "Test SEC inputs",
    url: "https://data.sec.gov/test",
    asOf,
    retrievedAt: asOf,
    observedAt: null,
    publishedAt: "2026-04-01T00:00:00.000Z",
    effectivePeriod: {
      start: "2025-01-01",
      end: "2026-03-31",
      label: "SEC input periods",
    },
    entityIds: { symbol: "TEST" },
    data: { revenue: 1_000, shares: 100 },
  }),
  canonicalEvidence({
    id: row.evidence.price,
    provider: "alpaca",
    sourceId: "test:price",
    category: "market",
    authority: "regulated_broker",
    claimStatus: "broker_observation",
    title: "Test price",
    url: "https://alpaca.markets/data",
    asOf,
    retrievedAt: asOf,
    observedAt: null,
    entityIds: { symbol: "TEST" },
    data: { price: 10 },
  }),
];
const assumptions = {
  bear: {
    revenueGrowthPercent: -10,
    netMarginPercent: 10,
    priceToEarnings: 10,
  },
  base: { revenueGrowthPercent: 0, netMarginPercent: 10, priceToEarnings: 10 },
  bull: { revenueGrowthPercent: 10, netMarginPercent: 10, priceToEarnings: 10 },
};

test("builds ordered scenario memos from user assumptions and cited inputs", () => {
  const result = buildValuationScenarioMemo(row, sources, assumptions, asOf);
  expect(
    result.scenarios.map((item) => [
      item.case,
      item.impliedPrice,
      item.returnPercent,
    ]),
  ).toEqual([
    ["bear", 9, -10],
    ["base", 10, 0],
    ["bull", 11, 10],
  ]);
  expect(
    result.scenarios.every(
      (item) => item.evidence.length === 3 && item.memo.includes("assumes"),
    ),
  ).toBe(true);
  expect(
    result.sources.map((source) => [source.authority, source.claimStatus]),
  ).toEqual([
    ["official", "official_record"],
    ["regulated_broker", "broker_observation"],
    ["derived", "derived_analysis"],
  ]);
  expect(result.sources[2]?.data).toMatchObject({
    assumptionSource: "user-entered",
    inputs: [row.evidence.sec, row.evidence.price],
  });
  expect(result).toMatchObject({
    schemaVersion: "valuation-scenarios-v2",
    observedAt: null,
    publishedAt: "2026-04-01T00:00:00.000Z",
    retrievedAt: asOf,
    serverRespondedAt: asOf,
    quality: {
      status: "partial",
      expected: {
        secFundamentals: 2,
        currentPrices: 1,
        marketPriceObservations: 1,
        assumptionCases: 3,
        scenarioOutputs: 3,
      },
      received: {
        secFundamentals: 2,
        currentPrices: 1,
        marketPriceObservations: 0,
        assumptionCases: 3,
        scenarioOutputs: 3,
      },
      omitted: {
        secFundamentals: 0,
        currentPrices: 0,
        marketPriceObservations: 1,
        assumptionCases: 0,
        scenarioOutputs: 0,
      },
      freshness: { status: "retrieval_time_only" },
    },
  });
});

test("rejects unordered cases and leaves non-positive earnings unavailable", () => {
  expect(
    ValuationScenarioInput.safeParse({
      ...assumptions,
      bear: { ...assumptions.bear, revenueGrowthPercent: 20 },
    }).success,
  ).toBe(false);
  const negative = buildValuationScenarioMemo(
    row,
    sources,
    {
      bear: {
        revenueGrowthPercent: -10,
        netMarginPercent: -10,
        priceToEarnings: 10,
      },
      base: {
        revenueGrowthPercent: 0,
        netMarginPercent: 0,
        priceToEarnings: 15,
      },
      bull: {
        revenueGrowthPercent: 10,
        netMarginPercent: 10,
        priceToEarnings: 20,
      },
    },
    asOf,
  );
  expect(negative.scenarios.map((item) => item.status)).toEqual([
    "unavailable",
    "unavailable",
    "available",
  ]);
  expect(negative.scenarios[0]?.memo).toContain(
    "projected earnings are not positive",
  );
  expect(negative.quality).toMatchObject({
    status: "partial",
    received: { scenarioOutputs: 1 },
    omitted: { scenarioOutputs: 2 },
  });
});
