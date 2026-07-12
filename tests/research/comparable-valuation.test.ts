import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import {
  buildComparableValuationRow,
  buildComparableValuationReplay,
  comparableValuationTable,
  parseComparableSymbols,
  replayComparableValuation,
} from "../../backend/features/research/comparable-valuation";
import {
  getPointInTimeComparableValuations,
  selectHistoricalValuationPrice,
} from "../../backend/features/research/research";
import type {
  SecCompany,
  SecFacts,
} from "../../backend/integrations/sec-edgar";

const company: SecCompany = {
  cik: "0000320193",
  cikNumber: "320193",
  ticker: "AAPL",
  title: "Apple Inc.",
};
const annual = (
  val: number,
  start: string,
  end: string,
  filed: string,
  accn: string,
) => ({
  val,
  start,
  end,
  filed,
  form: "10-K",
  fy: Number(end.slice(0, 4)),
  fp: "FY",
  accn,
});
const instant = (
  val: number,
  end: string,
  filed: string,
  form: "10-K" | "10-Q",
  accn: string,
) => ({
  val,
  end,
  filed,
  form,
  fy: Number(end.slice(0, 4)),
  fp: form === "10-K" ? "FY" : "Q1",
  accn,
});
const facts: SecFacts = {
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: "Revenue",
        units: {
          USD: [
            annual(
              100,
              "2023-01-01",
              "2023-12-31",
              "2024-02-01",
              "0000320193-24-000001",
            ),
            annual(
              120,
              "2024-01-01",
              "2024-12-31",
              "2025-02-01",
              "0000320193-25-000001",
            ),
          ],
        },
      },
      NetIncomeLoss: {
        label: "Net income",
        units: {
          USD: [
            annual(
              24,
              "2024-01-01",
              "2024-12-31",
              "2025-02-01",
              "0000320193-25-000001",
            ),
          ],
        },
      },
      EarningsPerShareDiluted: {
        label: "Diluted EPS",
        units: {
          "USD/shares": [
            annual(
              6,
              "2024-01-01",
              "2024-12-31",
              "2025-02-01",
              "0000320193-25-000001",
            ),
          ],
        },
      },
      StockholdersEquity: {
        label: "Stockholders equity",
        units: {
          USD: [
            instant(
              80,
              "2025-03-31",
              "2025-05-01",
              "10-Q",
              "0000320193-25-000002",
            ),
          ],
        },
      },
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        label: "Shares outstanding",
        units: {
          shares: [
            instant(
              10,
              "2025-03-31",
              "2025-05-01",
              "10-Q",
              "0000320193-25-000002",
            ),
          ],
        },
      },
    },
  },
};

test("builds provenance-bound comparable valuation metrics from SEC facts and broker price", () => {
  const result = buildComparableValuationRow(
    company,
    facts,
    30,
    "2026-06-29T12:00:00Z",
    true,
    {
      retrievedAt: "2026-06-29T11:59:58Z",
      serverRespondedAt: "2026-06-29T11:59:59Z",
    },
  );
  expect(result.row).toMatchObject({
    symbol: "AAPL",
    subject: true,
    marketCap: 300,
    annualRevenue: 120,
    annualNetIncome: 24,
    annualDilutedEps: 6,
    stockholdersEquity: 80,
    sharesOutstanding: 10,
    revenueGrowthPercent: 20,
    netMarginPercent: 20,
    priceToSales: 2.5,
    priceToEarnings: 5,
    priceToBook: 3.75,
  });
  expect(result.sources).toHaveLength(3);
  expect(
    result.sources.map((source) => [
      source.category,
      source.authority,
      source.claimStatus,
    ]),
  ).toEqual([
    ["fundamentals", "official", "official_record"],
    ["market", "regulated_broker", "broker_observation"],
    ["valuation", "derived", "derived_analysis"],
  ]);
  expect(result.sources[2]?.data).toMatchObject({
    inputs: ["sec:valuation-inputs:AAPL", "market:valuation-price:AAPL"],
  });
  expect(result.sources[0]).toMatchObject({
    observedAt: null,
    publishedAt: "2025-05-01T00:00:00.000Z",
    retrievedAt: "2026-06-29T11:59:58.000Z",
    serverRespondedAt: "2026-06-29T11:59:59.000Z",
    time: {
      retrievalTime: "2026-06-29T11:59:58.000Z",
      serverResponseTime: "2026-06-29T11:59:59.000Z",
    },
  });
});

test("keeps unavailable and unsafe valuation ratios explicit", () => {
  const sparseFacts: SecFacts = {
    entityName: "Loss Corp",
    facts: {
      "us-gaap": {
        EarningsPerShareDiluted: {
          label: "Diluted EPS",
          units: {
            "USD/shares": [
              annual(
                -2,
                "2024-01-01",
                "2024-12-31",
                "2025-02-01",
                "0000000001-25-000001",
              ),
            ],
          },
        },
      },
    },
  };
  const result = buildComparableValuationRow(
    { cik: "0000000001", cikNumber: "1", ticker: "LOSS", title: "Loss Corp" },
    sparseFacts,
    10,
    "2026-06-29T12:00:00Z",
  );
  expect(result.row).toMatchObject({
    marketCap: null,
    priceToSales: null,
    priceToEarnings: null,
    priceToBook: null,
    netMarginPercent: null,
  });
  expect(result.row.warnings.join(" ")).toContain(
    "market capitalization and P/S are unavailable",
  );
});

