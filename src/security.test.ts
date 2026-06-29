import { expect, test } from "bun:test";
import { actorFor, authContextFor, authorize, rateLimiter, securityReady, validMutationOrigin } from "./security";

const production = { NODE_ENV: "production", APP_ORIGIN: "https://broker.test", AUTHORIZED_EMAIL_DOMAIN: "example.com", AUTH_PROXY_SECRET: "12345678901234567890123456789012", SECRET_VAULT_KEY: "abcdefghijklmnopqrstuvwxyz123456" };

test("production trusts only the configured OIDC proxy identity", () => {
  const request = new Request("https://broker.test/api/account", { headers: { "x-auth-proxy-secret": production.AUTH_PROXY_SECRET, "x-auth-request-email": "advisor@example.com" } });
  expect(actorFor(request, production)).toBe("advisor@example.com");
  expect(() => actorFor(new Request(request.url), production)).toThrow("Unauthorized");
  expect(() => actorFor(new Request(request, { headers: { "x-auth-proxy-secret": production.AUTH_PROXY_SECRET, "x-auth-request-email": "advisor@evil.test" } }), production)).toThrow("Unauthorized");
  expect(securityReady(production)).toBe(true);
  expect(securityReady({ NODE_ENV: "production" })).toBe(false);
  expect(securityReady({ ...production, SECRET_VAULT_KEY: "" })).toBe(false);
});

test("production authorization exposes proxy roles and admin email overrides", () => {
  const request = new Request("https://broker.test/api/account", { headers: { "x-auth-proxy-secret": production.AUTH_PROXY_SECRET, "x-auth-request-email": "trader@example.com", "x-auth-request-roles": "trader,researcher" } });
  const context = authContextFor(request, production);
  expect(context).toMatchObject({ actor: "trader@example.com", roles: ["viewer", "researcher", "trader"] });
  expect(authorize(context, ["trader"])).toBe(true);
  expect(() => authorize(context, ["admin"])).toThrow("Forbidden");

  const admin = authContextFor(new Request("https://broker.test/api/account", { headers: { "x-auth-proxy-secret": production.AUTH_PROXY_SECRET, "x-auth-request-email": "owner@example.com" } }), { ...production, AUTHORIZED_ADMIN_EMAILS: "owner@example.com" });
  expect(admin.roles).toEqual(["viewer", "researcher", "trader", "operator", "admin"]);
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

test("rate limiter bounds identity storage and recovers after expiry", () => {
  const hit = rateLimiter(100, 2);
  expect(hit("one", 1, 0)).toBe(true);
  expect(hit("two", 1, 0)).toBe(true);
  expect(hit("three", 1, 0)).toBe(false);
  expect(hit("three", 1, 101)).toBe(true);
});
