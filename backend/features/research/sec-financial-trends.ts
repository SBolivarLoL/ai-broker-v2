/**
 * Selects comparable annual and quarterly observations from SEC Company Facts,
 * retaining filing, accession, concept, unit, and period provenance.
 */
import type { SecCompany, SecFacts } from "../../integrations/sec-edgar";

export type SecFinancialCadence = "annual" | "quarterly";

export type SecFinancialObservation = {
  value: number;
  unit: string;
  cadence: SecFinancialCadence;
  periodStart: string | null;
  periodEnd: string;
  durationDays: number | null;
  filed: string;
  form: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  accession: string;
  filingUrl: string;
  sourceConcept: string;
};

export type SecFinancialTrendMetric = {
  id: string;
  label: string;
  concept: string;
  unit: string;
  kind: "duration" | "instant";
  annual: SecFinancialObservation[];
  quarterly: SecFinancialObservation[];
};

export type SecFinancialTrends = {
  companyName: string;
  cik: string;
  metrics: SecFinancialTrendMetric[];
  coverage: {
    metricCount: number;
    annualObservations: number;
    quarterlyObservations: number;
    latestPeriodEnd: string | null;
    latestFiled: string | null;
  };
  pointInTime: {
    mode: "latest_available" | "filing_date_cutoff";
    asOfDate: string | null;
    cutoffAt: string | null;
    excludedPostCutoffObservations: number;
    publicationPrecision: "sec_filed_date";
  };
  limitations: string[];
};

type FactEntry = {
  val: number;
  start?: string;
  end: string;
  filed: string;
  form: string;
  fy?: number;
  fp?: string;
  frame?: string;
  accn: string;
};

type MetricDefinition = {
  id: string;
  label: string;
  taxonomy: "us-gaap" | "dei";
  concepts: string[];
  unit: string;
  kind: "duration" | "instant";
};

const METRICS: MetricDefinition[] = [
  {
    id: "revenue",
    label: "Revenue",
    taxonomy: "us-gaap",
    concepts: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
    ],
    unit: "USD",
    kind: "duration",
  },
  {
    id: "net_income",
    label: "Net income",
    taxonomy: "us-gaap",
    concepts: ["NetIncomeLoss"],
    unit: "USD",
    kind: "duration",
  },
  {
    id: "diluted_eps",
    label: "Diluted EPS",
    taxonomy: "us-gaap",
    concepts: ["EarningsPerShareDiluted"],
    unit: "USD/shares",
    kind: "duration",
  },
  {
    id: "assets",
    label: "Total assets",
    taxonomy: "us-gaap",
    concepts: ["Assets"],
    unit: "USD",
    kind: "instant",
  },
  {
    id: "liabilities",
    label: "Total liabilities",
    taxonomy: "us-gaap",
    concepts: ["Liabilities"],
    unit: "USD",
    kind: "instant",
  },
  {
    id: "cash",
    label: "Cash and equivalents",
    taxonomy: "us-gaap",
    concepts: ["CashAndCashEquivalentsAtCarryingValue"],
    unit: "USD",
    kind: "instant",
  },
  {
    id: "stockholders_equity",
    label: "Stockholders' equity",
    taxonomy: "us-gaap",
    concepts: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    unit: "USD",
    kind: "instant",
  },
  {
    id: "shares_outstanding",
    label: "Shares outstanding",
    taxonomy: "dei",
    concepts: ["EntityCommonStockSharesOutstanding"],
    unit: "shares",
    kind: "instant",
  },
];

