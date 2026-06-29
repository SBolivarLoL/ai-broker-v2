import { createHash } from "node:crypto";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type SecCompany = {
  cik: string;
  cikNumber: string;
  ticker: string;
  title: string;
};

export type SecCompanyClassification = {
  symbol: string;
  companyName: string;
  cik: string;
  sic: string | null;
  industry: string | null;
  sourceUrl: string;
  retrievedAt: string;
};

export type SecFiling = {
  form: string;
  filed: string;
  reportDate: string;
  accession: string;
  primaryDocument: string;
  url: string;
  indexUrl: string;
};

export type SecFilingSectionKind = "risk_factors" | "management_discussion";

export type SecFilingSection = {
  id: string;
  kind: SecFilingSectionKind;
  title: string;
  locator: string;
  form: string;
  filed: string;
  reportDate: string;
  accession: string;
  sourceUrl: string;
  text: string;
  sourceCharacterCount: number;
  includedCharacterCount: number;
  truncated: boolean;
  contentHash: string;
  retrievedAt: string;
};

export type SecFilingEvidence = {
  symbol: string;
  companyName: string;
  cik: string;
  filings: SecFiling[];
  sections: SecFilingSection[];
  limitations: string[];
};

export type Sec8KImportance = "critical" | "high" | "standard" | "supporting";

export type Sec8KItemEvidence = {
  code: string;
  label: string;
  importance: Sec8KImportance;
  text: string;
  sourceCharacterCount: number;
  includedCharacterCount: number;
  truncated: boolean;
  contentHash: string;
};

export type Sec8KAlertEvidence = {
  id: string;
  symbol: string;
  companyName: string;
  form: string;
  filed: string;
  reportDate: string;
  accession: string;
  sourceUrl: string;
  indexUrl: string;
  importance: Exclude<Sec8KImportance, "supporting">;
  primaryItem: { code: string; label: string };
  relevanceSummary: string;
  items: Sec8KItemEvidence[];
  retrievedAt: string;
};

export type Sec8KAlertResult = {
  symbol: string;
  companyName: string;
  cik: string;
  lookbackDays: number;
  alerts: Sec8KAlertEvidence[];
  limitations: string[];
};

type SecSubmissions = {
  name: string;
  sic?: string | number;
  sicDescription?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
    };
  };
};

export type SecFacts = {
  entityName: string;
  facts: Record<string, Record<string, {
    label: string;
    units: Record<string, Array<{ val: number; start?: string; end: string; filed: string; form: string; fy?: number; fp?: string; frame?: string; accn: string }>>;
  }>>;
};

type CacheEntry = {
  value: unknown;
  expiresAt: number;
  etag: string | null;
  lastModified: string | null;
};

export type SecEdgarClientOptions = {
  userAgent: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
  maxRetries?: number;
  jsonCacheTtlMs?: number;
  filingCacheTtlMs?: number;
};

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_JSON_TTL = 5 * 60_000;
const DEFAULT_FILING_TTL = 6 * 60 * 60_000;
const DEFAULT_SECTION_CHARS = 12_000;
const DEFAULT_8K_ITEM_CHARS = 1_600;

type Sec8KItemDefinition = { code: string; label: string; importance: Sec8KImportance };
const SEC_8K_ITEMS: Sec8KItemDefinition[] = [
  { code: "1.01", label: "Entry into a Material Definitive Agreement", importance: "high" },
  { code: "1.02", label: "Termination of a Material Definitive Agreement", importance: "high" },
  { code: "1.03", label: "Bankruptcy or Receivership", importance: "critical" },
  { code: "1.05", label: "Material Cybersecurity Incidents", importance: "critical" },
  { code: "2.01", label: "Completion of Acquisition or Disposition of Assets", importance: "high" },
  { code: "2.02", label: "Results of Operations and Financial Condition", importance: "standard" },
  { code: "2.03", label: "Creation of a Direct Financial Obligation", importance: "high" },
  { code: "2.04", label: "Triggering Events That Accelerate or Increase a Direct Financial Obligation", importance: "high" },
  { code: "2.05", label: "Costs Associated with Exit or Disposal Activities", importance: "high" },
  { code: "2.06", label: "Material Impairments", importance: "high" },
  { code: "3.01", label: "Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard", importance: "critical" },
  { code: "3.02", label: "Unregistered Sales of Equity Securities", importance: "high" },
  { code: "3.03", label: "Material Modification to Rights of Security Holders", importance: "high" },
  { code: "4.01", label: "Changes in Registrant's Certifying Accountant", importance: "high" },
  { code: "4.02", label: "Non-Reliance on Previously Issued Financial Statements", importance: "critical" },
  { code: "5.01", label: "Changes in Control of Registrant", importance: "critical" },
  { code: "5.02", label: "Departure of Directors or Certain Officers; Election or Appointment of Certain Officers", importance: "high" },
  { code: "5.03", label: "Amendments to Articles of Incorporation or Bylaws", importance: "high" },
  { code: "5.04", label: "Temporary Suspension of Trading Under Employee Benefit Plans", importance: "high" },
  { code: "5.05", label: "Amendments to or Waiver of the Code of Ethics", importance: "high" },
  { code: "5.06", label: "Change in Shell Company Status", importance: "high" },
  { code: "5.07", label: "Submission of Matters to a Vote of Security Holders", importance: "standard" },
  { code: "5.08", label: "Shareholder Director Nominations", importance: "standard" },
  { code: "7.01", label: "Regulation FD Disclosure", importance: "standard" },
  { code: "8.01", label: "Other Events", importance: "standard" },
  { code: "9.01", label: "Financial Statements and Exhibits", importance: "supporting" },
];

