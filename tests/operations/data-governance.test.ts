import { expect, test } from "bun:test";
import { buildDataGovernanceReport } from "../../backend/features/operations/data-governance";

const expectedTables = [
  "schema_migrations", "events", "submissions", "receipts", "risk_reservations", "plans",
  "trade_journal_entries", "operations_policy", "encrypted_secrets", "decision_audit_log",
  "account_activities", "research_runs", "portfolio_snapshots", "strategy_backtests", "strategy_runs",
  "strategy_data_snapshots", "strategy_decisions", "strategy_orders", "strategy_metrics",
  "strategy_notes", "strategy_audit_log",
].sort();

test("builds data licensing and subscription governance report", () => {
  const report = buildDataGovernanceReport("2026-06-26T10:00:00.000Z");
  expect(report.summary).toMatchObject({ totalSources: 16, availableSources: 9, storedOutputCategories: 12 });
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
    entitlement: "requires_api_key",
    restrictions: expect.arrayContaining(["Never override official SEC fundamentals with Finnhub enrichment."]),
  });
  expect(report.sources.find(source => source.id === "openfigi_v3")).toMatchObject({
    provider: "OpenFIGI",
    entitlement: "available",
    redistributionDecision: "public_identifiers_allowed",
    restrictions: expect.arrayContaining(["Never select the first ticker result when distinct composite identities remain ambiguous."]),
  });
  expect(report.sources.find(source => source.id === "alpaca_fixed_income_broker_api")).toMatchObject({
    provider: "Alpaca Broker API",
    entitlement: "requires_partner_access",
    restrictions: expect.arrayContaining(["Requires Broker API partner access and fixed-income enablement."]),
  });
  expect(report.sources.every(source => source.evidenceUrl.startsWith("https://"))).toBe(true);
  expect(report.sources.filter(source => source.termsStatus !== "internal_policy").every(source => source.termsUrl?.startsWith("https://"))).toBe(true);
  expect(report.sources.filter(source => source.category !== "derived_analytics").every(source => source.liveUseDecision !== "internal_only")).toBe(true);
  expect(report.sources.find(source => source.id === "fred_api")).toMatchObject({ redistributionDecision: "blocked", termsStatus: "official_api_terms" });
  expect(report.sources.find(source => source.id === "openai_api")).toMatchObject({ entitlement: "requires_api_key", retentionDecision: "persist_with_provenance", liveUseDecision: "external_review_required" });
  expect(report.storedOutputs.flatMap(output => output.tables).sort()).toEqual(expectedTables);
  const outputIds = new Set(report.storedOutputs.map(output => output.id));
  const sourceIds = new Set(report.sources.map(source => source.id));
  expect(sourceIds.size).toBe(report.sources.length);
  expect(outputIds.size).toBe(report.storedOutputs.length);
  expect(report.sources.every(source => source.storedOutputIds.every(id => outputIds.has(id)))).toBe(true);
  expect(report.storedOutputs.every(output => output.sourceIds.every(id => sourceIds.has(id)))).toBe(true);
  expect(report.sources.every(source => source.storedOutputIds.every(id => report.storedOutputs.find(output => output.id === id)?.sourceIds.includes(source.id)))).toBe(true);
  expect(report.storedOutputs.every(output => output.sourceIds.every(id => report.sources.find(source => source.id === id)?.storedOutputIds.includes(output.id)))).toBe(true);
  expect(report.storedOutputs.every(output => output.redistributionDecision === "internal_only")).toBe(true);
  expect(report.runbook.join(" ")).toContain("fixed-income research unavailable");
  expect(report.runbook.join(" ")).toContain("no purge job exists");
  expect(report.runbook.join(" ")).toContain("Re-review paid feed");
});
