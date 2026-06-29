import { createHash } from "node:crypto";

export type EvidenceCategory = "market" | "fundamentals" | "filings" | "news" | "macro" | "events" | "identity" | "valuation";
export type EvidenceAuthority = "official" | "regulated_broker" | "licensed_provider" | "public_web" | "derived";
export type EvidenceClaimStatus = "official_record" | "provider_record" | "broker_observation" | "media_signal" | "derived_analysis";
export type EvidenceEntityIds = { symbol?: string; cik?: string; figi?: string };

export type CanonicalEvidence<T = unknown, C extends EvidenceCategory = EvidenceCategory> = {
  id: string;
  provider: string;
  sourceId: string;
  category: C;
  authority: EvidenceAuthority;
  claimStatus: EvidenceClaimStatus;
  title: string;
  url: string;
  canonicalUrl: string;
  asOf: string;
  retrievedAt: string;
  publishedAt: string | null;
  entityIds: EvidenceEntityIds;
  contentHash: string;
  data: T;
};

export type CanonicalEvidenceInput<T, C extends EvidenceCategory> = Omit<CanonicalEvidence<T, C>, "canonicalUrl" | "contentHash" | "publishedAt"> & {
  publishedAt?: string | null;
};

const authorityRank: Record<EvidenceAuthority, number> = {
  derived: 0,
  public_web: 1,
  licensed_provider: 2,
  regulated_broker: 3,
  official: 4,
};

function requiredText(value: string, label: string, maximum = 500) {
  const text = value.trim();
  if (!text || text.length > maximum) throw new Error(`${label} must be between 1 and ${maximum} characters`);
  return text;
}

function isoTime(value: string, label: string) {
  const time = new Date(value);
  if (!value || !Number.isFinite(time.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return time.toISOString();
}

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Evidence data cannot contain non-finite numbers");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : jsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, jsonValue(item)]));
  }
  throw new Error("Evidence data must be JSON-compatible");
}

export function stableEvidenceJson(value: unknown) {
  return JSON.stringify(jsonValue(value));
}

export function evidenceContentHash(value: unknown) {
  return `sha256:${createHash("sha256").update(stableEvidenceJson(value)).digest("hex")}`;
}

export function canonicalEvidenceUrl(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Evidence URL must be absolute"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Evidence URL must use HTTP or HTTPS");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function normalizedEntityIds(value: EvidenceEntityIds) {
  const symbol = value.symbol?.trim().toUpperCase();
  const cik = value.cik?.trim();
  const figi = value.figi?.trim().toUpperCase();
  if (symbol && !/^[A-Z0-9./-]{1,20}$/.test(symbol)) throw new Error("Evidence symbol identifier is invalid");
  if (cik && !/^\d{1,10}$/.test(cik)) throw new Error("Evidence CIK identifier is invalid");
  if (figi && !/^[A-Z0-9]{12}$/.test(figi)) throw new Error("Evidence FIGI identifier is invalid");
  return { ...(symbol ? { symbol } : {}), ...(cik ? { cik: cik.padStart(10, "0") } : {}), ...(figi ? { figi } : {}) };
}

export function canonicalEvidence<T, C extends EvidenceCategory>(input: CanonicalEvidenceInput<T, C>): CanonicalEvidence<T, C> {
  const data = jsonValue(input.data) as T;
  return {
    id: requiredText(input.id, "Evidence ID", 240),
    provider: requiredText(input.provider, "Evidence provider", 80).toLowerCase(),
    sourceId: requiredText(input.sourceId, "Evidence source ID", 240),
    category: input.category,
    authority: input.authority,
    claimStatus: input.claimStatus,
    title: requiredText(input.title, "Evidence title"),
    url: requiredText(input.url, "Evidence URL", 2_000),
    canonicalUrl: canonicalEvidenceUrl(input.url),
    asOf: isoTime(input.asOf, "Evidence as-of time"),
    retrievedAt: isoTime(input.retrievedAt, "Evidence retrieval time"),
    publishedAt: input.publishedAt ? isoTime(input.publishedAt, "Evidence publication time") : null,
    entityIds: normalizedEntityIds(input.entityIds),
    contentHash: evidenceContentHash(data),
    data,
  };
}

export type EvidenceDuplicateReason = "provider_source_id" | "canonical_url" | "exact_content";
export type EvidenceDuplicate = { keptId: string; discardedId: string; reason: EvidenceDuplicateReason };
export type EvidenceRevision = { keptId: string; discardedId: string; provider: string; sourceId: string; keptHash: string; discardedHash: string };

function preferred<T extends CanonicalEvidence>(a: T, b: T) {
  const authority = authorityRank[a.authority] - authorityRank[b.authority];
  if (authority !== 0) return authority > 0 ? a : b;
  const retrieval = a.retrievedAt.localeCompare(b.retrievedAt);
  if (retrieval !== 0) return retrieval > 0 ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

function identityKey(record: CanonicalEvidence) {
  const ids = Object.entries(record.entityIds).sort(([a], [b]) => a.localeCompare(b));
  return ids.length ? ids.map(([key, value]) => `${key}:${value}`).join("|") : null;
}

export function dedupeEvidence<T extends CanonicalEvidence>(records: T[]) {
  const kept: T[] = [];
  const duplicates: EvidenceDuplicate[] = [];
  const revisions: EvidenceRevision[] = [];
  for (const record of records) {
    const sourceMatch = kept.find(item => item.provider === record.provider && item.sourceId === record.sourceId);
    const urlMatch = sourceMatch ? undefined : kept.find(item => item.canonicalUrl === record.canonicalUrl && item.contentHash === record.contentHash);
    const identity = identityKey(record);
    const contentMatch = sourceMatch || urlMatch || !identity ? undefined : kept.find(item => identityKey(item) === identity && item.category === record.category && item.contentHash === record.contentHash);
    const match = sourceMatch ?? urlMatch ?? contentMatch;
    if (!match) { kept.push(record); continue; }
    const winner = preferred(match, record);
    const loser = winner === match ? record : match;
    if (winner !== match) kept[kept.indexOf(match)] = winner;
    const reason: EvidenceDuplicateReason = sourceMatch ? "provider_source_id" : urlMatch ? "canonical_url" : "exact_content";
    duplicates.push({ keptId: winner.id, discardedId: loser.id, reason });
    if (match.contentHash !== record.contentHash) revisions.push({
      keptId: winner.id,
      discardedId: loser.id,
      provider: record.provider,
      sourceId: record.sourceId,
      keptHash: winner.contentHash,
      discardedHash: loser.contentHash,
    });
  }
  return { records: kept, duplicates, revisions };
}
