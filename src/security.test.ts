import { expect, test } from "bun:test";
import { actorFor, rateLimiter, securityReady, validMutationOrigin } from "./security";

const production = { NODE_ENV: "production", APP_ORIGIN: "https://broker.test", AUTHORIZED_EMAIL_DOMAIN: "example.com", AUTH_PROXY_SECRET: "12345678901234567890123456789012" };

test("production trusts only the configured OIDC proxy identity", () => {
  const request = new Request("https://broker.test/api/account", { headers: { "x-auth-proxy-secret": production.AUTH_PROXY_SECRET, "x-auth-request-email": "advisor@example.com" } });
  expect(actorFor(request, production)).toBe("advisor@example.com");
  expect(() => actorFor(new Request(request.url), production)).toThrow("Unauthorized");
  expect(() => actorFor(new Request(request, { headers: { "x-auth-proxy-secret": production.AUTH_PROXY_SECRET, "x-auth-request-email": "advisor@evil.test" } }), production)).toThrow("Unauthorized");
  expect(securityReady(production)).toBe(true);
  expect(securityReady({ NODE_ENV: "production" })).toBe(false);
});

test("mutations are same-origin and rate limited", () => {
  expect(validMutationOrigin(new Request("https://broker.test/api/orders", { headers: { origin: "https://broker.test" } }), production)).toBe(true);
  expect(validMutationOrigin(new Request("https://broker.test/api/orders", { headers: { origin: "https://evil.test" } }), production)).toBe(false);
  const hit = rateLimiter(100);
  expect(hit("advisor", 2, 0)).toBe(true);
  expect(hit("advisor", 2, 1)).toBe(true);
  expect(hit("advisor", 2, 2)).toBe(false);
  expect(hit("advisor", 2, 101)).toBe(true);
});
