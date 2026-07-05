import {
  canonicalEvidence,
  dedupeEvidence,
  type CanonicalEvidence,
} from "../shared/evidence";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MacroIndicator = {
  id: string;
  label: string;
  value: number;
  unit: string;
  period: string;
  provider: "fred" | "treasury" | "bls" | "bea";
  evidenceId: string;
  previousValue?: number;
  change?: number;
  calculation?: string;
};

export type MacroRegimeDimension = {
  id: "rates" | "inflation" | "labor" | "growth" | "fiscal";
  label: string;
  state: string;
  summary: string;
  evidence: string[];
};

export type MacroCoverageStatus =
  "available" | "missing_key" | "misconfigured" | "unavailable";
export type MacroProviderCoverage = {
  status: MacroCoverageStatus;
  indicators: number;
};
export type MacroEvidence = CanonicalEvidence<unknown, "macro">;
export type MacroContext = {
  asOf: string;
  indicators: MacroIndicator[];
  regime: {
    summary: string;
    dimensions: MacroRegimeDimension[];
    evidence: string[];
  };
  sources: MacroEvidence[];
  warnings: string[];
  coverage: Record<"fred" | "treasury" | "bls" | "bea", MacroProviderCoverage>;
  disclosures: Array<{ provider: string; text: string; url: string }>;
};

type CacheEntry = { expiresAt: number; value: unknown };
type ProviderData = {
  indicators: MacroIndicator[];
  sources: MacroEvidence[];
  warnings?: string[];
};

export type MacroContextClientOptions = {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  cacheTtlMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
};

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const BLS_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const TREASURY_URL =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page%5Bsize%5D=2";
const FRED_TERMS_URL = "https://fred.stlouisfed.org/docs/api/terms_of_use.html";
const FRED_DISCLOSURE =
  "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";

const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const number = (value: unknown) => {
  const parsed = Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(parsed))
    throw new Error(
      "Official macro response contained a non-numeric observation",
    );
  return parsed;
};
const dateTime = (date: string) =>
  new Date(`${date}T00:00:00.000Z`).toISOString();
const monthIndex = (item: { year: string; period: string }) =>
  Number(item.year) * 12 + Number(item.period.slice(1)) - 1;
const monthEnd = (item: { year: string; period: string }) =>
  new Date(
    Date.UTC(
      Number(item.year),
      Number(item.period.slice(1)),
      0,
      23,
      59,
      59,
      999,
    ),
  ).toISOString();
const quarterIndex = (period: string) =>
  Number(period.slice(0, 4)) * 4 + Number(period.slice(-1)) - 1;
const quarterEnd = (period: string) =>
  new Date(
    Date.UTC(
      Number(period.slice(0, 4)),
      Number(period.slice(-1)) * 3,
      0,
      23,
      59,
      59,
      999,
    ),
  ).toISOString();
const unique = (values: string[]) => [...new Set(values)];

function directionSummary(value: number, previous: number | undefined) {
  if (previous === undefined) return "";
  const change = round(value - previous);
  return `, ${change > 0 ? "up" : change < 0 ? "down" : "unchanged"} ${Math.abs(change).toFixed(2)} from the previous observation`;
}