test("validates bounded manual peer sets and aggregates canonical evidence", () => {
  expect(parseComparableSymbols("aapl", "MSFT, GOOGL,MSFT")).toEqual({
    subject: "AAPL",
    peers: ["MSFT", "GOOGL"],
    symbols: ["AAPL", "MSFT", "GOOGL"],
  });
  expect(() => parseComparableSymbols("AAPL", "")).toThrow("between 1 and 4");
  expect(() =>
    parseComparableSymbols("AAPL", "MSFT,GOOGL,AMZN,META,NVDA"),
  ).toThrow("between 1 and 4");
  const result = buildComparableValuationRow(
    company,
    facts,
    30,
    "2026-06-29T12:00:00Z",
    true,
  );
  const table = comparableValuationTable(
    "AAPL",
    ["MSFT"],
    [result],
    ["MSFT unavailable"],
    "2026-06-29T12:01:00Z",
  );
  expect(table).toMatchObject({
    schemaVersion: "comparable-valuations-v3",
    priceMode: "latest_retrieval",
    pointInTime: { status: "not_requested" },
    subject: "AAPL",
    peers: ["MSFT"],
    rows: [{ symbol: "AAPL" }],
    warnings: ["MSFT unavailable"],
    asOf: "2026-06-29T12:01:00.000Z",
    observedAt: null,
    retrievedAt: "2026-06-29T12:00:00.000Z",
    serverRespondedAt: "2026-06-29T12:01:00.000Z",
    quality: {
      status: "partial",
      expected: {
        companies: 2,
        secFundamentals: 2,
        prices: 2,
        marketPriceObservations: 2,
        valuationMetrics: 12,
      },
      received: {
        companies: 1,
        secFundamentals: 1,
        prices: 1,
        marketPriceObservations: 0,
        valuationMetrics: 6,
      },
      omitted: {
        companies: 1,
        secFundamentals: 1,
        prices: 1,
        marketPriceObservations: 2,
        valuationMetrics: 6,
      },
      freshness: {
        status: "retrieval_time_only",
        evaluatedAt: "2026-06-29T12:01:00.000Z",
      },
    },
  });
  expect(table.sources).toHaveLength(3);
});

test("historical comparables exclude later SEC revisions and later market bars", () => {
  const revisedFacts = structuredClone(facts);
  revisedFacts.facts["us-gaap"]!
    .RevenueFromContractWithCustomerExcludingAssessedTax!.units.USD!.push(
      annual(
        150,
        "2024-01-01",
        "2024-12-31",
        "2025-06-01",
        "0000320193-25-000099",
      ),
    );
  const selectedPrice = selectHistoricalValuationPrice(
    [
      { close: 29, timestamp: "2025-05-14T20:00:00.000Z" },
      { close: 31, timestamp: "2025-05-16T20:00:00.000Z" },
    ],
    "2025-05-15",
  );
  const result = buildComparableValuationRow(
    company,
    revisedFacts,
    selectedPrice.price,
    "2026-07-12T12:00:00.000Z",
    true,
    {
      retrievedAt: "2026-07-12T11:59:58.000Z",
      serverRespondedAt: "2026-07-12T11:59:59.000Z",
    },
    {
      filedThrough: "2025-05-15",
      priceObservedAt: selectedPrice.observedAt,
      priceFeed: "iex",
    },
  );
  const report = comparableValuationTable(
    "AAPL",
    ["MSFT"],
    [result],
    ["MSFT unavailable"],
    "2026-07-12T12:00:01.000Z",
    { priceMode: "historical_daily_close", filedThrough: "2025-05-15" },
  );

  expect(result.row).toMatchObject({
    price: 29,
    annualRevenue: 120,
    periods: { price: "2025-05-14T20:00:00.000Z" },
  });
  expect(result.pointInTime).toMatchObject({
    mode: "filing_date_cutoff",
    asOfDate: "2025-05-15",
    excludedPostCutoffObservations: 1,
  });
  expect(report).toMatchObject({
    schemaVersion: "comparable-valuations-v3",
    priceMode: "historical_daily_close",
    observedAt: "2025-05-14T20:00:00.000Z",
    pointInTime: {
      status: "applied",
      asOfDate: "2025-05-15",
      marketObservationPolicy: "last_daily_bar_at_or_before_cutoff",
      excludedPostCutoffValuationObservations: 1,
      historicalClassification: { status: "unavailable" },
    },
    quality: {
      expected: { prices: 2, marketPriceObservations: 2 },
      received: { prices: 1, marketPriceObservations: 1 },
      freshness: { agePolicy: "historical_price_must_not_exceed_cutoff" },
    },
  });
});

