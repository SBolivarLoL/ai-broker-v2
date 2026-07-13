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

export type ConflictNextAction =
  | "collect_shadow_evidence"
  | "create_matching_backtest"
  | "refresh_orders"
  | "refresh_preview"
  | "refresh_strategy_run"
  | "register_experiment_protocol"
  | "select_shadow_or_paused_run"
  | "wait_for_submission";

export type ConflictDetails = {
  code: string;
  retryable: boolean;
  nextAction: ConflictNextAction;
};

export class ClientError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: ConflictDetails,
  ) {
    super(message);
  }
}

/** Builds a stable, machine-readable HTTP 409 without weakening the guardrail. */
export function conflict(
  message: string,
  code: string,
  retryable: boolean,
  nextAction: ConflictNextAction,
) {
  return new ClientError(message, 409, { code, retryable, nextAction });
}

/** Returns the same conflict contract for routes that do not throw. */
export function conflictResponse(
  message: string,
  code: string,
  retryable: boolean,
  nextAction: ConflictNextAction,
  context: Record<string, unknown> = {},
) {
  return json(
    { ...context, error: message, code, retryable, nextAction },
    409,
  );
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
