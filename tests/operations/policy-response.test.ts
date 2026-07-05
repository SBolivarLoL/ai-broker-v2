import { expect, test } from "bun:test";
import { blockedOperationsPolicyResponse } from "../../backend/features/operations/policy-response";

test("blocked operations responses keep policy evidence and route-specific context", async () => {
  const operationalPolicy = {
    allowed: false,
    reasons: ["Global kill switch is active"],
    runbook: ["Review the global kill switch"],
  } as any;

  const response = blockedOperationsPolicyResponse(operationalPolicy, {
    referenceDebit: 125,
  });

  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    allowed: false,
    operationalPolicy,
    reasons: operationalPolicy.reasons,
    runbook: operationalPolicy.runbook,
    referenceDebit: 125,
  });
});
