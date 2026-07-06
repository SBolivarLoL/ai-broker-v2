/** Shared HTTP response, validation, and client-error primitives. */
export const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { ...securityHeaders, "cache-control": "no-store" },
  });
}

export class ClientError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const MAX_JSON_BYTES = 16_384;

export async function requestJson(request: Request) {
  // Check both the declared and actual encoded size: content-length can be
  // absent or untrusted at the public HTTP boundary.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new ClientError("Request body is too large", 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new ClientError("Request body is too large", 413);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ClientError("Request body must be valid JSON", 400);
  }
}
