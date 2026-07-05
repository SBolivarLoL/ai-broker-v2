import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

/** Hashes a canonical object representation so audit verification is deterministic. */
export function hashAuditEntry(entry: Record<string, unknown>) {
  return `sha256:${createHash("sha256").update(canonicalJson(entry)).digest("hex")}`;
}

export function hashBytes(bytes: Buffer | Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
