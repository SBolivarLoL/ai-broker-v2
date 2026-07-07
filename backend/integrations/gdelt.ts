/**
 * GDELT media-signal adapter with canonical article evidence, bounded retries,
 * cache/coalescing, and explicit rate-limit/unavailable states.
 */
import { createHash } from "node:crypto";
import {
  canonicalEvidence,
  canonicalEvidenceUrl,
  dedupeEvidence,
  type CanonicalEvidence,
} from "../shared/evidence";
import {
  normalizeTimeProvenance,
  type NormalizedTimeProvenance,
} from "../shared/time-provenance";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type CacheEntry = { expiresAt: number; value: GdeltCompanySignals };

export type GdeltArticle = {
  id: string;
  evidenceId: string;
  headline: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  publishedAt: string;
  retrievedAt: string;
  serverRespondedAt: string;
  time: NormalizedTimeProvenance;
};

export type GdeltEvidence = CanonicalEvidence<unknown, "news">;
export type GdeltCompanySignals = {
  symbol: string;
  companyName: string;
  query: string;
  windowDays: number;
  available: boolean;
  rateLimited: boolean;
  filteredOut: number;
  articles: GdeltArticle[];
  sources: GdeltEvidence[];
  warnings: string[];
  retrievedAt: string;
  serverRespondedAt: string;
  time: NormalizedTimeProvenance;
  asOf: string;
};

export type GdeltClientOptions = {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cacheTtlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  minIntervalMs?: number;
};

class GdeltHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`GDELT returned HTTP ${status}`);
  }
}

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const symbolPattern = /^[A-Z.]{1,10}$/;
const htmlEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

const decodeText = (value: unknown) =>
  String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(
      /&(amp|apos|gt|lt|quot);/gi,
      (_match, name) => htmlEntities[String(name).toLowerCase()] ?? _match,
    )
    .replace(/[\t\r\n ]+/g, " ")
    .trim();

