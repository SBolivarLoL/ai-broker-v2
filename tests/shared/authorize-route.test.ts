import { expect, test } from "bun:test";
import { authorizeRoute } from "../../backend/http/authorize-route";
import type { AuthContext, AuthRole } from "../../backend/shared/security";

const auth = (...roles: AuthRole[]): AuthContext => ({
  actor: "test",
  email: "test@example.com",
  roles,
});

test("route authorization keeps operations, trading, and research roles separate", () => {
  expect(authorizeRoute(auth("viewer"), "/api/account", "GET")).toBe(true);
  expect(
    authorizeRoute(auth("operator"), "/api/operations/readiness", "GET"),
  ).toBe(true);
  expect(() =>
    authorizeRoute(auth("operator"), "/api/operations/policy", "POST"),
  ).toThrow("Forbidden");
  expect(authorizeRoute(auth("admin"), "/api/operations/policy", "POST")).toBe(
    true,
  );
  expect(authorizeRoute(auth("trader"), "/api/orders", "POST")).toBe(true);
  expect(() => authorizeRoute(auth("viewer"), "/api/orders", "POST")).toThrow(
    "Forbidden",
  );
  expect(authorizeRoute(auth("researcher"), "/api/research/runs", "POST")).toBe(
    true,
  );
});