export function validateSecUserAgent(value: string) {
  const userAgent = value.trim();
  const email = userAgent.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase();
  if (userAgent.length < 12 || !email || email.endsWith("@example.com")) {
    throw new Error("SEC_USER_AGENT must identify the application and a real contact email address");
  }
  return userAgent;
}

export function secUserAgentFromEnv(env: Record<string, string | undefined> = process.env) {
  return validateSecUserAgent(env.SEC_USER_AGENT ?? "");
}

function hashText(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"" };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&(amp|apos|gt|lt|nbsp|quot);/gi, (_match, name) => named[String(name).toLowerCase()]!);
}

function normalizeText(value: string) {
  return decodeHtmlEntities(value).replace(/\u00a0/g, " ").replace(/[\t\r\n ]+/g, " ").trim();
}

export async function secDocumentText(html: string) {
  let text = "";
  const transformed = new HTMLRewriter()
    .on("script, style, noscript", { element(element) { element.remove(); } })
    .on("body", { text(chunk) { text += `${chunk.text}${chunk.lastInTextNode ? " " : ""}`; } })
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  await transformed.text();
  return normalizeText(text);
}

type SectionRule = {
  kind: SecFilingSectionKind;
  title: string;
  locator: string;
  start: RegExp;
  boundaries: RegExp[];
};

