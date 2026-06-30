import { expect, test } from "bun:test";
import { buildDataGovernanceReport } from "./data-governance";

test("builds data licensing and subscription governance report", () => {
  const report = buildDataGovernanceReport("2026-06-26T10:00:00.000Z");
  expect(report.summary).toMatchObject({ totalSources: 9, availableSources: 5 });
  expect(report.summary.blockedForLivePromotion).toContain("alpaca_stock_sip");
  expect(report.summary.blockedForLivePromotion).toContain("alpaca_fixed_income_broker_api");
  expect(report.sources.find(source => source.id === "alpaca_news_benzinga")).toMatchObject({
    provider: "Alpaca / Benzinga",
    restrictions: expect.arrayContaining(["Do not redistribute as a standalone news feed."]),
  });
  expect(report.sources.find(source => source.id === "gdelt_doc_2")).toMatchObject({
    provider: "GDELT DOC 2.0 API",
    entitlement: "available",
    restrictions: expect.arrayContaining(["Label every result as a media signal, not verified fact."]),
  });
  expect(report.sources.find(source => source.id === "finnhub_free_enrichment")).toMatchObject({
    provider: "Finnhub API",
    entitlement: "requires_subscription",
    restrictions: expect.arrayContaining(["Never override official SEC fundamentals with Finnhub enrichment."]),
  });
  expect(report.sources.find(source => source.id === "openfigi_v3")).toMatchObject({
    provider: "OpenFIGI",
    entitlement: "available",
    restrictions: expect.arrayContaining(["Never select the first ticker result when distinct composite identities remain ambiguous."]),
  });
  expect(report.sources.find(source => source.id === "alpaca_fixed_income_broker_api")).toMatchObject({
    provider: "Alpaca Broker API",
    entitlement: "requires_subscription",
    restrictions: expect.arrayContaining(["Requires Broker API partner access and fixed-income enablement."]),
  });
  expect(report.sources.every(source => source.evidenceUrl.startsWith("https://"))).toBe(true);
  expect(report.runbook.join(" ")).toContain("fixed-income research unavailable");
  expect(report.runbook.join(" ")).toContain("Re-review paid feed");
});
