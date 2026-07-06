/**
 * Builds a comparable-company table from directly reported SEC facts and
 * current Alpaca IEX prices, preserving the period behind every input.
 */
import {
  canonicalEvidence,
  dedupeEvidence,
  type CanonicalEvidence,
} from "../../shared/evidence";
import type { SecCompany, SecFacts } from "../../integrations/sec-edgar";
import {
  buildSecFinancialTrends,
  type SecFinancialObservation,
  type SecFinancialTrendMetric,
} from "./sec-financial-trends";

export type ComparableValuationRow = {
  symbol: string;
  companyName: string;
  subject: boolean;
  price: number;
  marketCap: number | null;
  annualRevenue: number | null;
  annualNetIncome: number | null;
  annualDilutedEps: number | null;
  stockholdersEquity: number | null;
  sharesOutstanding: number | null;
  revenueGrowthPercent: number | null;
  netMarginPercent: number | null;
  priceToSales: number | null;
  priceToEarnings: number | null;
  priceToBook: number | null;
  periods: {
    revenue: string | null;
    netIncome: string | null;
    dilutedEps: string | null;
    stockholdersEquity: string | null;
    sharesOutstanding: string | null;
    price: string;
  };
  evidence: { sec: string; price: string; valuation: string };
  warnings: string[];
};

export type ComparableValuationEvidence = CanonicalEvidence<
  unknown,
  "fundamentals" | "market" | "valuation"
>;
export type ComparableValuationTable = {
  subject: string;
  peers: string[];
  rows: ComparableValuationRow[];
  sources: ComparableValuationEvidence[];
  warnings: string[];
  formulas: Record<string, string>;
  asOf: string;
};

const symbolPattern = /^[A-Z.]{1,10}$/;
const round = (value: number) => Number(value.toFixed(6));
const ratio = (numerator: number | null, denominator: number | null) =>
  numerator !== null && denominator !== null && denominator > 0
    ? round(numerator / denominator)
    : null;
const percent = (numerator: number | null, denominator: number | null) =>
  numerator !== null && denominator !== null && denominator !== 0
    ? round((numerator / denominator) * 100)
    : null;

function metric(
  trends: ReturnType<typeof buildSecFinancialTrends>,
  id: string,
) {
  return trends.metrics.find((item) => item.id === id);
}

function latestAnnual(value: SecFinancialTrendMetric | undefined) {
  return value?.annual.at(-1) ?? null;
}

function latestInstant(value: SecFinancialTrendMetric | undefined) {
  return (
    [...(value?.annual ?? []), ...(value?.quarterly ?? [])].toSorted(
      (a, b) =>
        b.periodEnd.localeCompare(a.periodEnd) ||
        b.filed.localeCompare(a.filed),
    )[0] ?? null
  );
}

function observationData(value: SecFinancialObservation | null) {
  return value
    ? {
        value: value.value,
        unit: value.unit,
        periodStart: value.periodStart,
        periodEnd: value.periodEnd,
        filed: value.filed,
        form: value.form,
        fiscalYear: value.fiscalYear,
        fiscalPeriod: value.fiscalPeriod,
        accession: value.accession,
        filingUrl: value.filingUrl,
        sourceConcept: value.sourceConcept,
      }
    : null;
}

export function parseComparableSymbols(
  rawSubject: string,
  rawPeers: string | string[],
) {
  const subject = rawSubject.trim().toUpperCase();
  if (!symbolPattern.test(subject))
    throw new Error("A valid subject symbol is required");
  const peers = (Array.isArray(rawPeers) ? rawPeers : rawPeers.split(","))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (peers.some((value) => !symbolPattern.test(value)))
    throw new Error("Peer symbols must be valid US stock tickers");
  const uniquePeers = [...new Set(peers)].filter((value) => value !== subject);
  if (uniquePeers.length < 1 || uniquePeers.length > 4)
    throw new Error("Choose between 1 and 4 distinct peer symbols");
  return { subject, peers: uniquePeers, symbols: [subject, ...uniquePeers] };
}