function sectionRules(form: string): SectionRule[] {
  if (form === "10-Q") return [
    {
      kind: "management_discussion",
      title: "Management's Discussion and Analysis",
      locator: "Part I, Item 2",
      start: /(?:part\s+i\s+)?item\s+2[.\s:\-]+management(?:'s|\u2019s)?\s+discussion(?:\s+and\s+analysis)?/gi,
      boundaries: [/(?:part\s+i\s+)?item\s+3[.\s:\-]+quantitative/gi, /(?:part\s+i\s+)?item\s+4[.\s:\-]+controls/gi],
    },
    {
      kind: "risk_factors",
      title: "Risk Factors",
      locator: "Part II, Item 1A",
      start: /(?:part\s+ii\s+)?item\s+1a[.\s:\-]+risk\s+factors?/gi,
      boundaries: [/(?:part\s+ii\s+)?item\s+2[.\s:\-]+unregistered/gi, /(?:part\s+ii\s+)?item\s+3[.\s:\-]+defaults/gi],
    },
  ];
  return [
    {
      kind: "risk_factors",
      title: "Risk Factors",
      locator: "Item 1A",
      start: /item\s+1a[.\s:\-]+risk\s+factors?/gi,
      boundaries: [/item\s+1b[.\s:\-]+unresolved/gi, /item\s+1c[.\s:\-]+cybersecurity/gi, /item\s+2[.\s:\-]+properties/gi],
    },
    {
      kind: "management_discussion",
      title: "Management's Discussion and Analysis",
      locator: "Item 7",
      start: /item\s+7[.\s:\-]+management(?:'s|\u2019s)?\s+discussion(?:\s+and\s+analysis)?/gi,
      boundaries: [/item\s+7a[.\s:\-]+quantitative/gi, /item\s+8[.\s:\-]+financial\s+statements/gi],
    },
  ];
}

function firstBoundary(text: string, startAt: number, patterns: RegExp[]) {
  let boundary = text.length;
  const remainder = text.slice(startAt);
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(remainder);
    if (match) boundary = Math.min(boundary, startAt + match.index);
  }
  return boundary;
}

function longestSection(text: string, rule: SectionRule) {
  const candidates: string[] = [];
  rule.start.lastIndex = 0;
  for (let match = rule.start.exec(text); match; match = rule.start.exec(text)) {
    const start = match.index;
    const end = firstBoundary(text, start + match[0].length, rule.boundaries);
    const candidate = normalizeText(text.slice(start, end));
    if (candidate.length >= 250) candidates.push(candidate);
  }
  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

function boundedText(value: string, maximum: number) {
  if (value.length <= maximum) return { text: value, truncated: false };
  const cut = value.slice(0, maximum);
  const boundary = cut.lastIndexOf(" ");
  return { text: `${cut.slice(0, boundary > maximum * .8 ? boundary : maximum).trim()}...`, truncated: true };
}

export async function extractSecFilingSections(html: string, form: string, maximumCharacters = DEFAULT_SECTION_CHARS) {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 1_000 || maximumCharacters > 50_000) throw new Error("SEC section character limit must be between 1000 and 50000");
  const text = await secDocumentText(html);
  return sectionRules(form).flatMap(rule => {
    const section = longestSection(text, rule);
    if (!section) return [];
    const bounded = boundedText(section, maximumCharacters);
    return [{ kind: rule.kind, title: rule.title, locator: rule.locator, text: bounded.text, sourceCharacterCount: section.length, includedCharacterCount: bounded.text.length, truncated: bounded.truncated, contentHash: hashText(bounded.text) }];
  });
}

function regexpEscape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sec8KHeadingPattern(item: Sec8KItemDefinition) {
  const prefix = item.label.split(/\s+/).slice(0, 2).map(regexpEscape).join("\\s+");
  return new RegExp(`\\bitem\\s+${regexpEscape(item.code)}(?:\\s|[.:\\-\\u2013\\u2014])+${prefix}`, "gi");
}

function stripSec8KHeadingRemainder(value: string, item: Sec8KItemDefinition) {
  const remainder = item.label.split(/\s+/).slice(2).map(regexpEscape).join("\\s+");
  const withoutTitle = remainder ? value.replace(new RegExp(`^${remainder}(?:\\s|[.:;\\-\\u2013\\u2014])+`, "i"), "") : value;
  return normalizeText(withoutTitle.replace(/^[\s.:;\-\u2013\u2014]+/, ""));
}

export async function extractSec8KItems(html: string, maximumCharacters = DEFAULT_8K_ITEM_CHARS): Promise<Sec8KItemEvidence[]> {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 400 || maximumCharacters > 5_000) throw new Error("SEC 8-K item character limit must be between 400 and 5000");
  const text = await secDocumentText(html);
  const patterns = SEC_8K_ITEMS.map(item => ({ item, pattern: sec8KHeadingPattern(item) }));
  return patterns.flatMap(({ item, pattern }) => {
    const candidates: string[] = [];
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const contentStart = match.index + match[0].length;
      const end = firstBoundary(text, contentStart, patterns.filter(entry => entry.item.code !== item.code).map(entry => entry.pattern));
      const candidate = stripSec8KHeadingRemainder(normalizeText(text.slice(contentStart, end)), item);
      if (candidate.length >= 40) candidates.push(candidate);
    }
    const source = candidates.sort((a, b) => b.length - a.length)[0];
    if (!source) return [];
    const bounded = boundedText(source, maximumCharacters);
    return [{
      code: item.code,
      label: item.label,
      importance: item.importance,
      text: bounded.text,
      sourceCharacterCount: source.length,
      includedCharacterCount: bounded.text.length,
      truncated: bounded.truncated,
      contentHash: hashText(bounded.text),
    }];
  });
}

const importanceRank: Record<Sec8KImportance, number> = { supporting: 0, standard: 1, high: 2, critical: 3 };

function sec8KSummary(item: Sec8KItemEvidence) {
  const sentence = item.text.match(/^.{1,520}?[.!?](?=\s|$)/)?.[0];
  const bounded = boundedText((sentence ?? item.text).trim(), 520);
  return `${item.label}: ${bounded.text}`;
}