export function describeMacroRegime(indicators: MacroIndicator[]) {
  const byId = new Map(indicators.map((item) => [item.id, item]));
  const dimensions: MacroRegimeDimension[] = [];
  const fedFunds = byId.get("effective_federal_funds_rate");
  const tenYear = byId.get("treasury_10_year_rate");
  const curve = byId.get("treasury_10y_2y_spread");
  if (fedFunds || tenYear || curve) {
    const anchor = fedFunds?.value ?? tenYear?.value ?? 0;
    const state =
      anchor >= 4
        ? "elevated rates"
        : anchor >= 2
          ? "moderate rates"
          : "low rates";
    const facts = [
      fedFunds ? `effective fed funds ${fedFunds.value.toFixed(2)}%` : "",
      tenYear ? `10-year Treasury ${tenYear.value.toFixed(2)}%` : "",
      curve ? `10y-2y spread ${curve.value.toFixed(2)} percentage points` : "",
    ].filter(Boolean);
    dimensions.push({
      id: "rates",
      label: "Rates",
      state,
      summary: facts.join("; "),
      evidence: unique(
        [fedFunds?.evidenceId, tenYear?.evidenceId, curve?.evidenceId].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    });
  }
  const inflation = byId.get("cpi_all_items_yoy");
  if (inflation) {
    const state =
      inflation.value >= 4
        ? "high inflation"
        : inflation.value >= 2.5
          ? "elevated inflation"
          : inflation.value >= 0
            ? "lower inflation"
            : "falling prices";
    dimensions.push({
      id: "inflation",
      label: "Inflation",
      state,
      summary: `CPI all items was ${inflation.value.toFixed(2)}% year over year for ${inflation.period}.`,
      evidence: [inflation.evidenceId],
    });
  }
  const unemployment = byId.get("unemployment_rate");
  if (unemployment) {
    const state =
      unemployment.value < 4
        ? "tight labor market"
        : unemployment.value <= 5
          ? "balanced labor market"
          : "soft labor market";
    dimensions.push({
      id: "labor",
      label: "Labor",
      state,
      summary: `Unemployment was ${unemployment.value.toFixed(1)}% for ${unemployment.period}${directionSummary(unemployment.value, unemployment.previousValue)}.`,
      evidence: [unemployment.evidenceId],
    });
  }
  const gdp = byId.get("real_gdp_qoq_annualized");
  if (gdp) {
    const state =
      gdp.value < 0
        ? "contracting growth"
        : gdp.value < 2
          ? "modest growth"
          : gdp.value < 4
            ? "solid growth"
            : "strong growth";
    dimensions.push({
      id: "growth",
      label: "Growth",
      state,
      summary: `Real GDP changed ${gdp.value.toFixed(1)}% at an annual rate in ${gdp.period}.`,
      evidence: [gdp.evidenceId],
    });
  }
  const debt = byId.get("total_public_debt_outstanding");
  if (debt)
    dimensions.push({
      id: "fiscal",
      label: "Fiscal",
      state: "reported debt level",
      summary: `Total public debt outstanding was $${(debt.value / 1e12).toFixed(2)} trillion on ${debt.period}.`,
      evidence: [debt.evidenceId],
    });
  const evidence = unique(dimensions.flatMap((item) => item.evidence));
  return {
    summary: dimensions.length
      ? `${dimensions.map((item) => `${item.label}: ${item.state}`).join("; ")}. Descriptive context only, not a trading signal.`
      : "Official macro context is currently unavailable.",
    dimensions,
    evidence,
  };
}

export class MacroContextClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: Record<string, string | undefined>;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: MacroContextClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.env = options.env ?? process.env;
    this.cacheTtlMs = options.cacheTtlMs ?? 6 * 60 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRetries = options.maxRetries ?? 2;
    if (
      this.cacheTtlMs <= 0 ||
      this.timeoutMs <= 0 ||
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > 4
    )
      throw new Error("Macro client options are invalid");
  }

  private async request(key: string, input: string, init?: RequestInit) {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(input, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          if (
            TRANSIENT_STATUS.has(response.status) &&
            attempt < this.maxRetries
          ) {
            await this.sleep(250 * 2 ** attempt);
            continue;
          }
          throw new Error(
            `Official macro provider returned HTTP ${response.status}`,
          );
        }
        const value = await response.json();
        this.cache.set(key, { value, expiresAt: this.now() + this.cacheTtlMs });
        return value;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) await this.sleep(250 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Official macro provider request failed");
  }

  private async treasury(retrievedAt: string): Promise<ProviderData> {
    const payload = (await this.request(
      "treasury:debt-to-penny",
      TREASURY_URL,
    )) as { data?: Array<Record<string, string>> };
    const rows = payload.data;
    if (!rows?.length)
      throw new Error("Treasury returned no debt observations");
    const latest = rows[0]!;
    const previous = rows[1];
    const fields = [
      [
        "total_public_debt_outstanding",
        "Total public debt outstanding",
        "tot_pub_debt_out_amt",
      ],
      [
        "debt_held_by_public",
        "Debt held by the public",
        "debt_held_public_amt",
      ],
      [
        "intragovernmental_holdings",
        "Intragovernmental holdings",
        "intragov_hold_amt",
      ],
    ] as const;
    const evidenceId = "macro:treasury:debt-to-penny";
    const data = {
      recordDate: latest.record_date,
      totalPublicDebtOutstanding: number(latest.tot_pub_debt_out_amt),
      debtHeldByPublic: number(latest.debt_held_public_amt),
      intragovernmentalHoldings: number(latest.intragov_hold_amt),
      previous: previous
        ? {
            recordDate: previous.record_date,
            totalPublicDebtOutstanding: number(previous.tot_pub_debt_out_amt),
            debtHeldByPublic: number(previous.debt_held_public_amt),
            intragovernmentalHoldings: number(previous.intragov_hold_amt),
          }
        : null,
    };
    const source = canonicalEvidence({
      id: evidenceId,
      provider: "treasury",
      sourceId: `debt-to-penny:${latest.record_date}`,
      category: "macro",
      authority: "official",
      claimStatus: "official_record",
      title: "U.S. Treasury Debt to the Penny",
      url: TREASURY_URL,
      asOf: dateTime(latest.record_date),
      retrievedAt,
      entityIds: {},
      data,
    });
    const indicators = fields.map(([id, label, field]) => {
      const value = number(latest[field]);
      const previousValue = previous ? number(previous[field]) : undefined;
      return {
        id,
        label,
        value,
        unit: "USD",
        period: latest.record_date,
        provider: "treasury" as const,
        evidenceId,
        ...(previousValue === undefined
          ? {}
          : { previousValue, change: round(value - previousValue, 2) }),
      };
    });
    return { indicators, sources: [source] };
  }

  private async bls(retrievedAt: string): Promise<ProviderData> {
    const year = new Date(this.now()).getUTCFullYear();
    const body = JSON.stringify({
      seriesid: ["CUUR0000SA0", "LNS14000000"],
      startyear: String(year - 2),
      endyear: String(year),
    });
    const payload = (await this.request(`bls:${year}`, BLS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })) as {
      status?: string;
      message?: string[];
      Results?: {
        series?: Array<{
          seriesID: string;
          data: Array<{
            year: string;
            period: string;
            periodName: string;
            value: string;
          }>;
        }>;
      };
    };
    if (payload.status !== "REQUEST_SUCCEEDED")
      throw new Error(
        `BLS request failed${payload.message?.length ? `: ${payload.message.join(" ")}` : ""}`,
      );
    const series = payload.Results?.series ?? [];
    const cpi = series
      .find((item) => item.seriesID === "CUUR0000SA0")
      ?.data.filter((item) => /^M(0[1-9]|1[0-2])$/.test(item.period))
      .sort((a, b) => monthIndex(b) - monthIndex(a));
    const labor = series
      .find((item) => item.seriesID === "LNS14000000")
      ?.data.filter((item) => /^M(0[1-9]|1[0-2])$/.test(item.period))
      .sort((a, b) => monthIndex(b) - monthIndex(a));
    if (!cpi?.length || !labor?.length)
      throw new Error("BLS returned incomplete CPI or unemployment series");
    const latestCpi = cpi[0]!;
    const yearAgo = cpi.find(
      (item) => monthIndex(item) === monthIndex(latestCpi) - 12,
    );
    if (!yearAgo)
      throw new Error("BLS CPI response did not include a year-ago comparison");
    const latestLabor = labor[0]!;
    const previousLabor = labor[1];
    const cpiValue = number(latestCpi.value);
    const cpiYearAgo = number(yearAgo.value);
    const cpiEvidenceId = "macro:bls:CUUR0000SA0";
    const laborEvidenceId = "macro:bls:LNS14000000";
    const cpiSource = canonicalEvidence({
      id: cpiEvidenceId,
      provider: "bls",
      sourceId: `CUUR0000SA0:${latestCpi.year}-${latestCpi.period}`,
      category: "macro",
      authority: "official",
      claimStatus: "official_record",
      title: "BLS CPI for All Urban Consumers: All Items",
      url: BLS_URL,
      asOf: monthEnd(latestCpi),
      retrievedAt,
      entityIds: {},
      data: {
        seriesId: "CUUR0000SA0",
        seasonalAdjustment: "not seasonally adjusted",
        latest: latestCpi,
        yearAgo,
        calculation: "(latest index / year-ago index - 1) * 100",
      },
    });
    const laborSource = canonicalEvidence({
      id: laborEvidenceId,
      provider: "bls",
      sourceId: `LNS14000000:${latestLabor.year}-${latestLabor.period}`,
      category: "macro",
      authority: "official",
      claimStatus: "official_record",
      title: "BLS unemployment rate",
      url: BLS_URL,
      asOf: monthEnd(latestLabor),
      retrievedAt,
      entityIds: {},
      data: {
        seriesId: "LNS14000000",
        seasonalAdjustment: "seasonally adjusted",
        latest: latestLabor,
        previous: previousLabor ?? null,
      },
    });
    const unemployment = number(latestLabor.value);
    const previousUnemployment = previousLabor
      ? number(previousLabor.value)
      : undefined;
    return {
      indicators: [
        {
          id: "cpi_all_items_yoy",
          label: "CPI all items, year over year",
          value: round((cpiValue / cpiYearAgo - 1) * 100),
          unit: "%",
          period: `${latestCpi.periodName} ${latestCpi.year}`,
          provider: "bls",
          evidenceId: cpiEvidenceId,
          calculation:
            "Calculated from official BLS latest and year-ago CPI index values.",
        },
        {
          id: "unemployment_rate",
          label: "Unemployment rate",
          value: unemployment,
          unit: "%",
          period: `${latestLabor.periodName} ${latestLabor.year}`,
          provider: "bls",
          evidenceId: laborEvidenceId,
          ...(previousUnemployment === undefined
            ? {}
            : {
                previousValue: previousUnemployment,
                change: round(unemployment - previousUnemployment),
              }),
        },
      ],
      sources: [cpiSource, laborSource],
    };
  }

  private async fred(retrievedAt: string, key: string): Promise<ProviderData> {
    const definitions = [
      [
        "DFF",
        "effective_federal_funds_rate",
        "Effective federal funds rate",
        "%",
      ],
      [
        "DGS10",
        "treasury_10_year_rate",
        "10-year Treasury constant maturity rate",
        "%",
      ],
      [
        "T10Y2Y",
        "treasury_10y_2y_spread",
        "10-year minus 2-year Treasury spread",
        "percentage points",
      ],
    ] as const;
    const settled = await Promise.allSettled(
      definitions.map(async ([seriesId, id, label, unit]) => {
        const publicUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&file_type=json&sort_order=desc&limit=4`;
        const payload = (await this.request(
          `fred:${seriesId}`,
          `${publicUrl}&api_key=${encodeURIComponent(key)}`,
        )) as { observations?: Array<{ date: string; value: string }> };
        const observations = (payload.observations ?? []).filter((item) =>
          Number.isFinite(Number(item.value)),
        );
        if (!observations.length)
          throw new Error(`${seriesId} returned no numeric observations`);
        const latest = observations[0]!;
        const previous = observations[1];
        const value = number(latest.value);
        const previousValue = previous ? number(previous.value) : undefined;
        const evidenceId = `macro:fred:${seriesId}`;
        const source = canonicalEvidence({
          id: evidenceId,
          provider: "fred",
          sourceId: `${seriesId}:${latest.date}`,
          category: "macro",
          authority: "official",
          claimStatus: "official_record",
          title: `FRED ${label}`,
          url: publicUrl,
          asOf: dateTime(latest.date),
          retrievedAt,
          entityIds: {},
          data: { seriesId, latest, previous: previous ?? null },
        });
        const indicator: MacroIndicator = {
          id,
          label,
          value,
          unit,
          period: latest.date,
          provider: "fred",
          evidenceId,
          ...(previousValue === undefined
            ? {}
            : { previousValue, change: round(value - previousValue) }),
        };
        return { source, indicator };
      }),
    );
    const indicators: MacroIndicator[] = [];
    const sources: MacroEvidence[] = [];
    const warnings: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        indicators.push(result.value.indicator);
        sources.push(result.value.source);
      } else
        warnings.push(
          `FRED ${definitions[index]![0]} is temporarily unavailable.`,
        );
    });
    if (!indicators.length)
      throw new Error("FRED returned no rate observations");
    return { indicators, sources, warnings };
  }

  private async bea(
    retrievedAt: string,
    userId: string,
  ): Promise<ProviderData> {
    const year = new Date(this.now()).getUTCFullYear();
    const publicParams = new URLSearchParams({
      method: "GetData",
      DataSetName: "NIPA",
      TableName: "T10101",
      Frequency: "Q",
      Year: `${year - 1},${year}`,
      ResultFormat: "JSON",
    });
    const publicUrl = `https://apps.bea.gov/api/data?${publicParams}`;
    const payload = (await this.request(
      `bea:gdp:${year}`,
      `${publicUrl}&UserID=${encodeURIComponent(userId)}`,
    )) as {
      BEAAPI?: {
        Results?: {
          Data?: Array<{
            LineNumber?: string;
            LineDescription?: string;
            TimePeriod?: string;
            DataValue?: string;
            CL_UNIT?: string;
            UnitMult?: string;
          }>;
          Error?: { APIErrorDescription?: string };
        };
      };
    };
    const results = payload.BEAAPI?.Results;
    if (results?.Error)
      throw new Error(
        results.Error.APIErrorDescription ?? "BEA request failed",
      );
    const rows = (results?.Data ?? [])
      .filter(
        (item) =>
          item.LineNumber === "1" ||
          /^gross domestic product$/i.test(item.LineDescription ?? ""),
      )
      .filter(
        (item) =>
          /^\d{4}Q[1-4]$/.test(item.TimePeriod ?? "") &&
          Number.isFinite(Number(String(item.DataValue).replaceAll(",", ""))),
      )
      .sort(
        (a, b) => quarterIndex(b.TimePeriod!) - quarterIndex(a.TimePeriod!),
      );
    const latest = rows[0];
    if (!latest?.TimePeriod)
      throw new Error("BEA returned no quarterly real GDP observation");
    const previous = rows[1];
    const value = number(latest.DataValue);
    const previousValue = previous ? number(previous.DataValue) : undefined;
    const evidenceId = "macro:bea:real-gdp-qoq";
    const source = canonicalEvidence({
      id: evidenceId,
      provider: "bea",
      sourceId: `NIPA:T10101:1:${latest.TimePeriod}`,
      category: "macro",
      authority: "official",
      claimStatus: "official_record",
      title: "BEA percent change from preceding period in real GDP",
      url: publicUrl,
      asOf: quarterEnd(latest.TimePeriod),
      retrievedAt,
      entityIds: {},
      data: {
        dataset: "NIPA",
        tableName: "T10101",
        lineNumber: latest.LineNumber ?? "1",
        latest,
        previous: previous ?? null,
      },
    });
    return {
      indicators: [
        {
          id: "real_gdp_qoq_annualized",
          label: "Real GDP change from preceding quarter",
          value,
          unit: "% annual rate",
          period: latest.TimePeriod,
          provider: "bea",
          evidenceId,
          ...(previousValue === undefined
            ? {}
            : { previousValue, change: round(value - previousValue) }),
        },
      ],
      sources: [source],
    };
  }

  async context(): Promise<MacroContext> {
    const retrievedAt = new Date(this.now()).toISOString();
    const coverage: MacroContext["coverage"] = {
      fred: { status: "missing_key", indicators: 0 },
      treasury: { status: "unavailable", indicators: 0 },
      bls: { status: "unavailable", indicators: 0 },
      bea: { status: "missing_key", indicators: 0 },
    };
    const warnings: string[] = [];
    const tasks: Array<{
      provider: keyof MacroContext["coverage"];
      run: Promise<ProviderData>;
    }> = [
      { provider: "treasury", run: this.treasury(retrievedAt) },
      { provider: "bls", run: this.bls(retrievedAt) },
    ];
    const fredKey = this.env.FRED_API_KEY?.trim() ?? "";
    if (fredKey) {
      if (/^[a-z0-9]{32}$/.test(fredKey))
        tasks.push({ provider: "fred", run: this.fred(retrievedAt, fredKey) });
      else {
        coverage.fred.status = "misconfigured";
        warnings.push(
          "FRED coverage is unavailable because FRED_API_KEY must be a 32-character lowercase alphanumeric key.",
        );
      }
    } else
      warnings.push(
        "FRED coverage is unavailable until FRED_API_KEY is configured; rates and yield-curve context are incomplete.",
      );
    const beaUserId = this.env.BEA_USER_ID?.trim() ?? "";
    if (beaUserId) {
      if (beaUserId.length === 36)
        tasks.push({ provider: "bea", run: this.bea(retrievedAt, beaUserId) });
      else {
        coverage.bea.status = "misconfigured";
        warnings.push(
          "BEA growth coverage is unavailable because BEA_USER_ID must be 36 characters.",
        );
      }
    } else
      warnings.push(
        "BEA growth coverage is unavailable until BEA_USER_ID is configured.",
      );
    const settled = await Promise.allSettled(tasks.map((task) => task.run));
    const indicators: MacroIndicator[] = [];
    const sources: MacroEvidence[] = [];
    settled.forEach((result, index) => {
      const provider = tasks[index]!.provider;
      if (result.status === "fulfilled") {
        indicators.push(...result.value.indicators);
        sources.push(...result.value.sources);
        warnings.push(...(result.value.warnings ?? []));
        coverage[provider] = {
          status: "available",
          indicators: result.value.indicators.length,
        };
      } else {
        coverage[provider] = { status: "unavailable", indicators: 0 };
        warnings.push(
          `${provider === "bea" ? "BEA" : provider === "bls" ? "BLS" : provider === "fred" ? "FRED" : "Treasury Fiscal Data"} is temporarily unavailable.`,
        );
      }
    });
    const deduped = dedupeEvidence(sources);
    indicators.sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label),
    );
    return {
      asOf: retrievedAt,
      indicators,
      regime: describeMacroRegime(indicators),
      sources: deduped.records,
      warnings: unique(warnings),
      coverage,
      disclosures: [
        { provider: "fred", text: FRED_DISCLOSURE, url: FRED_TERMS_URL },
      ],
    };
  }
}

let sharedMacroClient: MacroContextClient | null = null;
export function getOfficialMacroContext() {
  sharedMacroClient ??= new MacroContextClient();
  return sharedMacroClient.context();
}
