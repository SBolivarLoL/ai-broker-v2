import { canonicalEvidence, type CanonicalEvidence } from "../shared/evidence";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type OpenFigiStatus =
  "matched" | "ambiguous" | "not_found" | "rate_limited" | "unavailable";
export type OpenFigiKeyStatus =
  "anonymous" | "configured" | "misconfigured" | "rejected";

export type OpenFigiInstrument = {
  figi: string;
  compositeFigi: string | null;
  shareClassFigi: string | null;
  ticker: string;
  name: string;
  exchangeCode: string;
  marketSector: string;
  securityType: string | null;
  securityType2: string | null;
  description: string | null;
};

export type OpenFigiIdentity = {
  symbol: string;
  companyName: string;
  status: OpenFigiStatus;
  keyStatus: OpenFigiKeyStatus;
  matchQuality: "company_name_confirmed" | "single_candidate" | null;
  canonicalFigi: string | null;
  selected: OpenFigiInstrument | null;
  candidates: OpenFigiInstrument[];
  candidateCount: number;
  sources: Array<CanonicalEvidence<unknown, "identity">>;
  warnings: string[];
  asOf: string;
};

export type OpenFigiClientOptions = {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  cacheTtlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  minIntervalMs?: number;
};

type CacheEntry = { expiresAt: number; value: OpenFigiIdentity };

class OpenFigiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly resetMs: number | null,
  ) {
    super(`OpenFIGI returned HTTP ${status}`);
  }
}

const API_URL = "https://api.openfigi.com/v3/mapping";
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const symbolPattern = /^[A-Z.]{1,10}$/;
const figiPattern = /^[A-Z0-9]{12}$/;
const keyPattern = /^[A-Za-z0-9_-]{8,256}$/;

const cleanText = (value: unknown, maximum = 500) =>
  String(value ?? "")
    .replace(/[\t\r\n ]+/g, " ")
    .trim()
    .slice(0, maximum);
const figi = (value: unknown) => {
  const normalized = cleanText(value, 12).toUpperCase();
  return figiPattern.test(normalized) ? normalized : null;
};
const unique = (values: string[]) => [...new Set(values)];

