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
import { providerTimeFields } from "../../shared/time-provenance";
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
  schemaVersion: "comparable-valuations-v2";
  subject: string;
  peers: string[];
  rows: ComparableValuationRow[];
  sources: ComparableValuationEvidence[];
  warnings: string[];
  formulas: Record<string, string>;
  quality: {
    status: "complete" | "partial";
    expected: {
      companies: number;
      secFundamentals: number;
      currentPrices: number;
      marketPriceObservations: number;
      valuationMetrics: number;
    };
    received: {
      companies: number;
      secFundamentals: number;
      currentPrices: number;
      marketPriceObservations: number;
      valuationMetrics: number;
    };
    omitted: {
      companies: number;
      secFundamentals: number;
      currentPrices: number;
      marketPriceObservations: number;
      valuationMetrics: number;
    };
    freshness: {
      status: "observed" | "retrieval_time_only";
      latestPublishedAt: string | null;
      effectivePeriod: {
        start: string;
        end: string;
        label: string;
      } | null;
      retrievedAt: string;
      evaluatedAt: string;
      agePolicy: "market_price_observation_unavailable";
    };
    missing: string[];
    impact: string[];
    source: string;
  } & ReturnType<typeof providerTimeFields>;
  asOf: string;
} & ReturnType<typeof providerTimeFields>;

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

function filingTime(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function latestTime(values: (string | null | undefined)[]) {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  );
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
  secTime: { retrievedAt: string; serverRespondedAt: string } = {
    retrievedAt,
    serverRespondedAt: retrievedAt,
  },
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
  const selectedObservations = [
    revenue,
    previousRevenue,
    netIncome,
    dilutedEps,
    equity,
    shares,
  ].filter((value): value is SecFinancialObservation => value !== null);
  const secPublishedAt = latestTime(
    selectedObservations.map((value) => filingTime(value.filed)),
  );
  const secEffectivePeriod = selectedObservations.length
    ? {
        start: selectedObservations
          .map((value) => value.periodStart ?? value.periodEnd)
          .sort()[0]!,
        end: selectedObservations
          .map((value) => value.periodEnd)
          .sort()
          .at(-1)!,
        label: "SEC valuation input periods",
      }
    : null;
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
    retrievedAt: secTime.retrievedAt,
    serverRespondedAt: secTime.serverRespondedAt,
    observedAt: null,
    publishedAt: secPublishedAt,
    effectivePeriod: secEffectivePeriod,
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
    observedAt: null,
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
    observedAt: null,
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
  const rows = results.map((result) => result.row);
  const requestedSymbols = [subject, ...peers];
  const requested = requestedSymbols.length;
  const availableMetrics = rows.reduce(
    (count, row) =>
      count +
      [
        row.marketCap,
        row.revenueGrowthPercent,
        row.netMarginPercent,
        row.priceToSales,
        row.priceToEarnings,
        row.priceToBook,
      ].filter((value) => value !== null).length,
    0,
  );
  const marketSources = deduped.records.filter(
    (source) => source.category === "market",
  );
  const externalSources = deduped.records.filter(
    (source) => source.provider !== "ai-broker",
  );
  const expected = {
    companies: requested,
    secFundamentals: requested,
    currentPrices: requested,
    marketPriceObservations: requested,
    valuationMetrics: requested * 6,
  };
  const received = {
    companies: rows.length,
    secFundamentals: rows.length,
    currentPrices: rows.length,
    marketPriceObservations: marketSources.filter(
      (source) => source.observedAt !== null,
    ).length,
    valuationMetrics: availableMetrics,
  };
  const omitted = {
    companies: expected.companies - received.companies,
    secFundamentals: expected.secFundamentals - received.secFundamentals,
    currentPrices: expected.currentPrices - received.currentPrices,
    marketPriceObservations:
      expected.marketPriceObservations - received.marketPriceObservations,
    valuationMetrics: expected.valuationMetrics - received.valuationMetrics,
  };
  const omittedSymbols = requestedSymbols.filter(
    (symbol) => !rows.some((row) => row.symbol === symbol),
  );
  const rootPublishedAt = latestTime(
    externalSources.map((source) => source.publishedAt),
  );
  const effectiveStarts = externalSources
    .map((source) => source.effectivePeriod?.start)
    .filter((value): value is string => Boolean(value))
    .sort();
  const effectiveEnds = externalSources
    .map((source) => source.effectivePeriod?.end)
    .filter((value): value is string => Boolean(value))
    .sort();
  const rootEffectivePeriod =
    effectiveStarts.length && effectiveEnds.length
      ? {
          start: effectiveStarts[0]!,
          end: effectiveEnds.at(-1)!,
          label: "Comparable valuation source periods",
        }
      : null;
  const rootRetrievedAt =
    latestTime(externalSources.map((source) => source.retrievedAt)) ??
    new Date(asOf).toISOString();
  const rootTime = providerTimeFields({
    observationTime: null,
    publicationTime: rootPublishedAt,
    effectivePeriod: rootEffectivePeriod,
    retrievalTime: rootRetrievedAt,
    serverResponseTime: asOf,
  });
  const missing = [
    ...omittedSymbols.map((symbol) => `${symbol}:valuation_inputs`),
    ...(omitted.marketPriceObservations
      ? [
          `${omitted.marketPriceObservations} market prices have retrieval time but no provider observation time.`,
        ]
      : []),
    ...(omitted.valuationMetrics
      ? [
          `${omitted.valuationMetrics} requested valuation metrics are unavailable.`,
        ]
      : []),
  ];
  const impact = omitted.companies
    ? [
        "The peer table excludes unavailable companies and is not a complete comparison of the requested set.",
      ]
    : omitted.valuationMetrics || omitted.marketPriceObservations
      ? [
          "Available multiples remain visible, but missing fundamentals or unavailable market observation times limit cross-company and freshness conclusions.",
        ]
      : [
          "All requested companies and valuation metrics are available with explicit source timing.",
        ];
  return {
    schemaVersion: "comparable-valuations-v2",
    subject,
    peers,
    rows,
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
    quality: {
      status: missing.length ? "partial" : "complete",
      expected,
      received,
      omitted,
      freshness: {
        status:
          received.marketPriceObservations === expected.marketPriceObservations
            ? "observed"
            : "retrieval_time_only",
        latestPublishedAt: rootPublishedAt,
        effectivePeriod: rootEffectivePeriod,
        retrievedAt: rootRetrievedAt,
        evaluatedAt: rootTime.serverRespondedAt,
        agePolicy: "market_price_observation_unavailable",
      },
      missing,
      impact,
      source: "Calculated from the bounded SEC and Alpaca comparable set",
      ...rootTime,
    },
    ...rootTime,
  };
}