function companyQuery(value: string) {
  const name = decodeText(value)
    .replace(
      /\b(class [a-z0-9]+|common stock|ordinary shares?|american depositary shares?)\b.*$/i,
      "",
    )
    .replace(/["()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 2 || name.length > 160)
    throw new Error("GDELT company name must contain 2 to 160 characters");
  return `"${name}"`;
}

function publishedTime(value: unknown) {
  const text = String(value ?? "").trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const date = compact
    ? new Date(
        `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`,
      )
    : new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function articleUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function articleId(url: string) {
  return createHash("sha256")
    .update(canonicalEvidenceUrl(url))
    .digest("hex")
    .slice(0, 24);
}

function gdeltArticleTime(
  publishedAt: string,
  retrievedAt: string,
  serverRespondedAt: string,
) {
  return normalizeTimeProvenance({
    publicationTime: publishedAt,
    retrievalTime: retrievedAt,
    serverResponseTime: serverRespondedAt,
  });
}

function gdeltRootTime(retrievedAt: string, serverRespondedAt: string) {
  return normalizeTimeProvenance({
    retrievalTime: retrievedAt,
    serverResponseTime: serverRespondedAt,
  });
}

function withServerResponseTime(
  value: GdeltCompanySignals,
  serverRespondedAt: string,
): GdeltCompanySignals {
  return {
    ...value,
    asOf: serverRespondedAt,
    serverRespondedAt,
    time: gdeltRootTime(value.retrievedAt, serverRespondedAt),
    articles: value.articles.map((article) => ({
      ...article,
      serverRespondedAt,
      time: gdeltArticleTime(
        article.publishedAt,
        article.retrievedAt,
        serverRespondedAt,
      ),
    })),
  };
}

const genericCompanyWords = new Set([
  "class",
  "common",
  "company",
  "corp",
  "corporation",
  "fund",
  "group",
  "holdings",
  "inc",
  "incorporated",
  "ordinary",
  "shares",
  "stock",
  "trust",
]);
function headlineRelevant(headline: string, query: string, symbol: string) {
  const normalized = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const title = normalized(headline),
    phrase = normalized(query.slice(1, -1));
  const titleWords = new Set(title.split(" ").filter(Boolean));
  const terms = phrase
    .split(" ")
    .filter((term) => term.length >= 3 && !genericCompanyWords.has(term));
  const ticker = normalized(symbol);
  const tickerRelevant =
    ticker.replace(" ", "").length >= 4 &&
    (ticker.includes(" ") ? title.includes(ticker) : titleWords.has(ticker));
  return (
    (phrase.length >= 3 && title.includes(phrase)) ||
    terms.some((term) => titleWords.has(term)) ||
    tickerRelevant
  );
}

export class GdeltClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cacheTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<GdeltCompanySignals>>();
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: GdeltClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.cacheTtlMs = options.cacheTtlMs ?? 15 * 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 2 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.minIntervalMs = options.minIntervalMs ?? 5_000;
    if (
      this.cacheTtlMs <= 0 ||
      this.failureTtlMs <= 0 ||
      this.timeoutMs <= 0 ||
      this.minIntervalMs < 0 ||
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > 3
    )
      throw new Error("GDELT client options are invalid");
  }

  private scheduled<T>(run: () => Promise<T>) {
    const result = this.queue.then(async () => {
      const waitMs = Math.max(
        0,
        this.lastRequestAt + this.minIntervalMs - this.now(),
      );
      if (waitMs) await this.sleep(waitMs);
      this.lastRequestAt = this.now();
      return run();
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async fetchJson(url: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.scheduled(() =>
          this.fetchImpl(url, {
            headers: {
              accept: "application/json",
              "user-agent": "ai-broker-v2/1.0",
            },
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        );
        if (!response.ok) {
          const retryAfter = Number(response.headers.get("retry-after"));
          throw new GdeltHttpError(
            response.status,
            Number.isFinite(retryAfter) && retryAfter >= 0
              ? retryAfter * 1_000
              : null,
          );
        }
        return (await response.json()) as { articles?: unknown[] };
      } catch (error) {
        lastError = error;
        const transient =
          !(error instanceof GdeltHttpError) ||
          TRANSIENT_STATUS.has(error.status);
        if (!transient || attempt >= this.maxRetries) break;
        await this.sleep(
          error instanceof GdeltHttpError && error.retryAfterMs !== null
            ? Math.min(error.retryAfterMs, 10_000)
            : 5_000 * 2 ** attempt,
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("GDELT request failed");
  }

  private normalize(
    symbol: string,
    companyName: string,
    query: string,
    windowDays: number,
    payload: { articles?: unknown[] },
    retrievedAt: string,
    serverRespondedAt: string,
  ) {
    if (!Array.isArray(payload.articles))
      throw new Error("GDELT returned an invalid ArticleList payload");
    let filteredOut = 0;
    const normalized = payload.articles.slice(0, 25).flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const item = raw as Record<string, unknown>;
      const url = articleUrl(item.url),
        publishedAt = publishedTime(item.seendate),
        headline = decodeText(item.title).slice(0, 400);
      if (!url || !publishedAt || !headline) return [];
      if (!headlineRelevant(headline, query, symbol)) {
        filteredOut++;
        return [];
      }
      const hash = articleId(url),
        evidenceId = `gdelt:article:${hash}`;
      const article: GdeltArticle = {
        id: hash,
        evidenceId,
        headline,
        url,
        domain: decodeText(item.domain).slice(0, 160) || new URL(url).hostname,
        language: decodeText(item.language).slice(0, 80) || "Unknown",
        sourceCountry: decodeText(item.sourcecountry).slice(0, 80) || "Unknown",
        publishedAt,
        retrievedAt,
        serverRespondedAt,
        time: gdeltArticleTime(publishedAt, retrievedAt, serverRespondedAt),
      };
      const source = canonicalEvidence({
        id: evidenceId,
        provider: "gdelt",
        sourceId: canonicalEvidenceUrl(url),
        category: "news",
        authority: "public_web",
        claimStatus: "media_signal",
        title: `GDELT media signal: ${headline}`.slice(0, 500),
        url,
        asOf: publishedAt,
        retrievedAt,
        serverRespondedAt,
        publishedAt,
        entityIds: { symbol },
        data: {
          symbol,
          companyName,
          query,
          headline,
          domain: article.domain,
          language: article.language,
          sourceCountry: article.sourceCountry,
          seenDate: publishedAt,
          classification: "media signal, not verified fact",
        },
      });
      return [{ article, source }];
    });
    const deduped = dedupeEvidence(normalized.map((item) => item.source));
    const sourceIds = new Set(deduped.records.map((source) => source.id)),
      seen = new Set<string>();
    const articles = normalized
      .map((item) => item.article)
      .filter((article) => {
        if (!sourceIds.has(article.evidenceId) || seen.has(article.evidenceId))
          return false;
        seen.add(article.evidenceId);
        return true;
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, 10);
    return { articles, sources: deduped.records, filteredOut };
  }

  companySignals(
    rawSymbol: string,
    rawCompanyName: string,
    windowDays = 3,
    limit = 10,
  ): Promise<GdeltCompanySignals> {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbolPattern.test(symbol))
      throw new Error("A valid stock symbol is required for GDELT signals");
    if (
      !Number.isInteger(windowDays) ||
      windowDays < 1 ||
      windowDays > 7 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 25
    )
      throw new Error("GDELT window must be 1 to 7 days and limit 1 to 25");
    const companyName = decodeText(rawCompanyName);
    const query = companyQuery(companyName);
    const key = JSON.stringify({ symbol, query, windowDays, limit });
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now())
      return Promise.resolve(
        withServerResponseTime(
          cached.value,
          new Date(this.now()).toISOString(),
        ),
      );
    const active = this.inflight.get(key);
    if (active) return active;
    const request = (async () => {
      const retrievedAt = new Date(this.now()).toISOString();
      const params = new URLSearchParams({
        query,
        mode: "artlist",
        maxrecords: String(limit),
        timespan: `${windowDays}d`,
        sort: "datedesc",
        format: "json",
      });
      try {
        const payload = await this.fetchJson(`${API_URL}?${params}`);
        const serverRespondedAt = new Date(this.now()).toISOString();
        const normalized = this.normalize(
          symbol,
          companyName,
          query,
          windowDays,
          payload,
          retrievedAt,
          serverRespondedAt,
        );
        const value: GdeltCompanySignals = {
          symbol,
          companyName,
          query,
          windowDays,
          available: true,
          rateLimited: false,
          ...normalized,
          warnings: normalized.filteredOut
            ? [
                `${normalized.filteredOut} GDELT broad match${normalized.filteredOut === 1 ? " was" : "es were"} omitted because headline-level company relevance could not be established.`,
              ]
            : [],
          retrievedAt,
          serverRespondedAt,
          time: gdeltRootTime(retrievedAt, serverRespondedAt),
          asOf: serverRespondedAt,
        };
        this.cache.set(key, { value, expiresAt: this.now() + this.cacheTtlMs });
        return value;
      } catch (error) {
        const serverRespondedAt = new Date(this.now()).toISOString();
        const rateLimited =
          error instanceof GdeltHttpError && error.status === 429;
        const value: GdeltCompanySignals = {
          symbol,
          companyName,
          query,
          windowDays,
          available: false,
          rateLimited,
          filteredOut: 0,
          articles: [],
          sources: [],
          retrievedAt,
          serverRespondedAt,
          time: gdeltRootTime(retrievedAt, serverRespondedAt),
          asOf: serverRespondedAt,
          warnings: [
            rateLimited
              ? "GDELT broad media signals are rate limited; Alpaca/Benzinga coverage remains available and no absence of events should be inferred."
              : "GDELT broad media signals are temporarily unavailable; Alpaca/Benzinga coverage remains available and no absence of events should be inferred.",
          ],
        };
        this.cache.set(key, {
          value,
          expiresAt: this.now() + this.failureTtlMs,
        });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, request);
    return request;
  }
}

let sharedClient: GdeltClient | null = null;
export function getGdeltCompanySignals(symbol: string, companyName: string) {
  sharedClient ??= new GdeltClient();
  return sharedClient.companySignals(symbol, companyName);
}
