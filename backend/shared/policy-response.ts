import { json } from "../http/http";
import type { OperationsPolicyEvaluation } from "./operations-policy";

/** Returns the common evidence payload for an order blocked by operations policy. */
export function blockedOperationsPolicyResponse(
  operationalPolicy: OperationsPolicyEvaluation,
  extra: Record<string, unknown> = {},
) {
  return json(
    {
      allowed: false,
      operationalPolicy,
      reasons: operationalPolicy.reasons,
      runbook: operationalPolicy.runbook,
      ...extra,
    },
    422,
  );
}
