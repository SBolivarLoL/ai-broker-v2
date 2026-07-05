import { expect, test } from "bun:test";
import {
  buildComparableValuationRow,
  comparableValuationTable,
  parseComparableSymbols,
} from "../../backend/features/research/comparable-valuation";
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
    subject: "AAPL",
    peers: ["MSFT"],
    rows: [{ symbol: "AAPL" }],
    warnings: ["MSFT unavailable"],
    asOf: "2026-06-29T12:01:00.000Z",
  });
  expect(table.sources).toHaveLength(3);
});
