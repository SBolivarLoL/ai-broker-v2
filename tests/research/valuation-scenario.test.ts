import { expect, test } from "bun:test";
import {
  buildComparableValuationReplay,
  comparableValuationTable,
  type ComparableValuationRow,
} from "../../backend/features/research/comparable-valuation";
import {
  canonicalEvidence,
  evidenceContentHash,
} from "../../backend/shared/evidence";
import {
  buildValuationScenarioMemo,
  buildValuationScenarioReplay,
  replayValuationScenario,
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
    schemaVersion: "valuation-scenarios-v3",
    priceMode: "latest_retrieval",
    pointInTime: { status: "not_requested" },
    referencePrice: 10,
    observedAt: null,
    publishedAt: "2026-04-01T00:00:00.000Z",
    retrievedAt: asOf,
    serverRespondedAt: asOf,
    quality: {
      status: "partial",
      expected: {
        secFundamentals: 2,
        prices: 1,
        marketPriceObservations: 1,
        assumptionCases: 3,
        scenarioOutputs: 3,
      },
      received: {
        secFundamentals: 2,
        prices: 1,
        marketPriceObservations: 0,
        assumptionCases: 3,
        scenarioOutputs: 3,
      },
      omitted: {
        secFundamentals: 0,
        prices: 0,
        marketPriceObservations: 1,
        assumptionCases: 0,
        scenarioOutputs: 0,
      },
      freshness: { status: "retrieval_time_only" },
    },
  });
  expect("currentPrice" in result).toBe(false);
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

test("historical scenario replay recomputes from the stored parent and assumptions", () => {
  const historicalRow = structuredClone(row);
  historicalRow.periods.price = "2026-04-30T20:00:00.000Z";
  const historicalSources = structuredClone(sources);
  const market = historicalSources.find((source) => source.category === "market")!;
  market.observedAt = "2026-04-30T20:00:00.000Z";
  market.time.observationTime = market.observedAt;
  const parent = comparableValuationTable(
    "TEST",
    ["PEER"],
    [
      {
        row: historicalRow,
        sources: historicalSources,
        pointInTime: {
          mode: "filing_date_cutoff",
          asOfDate: "2026-05-01",
          cutoffAt: "2026-05-01T23:59:59.999Z",
          excludedPostCutoffObservations: 0,
          publicationPrecision: "sec_filed_date",
        },
      },
    ],
    ["PEER unavailable"],
    "2026-07-12T12:00:00.000Z",
    { priceMode: "historical_daily_close", filedThrough: "2026-05-01" },
  );
  const parentReplay = buildComparableValuationReplay(parent);
  const replay = buildValuationScenarioReplay(
    parentReplay,
    assumptions,
    "2026-07-12T12:00:01.000Z",
  );
  const result = replayValuationScenario(replay);

  expect(result).toMatchObject({
    schemaVersion: "valuation-scenario-replay-result-v1",
    status: "verified",
    providerRequests: 0,
    replayHash: replay.contentHash,
    parentReplayHash: parentReplay.contentHash,
    memo: {
      schemaVersion: "valuation-scenarios-v3",
      priceMode: "historical_daily_close",
      pointInTime: { status: "applied", asOfDate: "2026-05-01" },
      referencePrice: 10,
      observedAt: "2026-04-30T20:00:00.000Z",
      quality: {
        freshness: { agePolicy: "historical_price_must_not_exceed_cutoff" },
      },
    },
  });
  expect(result.memo.scenarios[1]?.memo).toContain(
    "selected historical IEX daily close",
  );

  const tampered = structuredClone(replay);
  tampered.memo.scenarios[1]!.impliedPrice = 999;
  const { contentHash: _oldHash, ...tamperedManifest } = tampered;
  tampered.contentHash = evidenceContentHash(tamperedManifest);
  expect(() => replayValuationScenario(tampered)).toThrow(
    "deterministic recomputation failed",
  );
});