export function buildComparableValuationRow(
  company: SecCompany,
  facts: SecFacts,
  price: number,
  retrievedAt: string,
  subject = false,
) {
  if (!Number.isFinite(price) || price <= 0)
    throw new Error("Comparable valuation requires a positive market price");
  const asOf = new Date(retrievedAt).toISOString();
  const trends = buildSecFinancialTrends(company, facts, 3, 3);
  // Income multiples use annual facts while balance-sheet/share metrics use
  // latest instant facts. Their separate periods keep that mismatch visible.
  const revenueMetric = metric(trends, "revenue");
  const revenue = latestAnnual(revenueMetric);
  const previousRevenue = revenueMetric?.annual.at(-2) ?? null;
  const netIncome = latestAnnual(metric(trends, "net_income"));
  const dilutedEps = latestAnnual(metric(trends, "diluted_eps"));
  const equity = latestInstant(metric(trends, "stockholders_equity"));
  const shares = latestInstant(metric(trends, "shares_outstanding"));
  const marketCap =
    shares && shares.value > 0 ? round(price * shares.value) : null;
  const annualRevenue = revenue?.value ?? null;
  const annualNetIncome = netIncome?.value ?? null;
  const annualDilutedEps = dilutedEps?.value ?? null;
  const stockholdersEquity = equity?.value ?? null;
  const sharesOutstanding = shares?.value ?? null;
  const warnings: string[] = [];
  if (!revenue) warnings.push("Annual SEC revenue is unavailable.");
  if (!netIncome) warnings.push("Annual SEC net income is unavailable.");
  if (!dilutedEps)
    warnings.push("Annual SEC diluted EPS is unavailable; P/E is unavailable.");
  if (!equity)
    warnings.push(
      "SEC stockholders' equity is unavailable; P/B is unavailable.",
    );
  if (!shares)
    warnings.push(
      "SEC shares outstanding are unavailable; market capitalization and P/S are unavailable.",
    );
  if (shares)
    warnings.push(
      "Derived market capitalization uses the latest SEC shares outstanding and may not represent every listed share class or ADR ratio.",
    );
  const periods = {
    revenue: revenue?.periodEnd ?? null,
    netIncome: netIncome?.periodEnd ?? null,
    dilutedEps: dilutedEps?.periodEnd ?? null,
    stockholdersEquity: equity?.periodEnd ?? null,
    sharesOutstanding: shares?.periodEnd ?? null,
    price: asOf,
  };
  const secEvidenceId = `sec:valuation-inputs:${company.ticker}`;
  const priceEvidenceId = `market:valuation-price:${company.ticker}`;
  const valuationEvidenceId = `valuation:comparables:${company.ticker}`;
  const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`;
  const secSource = canonicalEvidence({
    id: secEvidenceId,
    provider: "sec",
    sourceId: `${company.cik}:valuation-inputs`,
    category: "fundamentals",
    authority: "official",
    claimStatus: "official_record",
    title: `${facts.entityName} SEC valuation inputs`,
    url: factsUrl,
    asOf: revenue
      ? new Date(`${revenue.periodEnd}T00:00:00.000Z`).toISOString()
      : asOf,
    retrievedAt: asOf,
    entityIds: { symbol: company.ticker, cik: company.cik },
    data: {
      symbol: company.ticker,
      companyName: facts.entityName,
      revenue: observationData(revenue),
      previousRevenue: observationData(previousRevenue),
      netIncome: observationData(netIncome),
      dilutedEps: observationData(dilutedEps),
      stockholdersEquity: observationData(equity),
      sharesOutstanding: observationData(shares),
    },
  });
  const priceSource = canonicalEvidence({
    id: priceEvidenceId,
    provider: "alpaca",
    sourceId: `${company.ticker}:valuation-price:${asOf}`,
    category: "market",
    authority: "regulated_broker",
    claimStatus: "broker_observation",
    title: `${company.ticker} valuation price`,
    url: "https://alpaca.markets/data",
    asOf,
    retrievedAt: asOf,
    entityIds: { symbol: company.ticker },
    data: {
      symbol: company.ticker,
      price,
      currency: "USD",
      feed: "IEX",
      retrievedAt: asOf,
    },
  });
  const row: ComparableValuationRow = {
    symbol: company.ticker,
    companyName: facts.entityName,
    subject,
    price,
    marketCap,
    annualRevenue,
    annualNetIncome,
    annualDilutedEps,
    stockholdersEquity,
    sharesOutstanding,
    revenueGrowthPercent:
      revenue && previousRevenue
        ? percent(revenue.value - previousRevenue.value, previousRevenue.value)
        : null,
    netMarginPercent:
      revenue && netIncome && revenue.periodEnd === netIncome.periodEnd
        ? percent(netIncome.value, revenue.value)
        : null,
    priceToSales: ratio(marketCap, annualRevenue),
    priceToEarnings:
      annualDilutedEps !== null && annualDilutedEps > 0
        ? round(price / annualDilutedEps)
        : null,
    priceToBook: ratio(marketCap, stockholdersEquity),
    periods,
    evidence: {
      sec: secEvidenceId,
      price: priceEvidenceId,
      valuation: valuationEvidenceId,
    },
    warnings,
  };
  const valuationSource = canonicalEvidence({
    id: valuationEvidenceId,
    provider: "ai-broker",
    sourceId: `${company.ticker}:valuation:${asOf}`,
    category: "valuation",
    authority: "derived",
    claimStatus: "derived_analysis",
    title: `${company.ticker} derived comparable valuation`,
    url: factsUrl,
    asOf,
    retrievedAt: asOf,
    entityIds: { symbol: company.ticker },
    data: {
      row,
      formulas: {
        marketCap: "price * latest SEC shares outstanding",
        priceToSales: "market cap / latest annual SEC revenue",
        priceToEarnings: "price / latest annual SEC diluted EPS",
        priceToBook: "market cap / latest SEC stockholders' equity",
        revenueGrowthPercent:
          "(latest annual revenue / previous annual revenue - 1) * 100",
        netMarginPercent: "annual net income / annual revenue * 100",
      },
      inputs: [secEvidenceId, priceEvidenceId],
    },
  });
  return {
    row,
    sources: [
      secSource,
      priceSource,
      valuationSource,
    ] as ComparableValuationEvidence[],
  };
}

export function comparableValuationTable(
  subject: string,
  peers: string[],
  results: Array<ReturnType<typeof buildComparableValuationRow>>,
  warnings: string[],
  asOf = new Date().toISOString(),
): ComparableValuationTable {
  const deduped = dedupeEvidence(results.flatMap((result) => result.sources));
  return {
    subject,
    peers,
    rows: results.map((result) => result.row),
    sources: deduped.records,
    warnings: [...new Set(warnings)],
    formulas: {
      marketCap: "Current IEX price x latest SEC shares outstanding",
      priceToSales:
        "Derived market cap / latest directly reported annual SEC revenue",
      priceToEarnings:
        "Current IEX price / latest directly reported annual SEC diluted EPS",
      priceToBook: "Derived market cap / latest SEC stockholders' equity",
      revenueGrowth: "Latest annual SEC revenue vs prior annual SEC revenue",
      netMargin:
        "Annual SEC net income / annual SEC revenue for the same period end",
    },
    asOf: new Date(asOf).toISOString(),
  };
}
