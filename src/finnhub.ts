import { createHash } from "node:crypto";
import { canonicalEvidence, canonicalEvidenceUrl, dedupeEvidence, type CanonicalEvidence } from "./evidence";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type EndpointCoverageStatus = "available" | "rate_limited" | "unavailable";
type FinnhubCoverageStatus = "missing_key" | "misconfigured" | EndpointCoverageStatus;
type EndpointResult<T> = { status: EndpointCoverageStatus; value: T | null; retrievedAt: string };
type CacheEntry = { expiresAt: number; value: EndpointResult<unknown> };

export type FinnhubProfile = {
  name: string;
  ticker: string;
  country: string | null;
  currency: string | null;
  exchange: string | null;
  industry: string | null;
  ipoDate: string | null;
  webUrl: string | null;
};

export type FinnhubEarningsSurprise = {
  period: string;
  actual: number;
  estimate: number;
  surprise: number | null;
  surprisePercent: number | null;
  quarter: number | null;
  year: number | null;
};

export type FinnhubNewsArticle = {
  id: string;
  evidenceId: string;
  headline: string;
  summary: string;
  source: string;
  category: string;
  relatedSymbols: string[];
  url: string;
  publishedAt: string;
};

export type FinnhubEvidence = CanonicalEvidence<unknown, "identity" | "fundamentals" | "news">;
export type FinnhubCompanyEnrichment = {
  symbol: string;
  configured: boolean;
  status: FinnhubCoverageStatus | "partial";
  profile: FinnhubProfile | null;
  earnings: FinnhubEarningsSurprise[];
  news: FinnhubNewsArticle[];
  sources: FinnhubEvidence[];
  coverage: Record<"profile" | "earnings" | "news", FinnhubCoverageStatus>;
  warnings: string[];
  asOf: string;
};

export type FinnhubClientOptions = {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  profileTtlMs?: number;
  earningsTtlMs?: number;
  newsTtlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  minIntervalMs?: number;
};

class FinnhubHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) { super(`Finnhub returned HTTP ${status}`); }
}

const API_URL = "https://finnhub.io/api/v1";
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const symbolPattern = /^[A-Z.]{1,10}$/;
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;

const text = (value: unknown, maximum = 500) => String(value ?? "").replace(/[\t\r\n ]+/g, " ").trim().slice(0, maximum);
const finite = (value: unknown) => {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
};
const webUrl = (value: unknown) => {
  try {
    const url = new URL(String(value ?? ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
};
const periodDate = (value: unknown) => {
  const result = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) && Number.isFinite(new Date(`${result}T00:00:00.000Z`).getTime()) ? result : null;
};
const unique = (values: string[]) => [...new Set(values)];

function retryAfterMs(response: Response, now: number) {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function profileFrom(payload: unknown, symbol: string): FinnhubProfile | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const item = payload as Record<string, unknown>;
  const ticker = text(item.ticker, 20).toUpperCase();
  const name = text(item.name, 200);
  if (ticker !== symbol || !name) return null;
  return {
    name, ticker,
    country: text(item.country, 80) || null,
    currency: text(item.currency, 12) || null,
    exchange: text(item.exchange, 120) || null,
    industry: text(item.finnhubIndustry, 120) || null,
    ipoDate: periodDate(item.ipo),
    webUrl: webUrl(item.weburl),
  };
}

function earningsFrom(payload: unknown) {
  if (!Array.isArray(payload)) throw new Error("Finnhub returned an invalid earnings payload");
  return payload.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const period = periodDate(item.period), actual = finite(item.actual), estimate = finite(item.estimate);
    if (!period || actual === null || estimate === null) return [];
    const quarter = finite(item.quarter), year = finite(item.year);
    return [{
      period, actual, estimate,
      surprise: finite(item.surprise),
      surprisePercent: finite(item.surprisePercent),
      quarter: quarter !== null && Number.isInteger(quarter) ? quarter : null,
      year: year !== null && Number.isInteger(year) ? year : null,
    } satisfies FinnhubEarningsSurprise];
  }).sort((a, b) => b.period.localeCompare(a.period)).slice(0, 4);
}

function newsFrom(payload: unknown, symbol: string) {
  if (!Array.isArray(payload)) throw new Error("Finnhub returned an invalid company-news payload");
  const seen = new Set<string>();
  return payload.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const url = webUrl(item.url), headline = text(item.headline, 400), seconds = finite(item.datetime);
    if (!url || !headline || seconds === null || seconds <= 0) return [];
    const published = new Date(seconds * 1_000);
    if (!Number.isFinite(published.getTime())) return [];
    const providerId = text(item.id, 80) || createHash("sha256").update(canonicalEvidenceUrl(url)).digest("hex").slice(0, 24);
    const evidenceId = `finnhub:news:${providerId}`;
    if (seen.has(evidenceId)) return [];
    seen.add(evidenceId);
    const relatedSymbols = text(item.related, 300).split(/[ ,]+/).map(value => value.toUpperCase()).filter(value => symbolPattern.test(value)).slice(0, 12);
    return [{
      id: providerId, evidenceId, headline,
      summary: text(item.summary, 2_000),
      source: text(item.source, 120) || "Finnhub",
      category: text(item.category, 80) || "company",
      relatedSymbols: unique(relatedSymbols),
      url, publishedAt: published.toISOString(),
    } satisfies FinnhubNewsArticle];
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 10);
}

