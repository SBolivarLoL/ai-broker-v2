/**
 * Authentication and request-boundary helpers.
 *
 * The strict production path trusts only headers authenticated by the
 * configured reverse proxy. Relaxed behavior (all-role demo identity, lenient
 * origin and readiness) requires an explicit NODE_ENV of "development" or
 * "test"; any other value, including unset, uses the strict path.
 */
import { timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

// Relaxed auth is opt-in: unset or unexpected NODE_ENV fails closed to the
// strict production path.
const relaxedEnv = (env: Env) =>
  env.NODE_ENV === "development" || env.NODE_ENV === "test";
export type AuthRole =
  "viewer" | "researcher" | "trader" | "operator" | "admin";
export type AuthContext = { actor: string; email: string; roles: AuthRole[] };

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const knownRoles = new Set<AuthRole>([
  "viewer",
  "researcher",
  "trader",
  "operator",
  "admin",
]);
const roleOrder: AuthRole[] = [
  "viewer",
  "researcher",
  "trader",
  "operator",
  "admin",
];

function parseRoles(value: string | null | undefined): AuthRole[] {
  const roles = String(value ?? "")
    .split(/[,\s]+/)
    .map((role) => role.trim().toLowerCase())
    .filter((role): role is AuthRole => knownRoles.has(role as AuthRole));
  return [...new Set<AuthRole>(roles.length ? roles : ["viewer"])];
}

function expandedRoles(roles: AuthRole[]) {
  // Every authenticated user can view. Admin is the only role that expands to
  // the complete hierarchy; the other roles remain independently assignable.
  const roleSet = new Set<AuthRole>(["viewer", ...roles]);
  if (roleSet.has("admin")) return [...roleOrder];
  return roleOrder.filter((role) => roleSet.has(role));
}

export function authContextFor(
  request: Request,
  env: Env = process.env,
): AuthContext {
  // This bypass is intentionally limited to explicit development/test runs.
  if (relaxedEnv(env))
    return {
      actor: "demo-advisor",
      email: "demo-advisor",
      roles: [...roleOrder],
    };
  const secret = env.AUTH_PROXY_SECRET ?? "";
  const supplied = request.headers.get("x-auth-proxy-secret") ?? "";
  const email =
    request.headers.get("x-auth-request-email")?.toLowerCase() ?? "";
  const domain = env.AUTHORIZED_EMAIL_DOMAIN?.toLowerCase();
  if (
    secret.length < 32 ||
    !same(secret, supplied) ||
    !domain ||
    !email.endsWith(`@${domain}`)
  )
    throw new Error("Unauthorized");
  const adminEmails = new Set(
    String(env.AUTHORIZED_ADMIN_EMAILS ?? "")
      .toLowerCase()
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const rawRoles =
    request.headers.get(
      env.AUTH_PROXY_ROLES_HEADER ?? "x-auth-request-roles",
    ) ?? request.headers.get("x-auth-request-groups");
  const roles = adminEmails.has(email)
    ? ["admin" as const]
    : parseRoles(rawRoles);
  return { actor: email, email, roles: expandedRoles(roles) };
}

export function actorFor(request: Request, env: Env = process.env) {
  return authContextFor(request, env).actor;
}

export function authorize(context: AuthContext, allowed: AuthRole[]) {
  if (!allowed.some((role) => context.roles.includes(role)))
    throw new Error("Forbidden");
  return true;
}

export function validMutationOrigin(request: Request, env: Env = process.env) {
  const origin = request.headers.get("origin");
  if (!origin) return relaxedEnv(env);
  const configuredOrigin = env.APP_ORIGIN?.trim();
  return origin === (configuredOrigin || new URL(request.url).origin);
}

export function securityReady(env: Env = process.env) {
  return (
    relaxedEnv(env) ||
    Boolean(
      env.APP_ORIGIN &&
      env.AUTHORIZED_EMAIL_DOMAIN &&
      (env.AUTH_PROXY_SECRET?.length ?? 0) >= 32 &&
      (env.SECRET_VAULT_KEY?.length ?? 0) >= 32,
    )
  );
}

export function rateLimiter(windowMs = 60_000, maximumKeys = 10_000) {
  // Entries expire lazily on new windows, bounding memory without a cleanup
  // timer. If the map is still full, new identities fail closed.
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string, maximum: number, now = Date.now()) => {
    const current = hits.get(key);
    if (!current || current.reset <= now) {
      if (!current && hits.size >= maximumKeys) {
        for (const [storedKey, value] of hits)
          if (value.reset <= now) hits.delete(storedKey);
        if (hits.size >= maximumKeys) return false;
      }
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    current.count++;
    return current.count <= maximum;
  };
}