function companyKey(value: string) {
  return cleanText(value, 200)
    .toLowerCase()
    .replace(
      /\b(new )?(class [a-z0-9]+|common stock|ordinary shares?|american depositary shares?)\b.*$/i,
      "",
    )
    .replace(/\bintl\b/g, "international")
    .replace(/\bcorp\b/g, "corporation")
    .replace(
      /\b(incorporated|inc|corporation|company|co|holdings?|group|plc|limited|ltd)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesMatch(companyName: string, candidateName: string) {
  const expected = companyKey(companyName),
    candidate = companyKey(candidateName);
  return Boolean(
    expected &&
    candidate &&
    (expected === candidate ||
      expected.includes(candidate) ||
      candidate.includes(expected)),
  );
}

function instrument(raw: unknown, symbol: string): OpenFigiInstrument | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const primaryFigi = figi(item.figi);
  const ticker = cleanText(item.ticker, 40).toUpperCase();
  const exchangeCode = cleanText(item.exchCode, 40).toUpperCase();
  const marketSector = cleanText(item.marketSector, 80);
  const securityType2 = cleanText(item.securityType2, 120) || null;
  if (
    !primaryFigi ||
    ticker !== symbol ||
    exchangeCode !== "US" ||
    marketSector.toLowerCase() !== "equity" ||
    /option|warrant|future/i.test(securityType2 ?? "")
  )
    return null;
  return {
    figi: primaryFigi,
    compositeFigi: figi(item.compositeFIGI),
    shareClassFigi: figi(item.shareClassFIGI),
    ticker,
    name: cleanText(item.name, 240) || symbol,
    exchangeCode,
    marketSector,
    securityType: cleanText(item.securityType, 120) || null,
    securityType2,
    description: cleanText(item.securityDescription, 240) || null,
  };
}

function collapseCandidates(values: OpenFigiInstrument[]) {
  const grouped = new Map<string, OpenFigiInstrument>();
  for (const value of values) {
    const key = value.compositeFigi ?? value.figi;
    const current = grouped.get(key);
    if (!current || value.figi === value.compositeFigi) grouped.set(key, value);
  }
  return [...grouped.values()].sort((a, b) =>
    (a.compositeFigi ?? a.figi).localeCompare(b.compositeFigi ?? b.figi),
  );
}

function selectedCandidate(
  candidates: OpenFigiInstrument[],
  companyName: string,
) {
  if (candidates.length === 1)
    return {
      selected: candidates[0]!,
      matchQuality: namesMatch(companyName, candidates[0]!.name)
        ? ("company_name_confirmed" as const)
        : ("single_candidate" as const),
    };
  const confirmed = candidates.filter((candidate) =>
    namesMatch(companyName, candidate.name),
  );
  if (confirmed.length === 1)
    return {
      selected: confirmed[0]!,
      matchQuality: "company_name_confirmed" as const,
    };
  const composite = confirmed.filter(
    (candidate) => candidate.figi === candidate.compositeFigi,
  );
  if (composite.length === 1)
    return {
      selected: composite[0]!,
      matchQuality: "company_name_confirmed" as const,
    };
  return { selected: null, matchQuality: null };
}

function resetDelay(response: Response) {
  for (const header of ["retry-after", "ratelimit-reset"]) {
    const value = Number(response.headers.get(header));
    if (Number.isFinite(value) && value >= 0) return value * 1_000;
  }
  return null;
}

export class OpenFigiClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: Record<string, string | undefined>;
  private readonly cacheTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<OpenFigiIdentity>>();
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt: number | null = null;

  constructor(options: OpenFigiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.env = options.env ?? process.env;
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 2 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.minIntervalMs = options.minIntervalMs ?? 2_500;
    if (
      [this.cacheTtlMs, this.failureTtlMs, this.timeoutMs].some(
        (value) => value <= 0,
      ) ||
      this.minIntervalMs < 0 ||
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > 3
    )
      throw new Error("OpenFIGI client options are invalid");
  }

  private scheduled<T>(run: () => Promise<T>) {
    const result = this.queue.then(async () => {
      if (this.lastRequestAt !== null) {
        const waitMs = Math.max(
          0,
          this.lastRequestAt + this.minIntervalMs - this.now(),
        );
        if (waitMs) await this.sleep(waitMs);
      }
      this.lastRequestAt = this.now();
      return run();
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async request(symbol: string, apiKey: string | null) {
    let lastError: unknown;
    const body = JSON.stringify([
      {
        idType: "TICKER",
        idValue: symbol,
        exchCode: "US",
        marketSecDes: "Equity",
      },
    ]);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "ai-broker-v2/1.0",
        };
        if (apiKey) headers["X-OPENFIGI-APIKEY"] = apiKey;
        const response = await this.scheduled(() =>
          this.fetchImpl(API_URL, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        );
        if (!response.ok)
          throw new OpenFigiHttpError(response.status, resetDelay(response));
        return await response.json();
      } catch (error) {
        lastError = error;
        const transient =
          !(error instanceof OpenFigiHttpError) ||
          TRANSIENT_STATUS.has(error.status);
        if (!transient || attempt >= this.maxRetries) break;
        const delay =
          error instanceof OpenFigiHttpError && error.resetMs !== null
            ? Math.min(error.resetMs, 60_000)
            : this.minIntervalMs * 2 ** attempt;
        if (delay) await this.sleep(delay);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("OpenFIGI request failed");
  }

  mapIdentity(
    rawSymbol: string,
    rawCompanyName: string,
  ): Promise<OpenFigiIdentity> {
    const symbol = rawSymbol.trim().toUpperCase();
    const companyName = cleanText(rawCompanyName, 200);
    if (!symbolPattern.test(symbol))
      throw new Error("A valid stock symbol is required for OpenFIGI mapping");
    if (companyName.length < 2)
      throw new Error("A company name is required for OpenFIGI mapping");
    const configuredKey = this.env.OPENFIGI_API_KEY?.trim() ?? "";
    const keyStatus: OpenFigiKeyStatus = configuredKey
      ? keyPattern.test(configuredKey)
        ? "configured"
        : "misconfigured"
      : "anonymous";
    const apiKey = keyStatus === "configured" ? configuredKey : null;
    const cacheKey = `${symbol}:${companyKey(companyName)}:${keyStatus}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now())
      return Promise.resolve(cached.value);
    const active = this.inflight.get(cacheKey);
    if (active) return active;
    const request = (async () => {
      const baseWarnings =
        keyStatus === "misconfigured"
          ? [
              "OPENFIGI_API_KEY has an invalid format and was ignored; public anonymous mapping was used.",
            ]
          : [];
      try {
        const payload = await this.request(symbol, apiKey);
        const asOf = new Date(this.now()).toISOString();
        if (
          !Array.isArray(payload) ||
          payload.length !== 1 ||
          !payload[0] ||
          typeof payload[0] !== "object"
        )
          throw new Error("OpenFIGI returned an invalid mapping payload");
        const result = payload[0] as {
          data?: unknown[];
          warning?: unknown;
          error?: unknown;
        };
        if (result.error)
          throw new Error(
            `OpenFIGI mapping failed: ${cleanText(result.error, 300)}`,
          );
        const rawCandidates = Array.isArray(result.data)
          ? result.data
              .slice(0, 100)
              .map((value) => instrument(value, symbol))
              .filter((value): value is OpenFigiInstrument => Boolean(value))
          : [];
        const allCandidates = collapseCandidates(rawCandidates);
        const candidates = allCandidates.slice(0, 8);
        const choice = selectedCandidate(allCandidates, companyName);
        const status: OpenFigiStatus = choice.selected
          ? "matched"
          : allCandidates.length
            ? "ambiguous"
            : "not_found";
        const canonicalFigi = choice.selected
          ? (choice.selected.compositeFigi ?? choice.selected.figi)
          : null;
        const warnings = [...baseWarnings];
        if (status === "ambiguous")
          warnings.push(
            `OpenFIGI returned ${allCandidates.length} distinct US-equity identities; no FIGI was selected.`,
          );
        else if (status === "not_found")
          warnings.push(
            cleanText(result.warning, 300) ||
              "OpenFIGI returned no US-equity identity for this ticker.",
          );
        else if (choice.matchQuality === "single_candidate")
          warnings.push(
            "OpenFIGI returned one constrained candidate, but its company name did not independently match the Alpaca name.",
          );
        if (allCandidates.length > candidates.length)
          warnings.push(
            `Only the first ${candidates.length} OpenFIGI candidates are displayed.`,
          );
        const data = {
          request: {
            idType: "TICKER",
            idValue: symbol,
            exchCode: "US",
            marketSecDes: "Equity",
          },
          status,
          matchQuality: choice.matchQuality,
          canonicalFigi,
          selected: choice.selected,
          candidates,
          candidateCount: allCandidates.length,
          providerWarning: cleanText(result.warning, 300) || null,
        };
        const source = canonicalEvidence({
          id: `openfigi:mapping:${symbol}`,
          provider: "openfigi",
          sourceId: `TICKER:${symbol}:US:Equity`,
          category: "identity",
          authority: "official",
          claimStatus: "official_record",
          title: `${symbol} OpenFIGI identity mapping`,
          url: API_URL,
          asOf,
          retrievedAt: asOf,
          entityIds: {
            symbol,
            ...(canonicalFigi ? { figi: canonicalFigi } : {}),
          },
          data,
        });
        const value: OpenFigiIdentity = {
          symbol,
          companyName,
          status,
          keyStatus,
          matchQuality: choice.matchQuality,
          canonicalFigi,
          selected: choice.selected,
          candidates,
          candidateCount: allCandidates.length,
          sources: [source],
          warnings: unique(warnings),
          asOf,
        };
        this.cache.set(cacheKey, {
          value,
          expiresAt: this.now() + this.cacheTtlMs,
        });
        return value;
      } catch (error) {
        const asOf = new Date(this.now()).toISOString();
        const rateLimited =
          error instanceof OpenFigiHttpError && error.status === 429;
        const rejected =
          error instanceof OpenFigiHttpError && error.status === 401;
        const value: OpenFigiIdentity = {
          symbol,
          companyName,
          status: rateLimited ? "rate_limited" : "unavailable",
          keyStatus: rejected ? "rejected" : keyStatus,
          matchQuality: null,
          canonicalFigi: null,
          selected: null,
          candidates: [],
          candidateCount: 0,
          sources: [],
          asOf,
          warnings: unique([
            ...baseWarnings,
            rejected
              ? "The configured OpenFIGI API key was rejected; no anonymous retry was attempted."
              : rateLimited
                ? "OpenFIGI identity mapping is rate limited; no ticker-to-FIGI join should be assumed."
                : "OpenFIGI identity mapping is temporarily unavailable; no ticker-to-FIGI join should be assumed.",
          ]),
        };
        this.cache.set(cacheKey, {
          value,
          expiresAt: this.now() + this.failureTtlMs,
        });
        return value;
      } finally {
        this.inflight.delete(cacheKey);
      }
    })();
    this.inflight.set(cacheKey, request);
    return request;
  }
}

let sharedOpenFigiClient: OpenFigiClient | null = null;
export function getOpenFigiIdentity(symbol: string, companyName: string) {
  sharedOpenFigiClient ??= new OpenFigiClient();
  return sharedOpenFigiClient.mapIdentity(symbol, companyName);
}