export class FinnhubClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: Record<string, string | undefined>;
  private readonly profileTtlMs: number;
  private readonly earningsTtlMs: number;
  private readonly newsTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<EndpointResult<unknown>>>();
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt: number | null = null;

  constructor(options: FinnhubClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.env = options.env ?? process.env;
    this.profileTtlMs = options.profileTtlMs ?? 24 * 60 * 60_000;
    this.earningsTtlMs = options.earningsTtlMs ?? 6 * 60 * 60_000;
    this.newsTtlMs = options.newsTtlMs ?? 10 * 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.minIntervalMs = options.minIntervalMs ?? 1_100;
    if ([this.profileTtlMs, this.earningsTtlMs, this.newsTtlMs, this.failureTtlMs, this.timeoutMs].some(value => value <= 0) || this.minIntervalMs < 0 || !Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 3) throw new Error("Finnhub client options are invalid");
  }

  private scheduled<T>(run: () => Promise<T>) {
    const result = this.queue.then(async () => {
      if (this.lastRequestAt !== null) {
        const waitMs = Math.max(0, this.lastRequestAt + this.minIntervalMs - this.now());
        if (waitMs) await this.sleep(waitMs);
      }
      this.lastRequestAt = this.now();
      return run();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async fetchJson(url: string, key: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.scheduled(() => this.fetchImpl(url, { headers: { accept: "application/json", "user-agent": "ai-broker-v2/1.0", "X-Finnhub-Token": key }, signal: AbortSignal.timeout(this.timeoutMs) }));
        if (!response.ok) throw new FinnhubHttpError(response.status, retryAfterMs(response, this.now()));
        return await response.json();
      } catch (error) {
        lastError = error;
        const transient = !(error instanceof FinnhubHttpError) || TRANSIENT_STATUS.has(error.status);
        if (!transient || attempt >= this.maxRetries) break;
        const delay = error instanceof FinnhubHttpError && error.retryAfterMs !== null ? Math.min(error.retryAfterMs, 60_000) : this.minIntervalMs * 2 ** attempt;
        if (delay) await this.sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Finnhub request failed");
  }

  private endpoint<T>(cacheKey: string, url: string, key: string, successTtlMs: number): Promise<EndpointResult<T>> {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value as EndpointResult<T>);
    const active = this.inflight.get(cacheKey);
    if (active) return active as Promise<EndpointResult<T>>;
    const request = (async () => {
      try {
        const value = await this.fetchJson(url, key) as T;
        const retrievedAt = new Date(this.now()).toISOString();
        const result: EndpointResult<T> = { status: "available", value, retrievedAt };
        this.cache.set(cacheKey, { value: result, expiresAt: this.now() + successTtlMs });
        return result;
      } catch (error) {
        const retrievedAt = new Date(this.now()).toISOString();
        const status = error instanceof FinnhubHttpError && error.status === 429 ? "rate_limited" : "unavailable";
        const result: EndpointResult<T> = { status, value: null, retrievedAt };
        this.cache.set(cacheKey, { value: result, expiresAt: this.now() + this.failureTtlMs });
        return result;
      } finally { this.inflight.delete(cacheKey); }
    })();
    this.inflight.set(cacheKey, request as Promise<EndpointResult<unknown>>);
    return request;
  }

  async companyEnrichment(rawSymbol: string, newsLookbackDays = 7): Promise<FinnhubCompanyEnrichment> {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbolPattern.test(symbol)) throw new Error("A valid stock symbol is required for Finnhub enrichment");
    if (!Number.isInteger(newsLookbackDays) || newsLookbackDays < 1 || newsLookbackDays > 30) throw new Error("Finnhub news lookback must be 1 to 30 days");
    const asOf = new Date(this.now()).toISOString();
    const empty = (status: "missing_key" | "misconfigured", warning: string): FinnhubCompanyEnrichment => ({
      symbol, configured: false, status, profile: null, earnings: [], news: [], sources: [],
      coverage: { profile: status, earnings: status, news: status }, warnings: [warning], asOf,
    });
    const key = this.env.FINNHUB_API_KEY?.trim() ?? "";
    if (!key) return empty("missing_key", "Optional Finnhub enrichment is unavailable until FINNHUB_API_KEY is configured.");
    if (!keyPattern.test(key)) return empty("misconfigured", "Finnhub enrichment is unavailable because FINNHUB_API_KEY has an invalid format.");

    const to = asOf.slice(0, 10);
    const from = new Date(this.now() - newsLookbackDays * 86_400_000).toISOString().slice(0, 10);
    const profileUrl = `${API_URL}/stock/profile2?symbol=${encodeURIComponent(symbol)}`;
    const earningsUrl = `${API_URL}/stock/earnings?symbol=${encodeURIComponent(symbol)}&limit=4`;
    const newsUrl = `${API_URL}/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`;
    const [profileResult, earningsResult, newsResult] = await Promise.all([
      this.endpoint<unknown>(`profile:${symbol}`, profileUrl, key, this.profileTtlMs),
      this.endpoint<unknown>(`earnings:${symbol}`, earningsUrl, key, this.earningsTtlMs),
      this.endpoint<unknown>(`news:${symbol}:${from}:${to}`, newsUrl, key, this.newsTtlMs),
    ]);
    const coverage: FinnhubCompanyEnrichment["coverage"] = { profile: profileResult.status, earnings: earningsResult.status, news: newsResult.status };
    const warnings: string[] = [];
    const sources: FinnhubEvidence[] = [];
    let profile: FinnhubProfile | null = null;
    let earnings: FinnhubEarningsSurprise[] = [];
    let news: FinnhubNewsArticle[] = [];

    if (profileResult.status === "available") {
      profile = profileFrom(profileResult.value, symbol);
      if (profile) sources.push(canonicalEvidence({
        id: `finnhub:profile:${symbol}`, provider: "finnhub", sourceId: `profile2:${symbol}`, category: "identity", authority: "licensed_provider", claimStatus: "provider_record",
        title: `${profile.name} Finnhub company profile`, url: profileUrl, asOf: profileResult.retrievedAt, retrievedAt: profileResult.retrievedAt, entityIds: { symbol }, data: { symbol, ...profile },
      }));
      else { coverage.profile = "unavailable"; warnings.push("Finnhub returned no matching company profile; no identity fields were used."); }
    }

    if (earningsResult.status === "available") {
      try { earnings = earningsFrom(earningsResult.value); }
      catch { coverage.earnings = "unavailable"; warnings.push("Finnhub earnings enrichment returned an invalid payload and was omitted."); }
      if (earnings.length) {
        const latestPeriod = earnings[0]!.period;
        sources.push(canonicalEvidence({
          id: `finnhub:earnings:${symbol}`, provider: "finnhub", sourceId: `earnings:${symbol}:${latestPeriod}`, category: "fundamentals", authority: "licensed_provider", claimStatus: "provider_record",
          title: `${symbol} Finnhub earnings surprises`, url: earningsUrl, asOf: new Date(`${latestPeriod}T00:00:00.000Z`).toISOString(), retrievedAt: earningsResult.retrievedAt, entityIds: { symbol }, data: { symbol, limit: 4, earnings, note: "Provider-reported values; no surprise metrics were recalculated." },
        }));
      } else if (coverage.earnings === "available") warnings.push("Finnhub returned no usable earnings surprises for this symbol.");
    }

    if (newsResult.status === "available") {
      try { news = newsFrom(newsResult.value, symbol); }
      catch { coverage.news = "unavailable"; warnings.push("Finnhub company news returned an invalid payload and was omitted."); }
      for (const article of news) sources.push(canonicalEvidence({
        id: article.evidenceId, provider: "finnhub", sourceId: article.id, category: "news", authority: "licensed_provider", claimStatus: "media_signal",
        title: `Finnhub media signal: ${article.headline}`.slice(0, 500), url: article.url, asOf: article.publishedAt, retrievedAt: newsResult.retrievedAt, publishedAt: article.publishedAt, entityIds: { symbol },
        data: { symbol, headline: article.headline, summary: article.summary, source: article.source, category: article.category, relatedSymbols: article.relatedSymbols, classification: "media signal, not verified fact" },
      }));
      if (!news.length && coverage.news === "available") warnings.push("Finnhub returned no usable company-news items for this window; do not infer that no material event exists.");
    }

    const endpointStatuses = { profile: profileResult.status, earnings: earningsResult.status, news: newsResult.status };
    for (const [label, endpointStatus] of Object.entries(endpointStatuses)) {
      if (endpointStatus === "rate_limited") warnings.push(`Finnhub ${label} enrichment is rate limited and was omitted.`);
      else if (endpointStatus === "unavailable") warnings.push(`Finnhub ${label} enrichment is temporarily unavailable.`);
    }
    const statuses = Object.values(coverage);
    const availableCount = statuses.filter(status => status === "available").length;
    const status = availableCount === statuses.length ? "available" : availableCount ? "partial" : statuses.includes("rate_limited") ? "rate_limited" : "unavailable";
    const deduped = dedupeEvidence(sources);
    return { symbol, configured: true, status, profile, earnings, news, sources: deduped.records, coverage, warnings: unique(warnings), asOf: new Date(this.now()).toISOString() };
  }
}

let sharedFinnhubClient: FinnhubClient | null = null;
export function getFinnhubCompanyEnrichment(symbol: string) {
  sharedFinnhubClient ??= new FinnhubClient();
  return sharedFinnhubClient.companyEnrichment(symbol);
}