export class SecEdgarClient {
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly jsonCacheTtlMs: number;
  private readonly filingCacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(options: SecEdgarClientOptions) {
    this.userAgent = validateSecUserAgent(options.userAgent);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 125;
    this.maxRetries = options.maxRetries ?? 2;
    this.jsonCacheTtlMs = options.jsonCacheTtlMs ?? DEFAULT_JSON_TTL;
    this.filingCacheTtlMs = options.filingCacheTtlMs ?? DEFAULT_FILING_TTL;
    if (!Number.isFinite(this.minIntervalMs) || this.minIntervalMs < 100) throw new Error("SEC request interval must be at least 100ms");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 5) throw new Error("SEC retry count must be between 0 and 5");
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async waitForSlot() {
    const delay = Math.max(0, this.nextRequestAt - this.now());
    if (delay) await this.sleep(delay);
    this.nextRequestAt = Math.max(this.nextRequestAt, this.now()) + this.minIntervalMs;
  }

  private retryDelay(response: Response, attempt: number) {
    const seconds = Number(response.headers.get("retry-after"));
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(5_000, seconds * 1_000);
    return 250 * 2 ** attempt;
  }

  private request<T>(url: string, kind: "json" | "text", ttlMs: number): Promise<T> {
    const key = `${kind}:${url}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value as T);
    return this.enqueue(async () => {
      const recheck = this.cache.get(key);
      if (recheck && recheck.expiresAt > this.now()) return recheck.value as T;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        await this.waitForSlot();
        const previous = this.cache.get(key);
        const response = await this.fetchImpl(url, {
          headers: {
            "user-agent": this.userAgent,
            accept: kind === "json" ? "application/json" : "text/html, text/plain;q=0.9",
            "accept-encoding": "gzip, deflate",
            ...(previous?.etag ? { "if-none-match": previous.etag } : {}),
            ...(previous?.lastModified ? { "if-modified-since": previous.lastModified } : {}),
          },
        });
        if (response.status === 304 && previous) {
          previous.expiresAt = this.now() + ttlMs;
          return previous.value as T;
        }
        if (response.ok) {
          const value = kind === "json" ? await response.json() : await response.text();
          this.cache.set(key, { value, expiresAt: this.now() + ttlMs, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") });
          return value as T;
        }
        if (!TRANSIENT_STATUS.has(response.status) || attempt === this.maxRetries) throw new Error(`SEC data request failed (${response.status})`);
        await this.sleep(this.retryDelay(response, attempt));
      }
      throw new Error("SEC data request failed");
    });
  }

  async company(symbol: string): Promise<SecCompany> {
    const requested = symbol.trim().toUpperCase();
    if (!/^[A-Z.]{1,10}$/.test(requested)) throw new Error("Invalid SEC ticker symbol");
    const companies = await this.request<Record<string, { cik_str: number; ticker: string; title: string }>>("https://www.sec.gov/files/company_tickers.json", "json", 24 * 60 * 60_000);
    const company = Object.values(companies).find(item => item.ticker.toUpperCase() === requested);
    if (!company) throw new Error("SEC company identifier not found");
    return { ...company, cik: String(company.cik_str).padStart(10, "0"), cikNumber: String(company.cik_str) };
  }

  async submissions(company: SecCompany) {
    return this.request<SecSubmissions>(`https://data.sec.gov/submissions/CIK${company.cik}.json`, "json", this.jsonCacheTtlMs);
  }

  async companyFacts(company: SecCompany) {
    return this.request<SecFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`, "json", this.jsonCacheTtlMs);
  }

  async companyClassification(symbol: string): Promise<SecCompanyClassification> {
    const company = await this.company(symbol);
    const submission = await this.submissions(company);
    const rawSic = String(submission.sic ?? "").trim();
    const sic = /^\d{1,4}$/.test(rawSic) ? rawSic.padStart(4, "0") : null;
    const industry = sic ? String(submission.sicDescription ?? "").replace(/[\t\r\n ]+/g, " ").trim().slice(0, 200) || null : null;
    return { symbol: company.ticker, companyName: submission.name, cik: company.cik, sic, industry, sourceUrl: `https://data.sec.gov/submissions/CIK${company.cik}.json`, retrievedAt: new Date(this.now()).toISOString() };
  }

