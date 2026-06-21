import { timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function actorFor(request: Request, env: Env = process.env) {
  if (env.NODE_ENV !== "production") return "demo-advisor";
  const secret = env.AUTH_PROXY_SECRET ?? "";
  const supplied = request.headers.get("x-auth-proxy-secret") ?? "";
  const email = request.headers.get("x-auth-request-email")?.toLowerCase() ?? "";
  const domain = env.AUTHORIZED_EMAIL_DOMAIN?.toLowerCase();
  if (secret.length < 32 || !same(secret, supplied) || !domain || !email.endsWith(`@${domain}`)) throw new Error("Unauthorized");
  return email;
}

export function validMutationOrigin(request: Request, env: Env = process.env) {
  const origin = request.headers.get("origin");
  if (!origin) return env.NODE_ENV !== "production";
  return origin === (env.APP_ORIGIN ?? new URL(request.url).origin);
}

export function securityReady(env: Env = process.env) {
  return env.NODE_ENV !== "production" || Boolean(env.APP_ORIGIN && env.AUTHORIZED_EMAIL_DOMAIN && (env.AUTH_PROXY_SECRET?.length ?? 0) >= 32);
}

export function rateLimiter(windowMs = 60_000, maximumKeys = 10_000) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string, maximum: number, now = Date.now()) => {
    const current = hits.get(key);
    if (!current || current.reset <= now) {
      if (!current && hits.size >= maximumKeys) {
        for (const [storedKey, value] of hits) if (value.reset <= now) hits.delete(storedKey);
        if (hits.size >= maximumKeys) return false;
      }
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    current.count++;
    return current.count <= maximum;
  };
}
