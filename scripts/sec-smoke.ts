import {
  SecEdgarClient,
  secUserAgentFromEnv,
} from "../backend/integrations/sec-edgar";
import { buildSecFinancialTrends } from "../backend/features/research/sec-financial-trends";

const symbol = (process.env.SEC_SYMBOL ?? "AAPL").trim().toUpperCase();
const client = new SecEdgarClient({ userAgent: secUserAgentFromEnv() });
const evidence = await client.filingEvidence(symbol, 12, 1_500);
const company = await client.company(symbol);
const factsResult = await client.companyFactsResult(company);
const trends = buildSecFinancialTrends(
  company,
  factsResult.facts,
);
const eventAlerts = await client.recent8KAlerts(symbol, 365, 2, 1_000);

const summary = {
  symbol: evidence.symbol,
  companyName: evidence.companyName,
  cik: evidence.cik,
  retrievedAt: evidence.retrievedAt,
  serverRespondedAt: evidence.serverRespondedAt,
  time: evidence.time,
  asOf: evidence.asOf,
  filings: evidence.filings.map((filing) => ({
    form: filing.form,
    filed: filing.filed,
    accession: filing.accession,
    url: filing.url,
    publishedAt: filing.publishedAt,
    effectivePeriod: filing.effectivePeriod,
    retrievedAt: filing.retrievedAt,
    serverRespondedAt: filing.serverRespondedAt,
    time: filing.time,
    asOf: filing.asOf,
  })),
  sections: evidence.sections.map((section) => ({
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
    publishedAt: section.publishedAt,
    effectivePeriod: section.effectivePeriod,
    retrievedAt: section.retrievedAt,
    serverRespondedAt: section.serverRespondedAt,
    time: section.time,
    asOf: section.asOf,
  })),
  companyFactsTime: {
    retrievedAt: factsResult.retrievedAt,
    serverRespondedAt: factsResult.serverRespondedAt,
    time: factsResult.time,
    asOf: factsResult.asOf,
  },
  financialTrends: {
    coverage: trends.coverage,
    metrics: trends.metrics.map((metric) => ({
      id: metric.id,
      concept: metric.concept,
      unit: metric.unit,
      annualPeriods: metric.annual.map((item) => ({
        periodEnd: item.periodEnd,
        form: item.form,
        accession: item.accession,
        filingUrl: item.filingUrl,
      })),
      quarterlyPeriods: metric.quarterly.map((item) => ({
        periodEnd: item.periodEnd,
        form: item.form,
        accession: item.accession,
        filingUrl: item.filingUrl,
      })),
    })),
    limitations: trends.limitations,
  },
  eventAlerts: eventAlerts.alerts.map((alert) => ({
    importance: alert.importance,
    filed: alert.filed,
    accession: alert.accession,
    primaryItem: alert.primaryItem,
    sourceUrl: alert.sourceUrl,
    indexUrl: alert.indexUrl,
    publishedAt: alert.publishedAt,
    effectivePeriod: alert.effectivePeriod,
    retrievedAt: alert.retrievedAt,
    serverRespondedAt: alert.serverRespondedAt,
    time: alert.time,
    asOf: alert.asOf,
    items: alert.items.map((item) => ({
      code: item.code,
      label: item.label,
      importance: item.importance,
      truncated: item.truncated,
      contentHash: item.contentHash,
    })),
  })),
  eventAlertLimitations: eventAlerts.limitations,
  eventAlertTime: {
    retrievedAt: eventAlerts.retrievedAt,
    serverRespondedAt: eventAlerts.serverRespondedAt,
    time: eventAlerts.time,
    asOf: eventAlerts.asOf,
  },
  limitations: evidence.limitations,
};

console.log(JSON.stringify(summary, null, 2));
const validProviderTime = (value: {
  retrievedAt: string;
  serverRespondedAt: string;
  time: { retrievalTime: string; serverResponseTime: string };
  asOf: string;
}) =>
  value.time.retrievalTime === value.retrievedAt &&
  value.time.serverResponseTime === value.serverRespondedAt &&
  value.asOf === value.serverRespondedAt;
if (
  !evidence.sections.length ||
  !trends.metrics.length ||
  !validProviderTime(evidence) ||
  !validProviderTime(factsResult) ||
  !validProviderTime(eventAlerts) ||
  !evidence.filings.every(validProviderTime) ||
  !evidence.sections.every(validProviderTime) ||
  !eventAlerts.alerts.every(validProviderTime)
) process.exitCode = 1;