  async recentFilings(symbol: string, limit = 12) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error("SEC filing limit must be between 1 and 40");
    const company = await this.company(symbol);
    const submission = await this.submissions(company);
    const recent = submission.filings.recent;
    const filings = recent.form
      .map((form, index) => ({ form, index }))
      .filter(item => ["10-K", "10-Q", "8-K", "8-K/A"].includes(item.form))
      .slice(0, limit)
      .map(({ form, index }): SecFiling => {
        const accession = recent.accessionNumber[index]!;
        const primaryDocument = recent.primaryDocument[index]!;
        const accessionPlain = accession.replaceAll("-", "");
        const base = `https://www.sec.gov/Archives/edgar/data/${company.cikNumber}/${accessionPlain}`;
        return {
          form,
          filed: recent.filingDate[index]!,
          reportDate: recent.reportDate[index]!,
          accession,
          primaryDocument,
          url: `${base}/${primaryDocument}`,
          indexUrl: `${base}/${accession}-index.html`,
        };
      });
    return { company, companyName: submission.name, submissionsUrl: `https://data.sec.gov/submissions/CIK${company.cik}.json`, filings };
  }

  async filingEvidence(symbol: string, limit = 12, maximumSectionCharacters = DEFAULT_SECTION_CHARS): Promise<SecFilingEvidence> {
    const recent = await this.recentFilings(symbol, limit);
    const selected: SecFiling[] = [];
    for (const form of ["10-K", "10-Q"]) {
      const filing = recent.filings.find(item => item.form === form);
      if (filing) selected.push(filing);
    }
    const sections: SecFilingSection[] = [];
    const limitations: string[] = [];
    for (const filing of selected) {
      try {
        const html = await this.request<string>(filing.url, "text", this.filingCacheTtlMs);
        const extracted = await extractSecFilingSections(html, filing.form, maximumSectionCharacters);
        if (!extracted.length) limitations.push(`${filing.form} ${filing.accession}: supported sections were not found in the primary document.`);
        for (const section of extracted) sections.push({
          ...section,
          id: `sec:section:${symbol.toUpperCase()}:${filing.accession}:${section.kind}`,
          form: filing.form,
          filed: filing.filed,
          reportDate: filing.reportDate,
          accession: filing.accession,
          sourceUrl: filing.url,
          retrievedAt: new Date(this.now()).toISOString(),
        });
      } catch (error) {
        limitations.push(`${filing.form} ${filing.accession}: ${error instanceof Error ? error.message : "section retrieval failed"}`);
      }
    }
    if (!selected.some(filing => filing.form === "10-K")) limitations.push("No recent 10-K primary document was available in the bounded submissions window.");
    if (!selected.some(filing => filing.form === "10-Q")) limitations.push("No recent 10-Q primary document was available in the bounded submissions window.");
    return { symbol: symbol.toUpperCase(), companyName: recent.companyName, cik: recent.company.cik, filings: recent.filings, sections, limitations };
  }

  async recent8KAlerts(symbol: string, lookbackDays = 14, limit = 3, maximumItemCharacters = DEFAULT_8K_ITEM_CHARS): Promise<Sec8KAlertResult> {
    if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) throw new Error("SEC 8-K lookback must be between 1 and 365 days");
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("SEC 8-K alert limit must be between 1 and 10");
    const requested = symbol.trim().toUpperCase();
    const recent = await this.recentFilings(requested, 40);
    const cutoff = new Date(this.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const filings = recent.filings.filter(filing => filing.form.startsWith("8-K") && filing.filed >= cutoff).slice(0, limit);
    const alerts: Sec8KAlertEvidence[] = [];
    const limitations: string[] = [];
    for (const filing of filings) {
      try {
        const html = await this.request<string>(filing.url, "text", this.filingCacheTtlMs);
        const items = await extractSec8KItems(html, maximumItemCharacters);
        const primary = items
          .filter((item): item is Sec8KItemEvidence & { importance: Exclude<Sec8KImportance, "supporting"> } => item.importance !== "supporting")
          .sort((a, b) => importanceRank[b.importance] - importanceRank[a.importance])[0];
        if (!primary) {
          limitations.push(`${filing.accession}: no supported material 8-K item section was found in the primary document.`);
          continue;
        }
        alerts.push({
          id: `sec:8k:${requested}:${filing.accession}`,
          symbol: requested,
          companyName: recent.companyName,
          form: filing.form,
          filed: filing.filed,
          reportDate: filing.reportDate,
          accession: filing.accession,
          sourceUrl: filing.url,
          indexUrl: filing.indexUrl,
          importance: primary.importance,
          primaryItem: { code: primary.code, label: primary.label },
          relevanceSummary: sec8KSummary(primary),
          items,
          retrievedAt: new Date(this.now()).toISOString(),
        });
      } catch (error) {
        limitations.push(`${filing.accession}: ${error instanceof Error ? error.message : "8-K retrieval failed"}`);
      }
    }
    return { symbol: requested, companyName: recent.companyName, cik: recent.company.cik, lookbackDays, alerts, limitations };
  }
}
