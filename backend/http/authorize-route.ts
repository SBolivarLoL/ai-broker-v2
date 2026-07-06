import { authorize, type AuthContext } from "../shared/security";

/** Enforces the minimum role for each API route family. */
export function authorizeRoute(
  auth: AuthContext,
  path: string,
  method: string,
) {
  if (
    path.startsWith("/api/operations/secrets") ||
    path === "/api/operations/backup"
  ) {
    return authorize(auth, ["admin"]);
  }
  if (path.startsWith("/api/operations/")) {
    return authorize(
      auth,
      method === "GET" ? ["operator", "admin"] : ["admin"],
    );
  }
  if (method === "GET") return true;
  if (
    path.startsWith("/api/orders") ||
    path.startsWith("/api/options") ||
    path.startsWith("/api/strategy/crypto/orders") ||
    path.includes("/paper-approval") ||
    path.endsWith("/tick") ||
    path.endsWith("/scheduler/tick")
  ) {
    return authorize(auth, ["trader", "admin"]);
  }
  if (path.startsWith("/api/agent") || path.startsWith("/api/research")) {
    return authorize(auth, ["researcher", "admin"]);
  }
  if (path.startsWith("/api/trade-journal")) {
    return authorize(auth, ["researcher", "trader", "admin"]);
  }
  if (path.startsWith("/api/watchlists") || path.startsWith("/api/strategy")) {
    return authorize(auth, ["operator", "trader", "admin"]);
  }
  return true;
}