function durationDays(entry: FactEntry) {
  if (!entry.start) return null;
  const start = new Date(`${entry.start}T00:00:00Z`).getTime();
  const end = new Date(`${entry.end}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

function isForm(entry: FactEntry, prefix: "10-K" | "10-Q") {
  return entry.form === prefix || entry.form === `${prefix}/A`;
}

export function normalizeSecPointInTimeDate(
  value: string,
  latestAllowedDate?: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("SEC point-in-time date must use YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error("SEC point-in-time date must be a real calendar date");
  if (latestAllowedDate && value > latestAllowedDate)
    throw new Error("SEC point-in-time date cannot be in the future");
  return value;
}

function availableByFilingDate(entry: FactEntry, filedThrough: string | null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.filed)) return false;
  return !filedThrough || entry.filed <= filedThrough;
}

function cadenceEntry(
  entry: FactEntry,
  kind: MetricDefinition["kind"],
  cadence: SecFinancialCadence,
) {
  if (
    !Number.isFinite(entry.val) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.end) ||
    !entry.accn
  )
    return false;
  if (cadence === "annual" && !isForm(entry, "10-K")) return false;
  if (cadence === "quarterly" && !isForm(entry, "10-Q")) return false;
  if (kind === "instant") return !entry.start;
  const days = durationDays(entry);
  if (days === null) return false;
  return cadence === "annual"
    ? days >= 300 && days <= 400
    : days >= 70 && days <= 120;
}

function filingIndexUrl(company: SecCompany, accession: string) {
  const plain = accession.replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/data/${company.cikNumber}/${plain}/${accession}-index.html`;
}

function observation(
  company: SecCompany,
  concept: string,
  unit: string,
  cadence: SecFinancialCadence,
  entry: FactEntry,
): SecFinancialObservation {
  return {
    value: entry.val,
    unit,
    cadence,
    periodStart: entry.start ?? null,
    periodEnd: entry.end,
    durationDays: durationDays(entry),
    filed: entry.filed,
    form: entry.form,
    fiscalYear: Number.isFinite(entry.fy) ? entry.fy! : null,
    fiscalPeriod: entry.fp ?? null,
    accession: entry.accn,
    filingUrl: filingIndexUrl(company, entry.accn),
    sourceConcept: concept,
  };
}

function observations(
  company: SecCompany,
  concept: string,
  unit: string,
  kind: MetricDefinition["kind"],
  entries: FactEntry[],
  cadence: SecFinancialCadence,
  limit: number,
  filedThrough: string | null,
) {
  const byPeriod = new Map<string, FactEntry[]>();
  for (const entry of entries.filter(
    (item) =>
      cadenceEntry(item, kind, cadence) &&
      availableByFilingDate(item, filedThrough),
  )) {
    const records = byPeriod.get(entry.end) ?? [];
    records.push(entry);
    byPeriod.set(entry.end, records);
  }
  // Company Facts can repeat a period after amendments or later filings.
  // Retain the latest-filed record for each period end.
  return [...byPeriod.values()]
    .map(
      (records) =>
        records.toSorted(
          (a, b) =>
            b.filed.localeCompare(a.filed) || b.form.localeCompare(a.form),
        )[0]!,
    )
    .toSorted((a, b) => a.end.localeCompare(b.end))
    .slice(-limit)
    .map((entry) => observation(company, concept, unit, cadence, entry));
}

function metricFacts(
  facts: SecFacts,
  definition: MetricDefinition,
  filedThrough: string | null,
) {
  let fallback: { concept: string; entries: FactEntry[] } | null = null;
  for (const concept of definition.concepts) {
    const fact = facts.facts[definition.taxonomy]?.[concept];
    const entries = fact?.units[definition.unit];
    if (!fact || !entries?.length) continue;
    fallback ??= { concept, entries };
    if (
      !filedThrough ||
      entries.some(
        (entry) =>
          availableByFilingDate(entry, filedThrough) &&
          (cadenceEntry(entry, definition.kind, "annual") ||
            cadenceEntry(entry, definition.kind, "quarterly")),
      )
    )
      return { concept, entries };
  }
  return fallback;
}

export function buildSecFinancialTrends(
  company: SecCompany,
  facts: SecFacts,
  annualLimit = 4,
  quarterlyLimit = 8,
  filedThrough: string | null = null,
): SecFinancialTrends {
  if (!Number.isInteger(annualLimit) || annualLimit < 1 || annualLimit > 10)
    throw new Error("SEC annual trend limit must be between 1 and 10");
  if (
    !Number.isInteger(quarterlyLimit) ||
    quarterlyLimit < 1 ||
    quarterlyLimit > 20
  )
    throw new Error("SEC quarterly trend limit must be between 1 and 20");
  if (filedThrough) normalizeSecPointInTimeDate(filedThrough);
  let excludedPostCutoffObservations = 0;
  const metrics = METRICS.flatMap((definition) => {
    const source = metricFacts(facts, definition, filedThrough);
    if (!source) return [];
    if (filedThrough) {
      excludedPostCutoffObservations += source.entries.filter(
        (entry) =>
          (cadenceEntry(entry, definition.kind, "annual") ||
            cadenceEntry(entry, definition.kind, "quarterly")) &&
          !availableByFilingDate(entry, filedThrough),
      ).length;
    }
    const annual = observations(
      company,
      source.concept,
      definition.unit,
      definition.kind,
      source.entries,
      "annual",
      annualLimit,
      filedThrough,
    );
    const quarterly = observations(
      company,
      source.concept,
      definition.unit,
      definition.kind,
      source.entries,
      "quarterly",
      quarterlyLimit,
      filedThrough,
    );
    if (!annual.length && !quarterly.length) return [];
    return [
      {
        id: definition.id,
        label: definition.label,
        concept: source.concept,
        unit: definition.unit,
        kind: definition.kind,
        annual,
        quarterly,
      },
    ];
  });
  const all = metrics.flatMap((metric) => [
    ...metric.annual,
    ...metric.quarterly,
  ]);
  return {
    companyName: facts.entityName,
    cik: company.cik,
    metrics,
    coverage: {
      metricCount: metrics.length,
      annualObservations: metrics.reduce(
        (sum, metric) => sum + metric.annual.length,
        0,
      ),
      quarterlyObservations: metrics.reduce(
        (sum, metric) => sum + metric.quarterly.length,
        0,
      ),
      latestPeriodEnd:
        all.toSorted((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0]
          ?.periodEnd ?? null,
      latestFiled:
        all.toSorted((a, b) => b.filed.localeCompare(a.filed))[0]?.filed ??
        null,
    },
    pointInTime: {
      mode: filedThrough ? "filing_date_cutoff" : "latest_available",
      asOfDate: filedThrough,
      cutoffAt: filedThrough ? `${filedThrough}T23:59:59.999Z` : null,
      excludedPostCutoffObservations,
      publicationPrecision: "sec_filed_date",
    },
    limitations: [
      "Quarterly duration trends include only directly reported standalone 10-Q periods between 70 and 120 days.",
      filedThrough
        ? `Fourth-quarter duration values are not derived from annual totals; filings and amendments after ${filedThrough} are excluded before selecting one record per period.`
        : "Fourth-quarter duration values are not derived from annual totals; amendments and later restatements replace earlier observations for the same period end.",
      "Values retain the exact SEC concept, unit, accession, form, filed date and filing index URL used for the observation.",
      "SEC Company Facts exposes a filed date, not an intraday acceptance timestamp; point-in-time cutoffs therefore operate at end-of-day UTC precision.",
    ],
  };
}
