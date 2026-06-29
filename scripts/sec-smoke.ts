import { SecEdgarClient, secUserAgentFromEnv } from "../src/sec-edgar";
import { buildSecFinancialTrends } from "../src/sec-financial-trends";

const symbol = (process.env.SEC_SYMBOL ?? "AAPL").trim().toUpperCase();
const client = new SecEdgarClient({ userAgent: secUserAgentFromEnv() });
const evidence = await client.filingEvidence(symbol, 12, 1_500);
const company = await client.company(symbol);
const trends = buildSecFinancialTrends(company, await client.companyFacts(company));
const eventAlerts = await client.recent8KAlerts(symbol, 365, 2, 1_000);

const summary = {
  symbol: evidence.symbol,
  companyName: evidence.companyName,
  cik: evidence.cik,
  filings: evidence.filings.map(filing => ({ form: filing.form, filed: filing.filed, accession: filing.accession, url: filing.url })),
  sections: evidence.sections.map(section => ({
    kind: section.kind,
    form: section.form,
    locator: section.locator,
    filed: section.filed,
    accession: section.accession,
    sourceUrl: section.sourceUrl,
    includedCharacterCount: section.includedCharacterCount,
    sourceCharacterCount: section.sourceCharacterCount,
    truncated: section.truncated,
    contentHash: section.contentHash,
  })),
  financialTrends: {
    coverage: trends.coverage,
    metrics: trends.metrics.map(metric => ({
      id: metric.id,
      concept: metric.concept,
      unit: metric.unit,
      annualPeriods: metric.annual.map(item => ({ periodEnd: item.periodEnd, form: item.form, accession: item.accession, filingUrl: item.filingUrl })),
      quarterlyPeriods: metric.quarterly.map(item => ({ periodEnd: item.periodEnd, form: item.form, accession: item.accession, filingUrl: item.filingUrl })),
    })),
    limitations: trends.limitations,
  },
  eventAlerts: eventAlerts.alerts.map(alert => ({
    importance: alert.importance,
    filed: alert.filed,
    accession: alert.accession,
    primaryItem: alert.primaryItem,
    sourceUrl: alert.sourceUrl,
    indexUrl: alert.indexUrl,
    items: alert.items.map(item => ({ code: item.code, label: item.label, importance: item.importance, truncated: item.truncated, contentHash: item.contentHash })),
  })),
  eventAlertLimitations: eventAlerts.limitations,
  limitations: evidence.limitations,
};

console.log(JSON.stringify(summary, null, 2));
if (!evidence.sections.length || !trends.metrics.length) process.exitCode = 1;