test("point-in-time valuation service requests bounded IEX history and preserves the cutoff", async () => {
  const requests: Array<{ symbol: string; options: Record<string, unknown> }> = [];
  const alpaca = {
    marketData: {
      async getStockBarsFor(symbol: string, options: Record<string, unknown>) {
        requests.push({ symbol, options });
        return [
          { close: symbol === "AAPL" ? 29 : 19, timestamp: "2025-05-14T20:00:00.000Z" },
          { close: 999, timestamp: "2025-05-16T20:00:00.000Z" },
        ];
      },
    },
  } as unknown as Alpaca;
  const sec = {
    async company(symbol: string) {
      return { ...company, ticker: symbol, title: `${symbol} Inc.` };
    },
    async companyFactsResult(requestedCompany: SecCompany) {
      return {
        company: requestedCompany,
        facts: { ...facts, entityName: requestedCompany.title },
        sourceUrl: `https://data.sec.gov/${requestedCompany.cik}.json`,
        retrievedAt: "2026-07-12T11:59:58.000Z",
        serverRespondedAt: "2026-07-12T11:59:59.000Z",
      } as any;
    },
  };

  const report = await getPointInTimeComparableValuations(
    alpaca,
    "AAPL",
    ["MSFT"],
    "2025-05-15",
    { sec, now: () => new Date("2026-07-12T12:00:00.000Z") },
  );

  expect(requests.map(({ symbol, options }) => ({
    symbol,
    feed: options.feed,
    start: (options.start as Date).toISOString(),
    end: (options.end as Date).toISOString(),
  }))).toEqual([
    { symbol: "AAPL", feed: "iex", start: "2025-04-14T00:00:00.000Z", end: "2025-05-16T00:00:00.000Z" },
    { symbol: "MSFT", feed: "iex", start: "2025-04-14T00:00:00.000Z", end: "2025-05-16T00:00:00.000Z" },
  ]);
  expect(report).toMatchObject({
    schemaVersion: "comparable-valuations-v3",
    priceMode: "historical_daily_close",
    pointInTime: { status: "applied", asOfDate: "2025-05-15" },
    rows: [
      { symbol: "AAPL", subject: true, price: 29, periods: { price: "2025-05-14T20:00:00.000Z" } },
      { symbol: "MSFT", subject: false, price: 19, periods: { price: "2025-05-14T20:00:00.000Z" } },
    ],
    quality: {
      status: "complete",
      received: { companies: 2, prices: 2, marketPriceObservations: 2 },
    },
  });
});

test("historical comparable replay verifies stored evidence without provider reads", () => {
  const selectedPrice = selectHistoricalValuationPrice(
    [{ close: 30, timestamp: "2025-05-14T20:00:00.000Z" }],
    "2025-05-15",
  );
  const result = buildComparableValuationRow(
    company,
    facts,
    selectedPrice.price,
    "2026-07-12T12:00:00.000Z",
    true,
    undefined,
    {
      filedThrough: "2025-05-15",
      priceObservedAt: selectedPrice.observedAt,
      priceFeed: "iex",
    },
  );
  const report = comparableValuationTable(
    "AAPL",
    ["MSFT"],
    [result],
    ["MSFT unavailable"],
    "2026-07-12T12:00:01.000Z",
    { priceMode: "historical_daily_close", filedThrough: "2025-05-15" },
  );
  const replay = buildComparableValuationReplay(report);

  expect(replayComparableValuation(replay)).toMatchObject({
    schemaVersion: "comparable-valuation-replay-result-v1",
    status: "verified",
    providerRequests: 0,
    replayHash: replay.contentHash,
    report: { rows: [{ symbol: "AAPL", price: 30 }] },
  });
  const tampered = structuredClone(replay);
  tampered.report.rows[0]!.price = 999;
  expect(() => replayComparableValuation(tampered)).toThrow("integrity check failed");

  const futureMarketReport = structuredClone(report);
  const marketSource = futureMarketReport.sources.find(
    (source) => source.category === "market",
  )!;
  marketSource.observedAt = "2025-05-16T20:00:00.000Z";
  marketSource.time.observationTime = marketSource.observedAt;
  expect(() =>
    replayComparableValuation(
      buildComparableValuationReplay(futureMarketReport),
    ),
  ).toThrow("exceeds the market cutoff");

  const futureFilingReport = structuredClone(report);
  const fundamentalSource = futureFilingReport.sources.find(
    (source) => source.category === "fundamentals",
  )!;
  fundamentalSource.publishedAt = "2025-05-16T00:00:00.000Z";
  fundamentalSource.time.publicationTime = fundamentalSource.publishedAt;
  expect(() =>
    replayComparableValuation(
      buildComparableValuationReplay(futureFilingReport),
    ),
  ).toThrow("exceeds the filing cutoff");
});
