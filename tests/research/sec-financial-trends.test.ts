import { expect, test } from "bun:test";
import { buildSecFinancialTrends } from "../../backend/features/research/sec-financial-trends";
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
const facts: SecFacts = {
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: "Revenue",
        units: {
          USD: [
            {
              val: 100,
              start: "2023-10-01",
              end: "2024-09-28",
              filed: "2024-11-01",
              form: "10-K",
              fy: 2024,
              fp: "FY",
              accn: "0000320193-24-000001",
            },
            {
              val: 110,
              start: "2023-10-01",
              end: "2024-09-28",
              filed: "2025-10-31",
              form: "10-K",
              fy: 2025,
              fp: "FY",
              accn: "0000320193-25-000079",
            },
            {
              val: 130,
              start: "2024-09-29",
              end: "2025-09-27",
              filed: "2025-10-31",
              form: "10-K",
              fy: 2025,
              fp: "FY",
              accn: "0000320193-25-000079",
            },
            {
              val: 30,
              start: "2024-12-29",
              end: "2025-03-29",
              filed: "2025-05-01",
              form: "10-Q",
              fy: 2025,
              fp: "Q2",
              accn: "0000320193-25-000020",
            },
            {
              val: 65,
              start: "2024-12-29",
              end: "2025-06-28",
              filed: "2025-08-01",
              form: "10-Q",
              fy: 2025,
              fp: "Q3",
              accn: "0000320193-25-000073",
            },
            {
              val: 35,
              start: "2025-03-30",
              end: "2025-06-28",
              filed: "2025-08-01",
              form: "10-Q",
              fy: 2025,
              fp: "Q3",
              accn: "0000320193-25-000073",
            },
          ],
        },
      },
      Assets: {
        label: "Assets",
        units: {
          USD: [
            {
              val: 350,
              end: "2025-09-27",
              filed: "2025-10-31",
              form: "10-K",
              fy: 2025,
              fp: "FY",
              accn: "0000320193-25-000079",
            },
            {
              val: 360,
              end: "2025-12-27",
              filed: "2026-01-30",
              form: "10-Q",
              fy: 2026,
              fp: "Q1",
              accn: "0000320193-26-000006",
            },
          ],
        },
      },
    },
  },
};

test("builds comparable direct annual and quarterly SEC trends with provenance", () => {
  const trends = buildSecFinancialTrends(company, facts);
  const revenue = trends.metrics.find((metric) => metric.id === "revenue")!;
  expect(revenue.annual.map((item) => item.value)).toEqual([110, 130]);
  expect(revenue.quarterly.map((item) => item.value)).toEqual([30, 35]);
  expect(revenue.quarterly.some((item) => item.value === 65)).toBe(false);
  expect(revenue.annual[0]).toMatchObject({
    periodStart: "2023-10-01",
    periodEnd: "2024-09-28",
    accession: "0000320193-25-000079",
    sourceConcept: "RevenueFromContractWithCustomerExcludingAssessedTax",
  });
  expect(revenue.annual[0]?.filingUrl).toBe(
    "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/0000320193-25-000079-index.html",
  );
  expect(trends.metrics.find((metric) => metric.id === "assets")).toMatchObject(
    { annual: [{ value: 350 }], quarterly: [{ value: 360 }] },
  );
  expect(trends.coverage).toMatchObject({
    metricCount: 2,
    annualObservations: 3,
    quarterlyObservations: 3,
    latestPeriodEnd: "2025-12-27",
  });
  expect(trends.limitations.join(" ")).toContain("not derived");
});

test("rejects unbounded SEC trend requests", () => {
  expect(() => buildSecFinancialTrends(company, facts, 0, 8)).toThrow(
    "annual trend limit",
  );
  expect(() => buildSecFinancialTrends(company, facts, 4, 21)).toThrow(
    "quarterly trend limit",
  );
});
