/** Serves only committed browser assets for isolated Playwright regression tests. */

import { join } from "node:path";

const port = Number(process.env.BROWSER_TEST_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("BROWSER_TEST_PORT must be a valid TCP port");

const frontend = join(import.meta.dir, "..", "frontend");
const assets = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/core.js", "core.js"],
  ["/portfolio.js", "portfolio.js"],
  ["/strategies.js", "strategies.js"],
  ["/market-detail.js", "market-detail.js"],
  ["/research.js", "research.js"],
  ["/data-quality.js", "data-quality.js"],
  ["/app.js", "app.js"],
]);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    if (url.pathname === "/health")
      return Response.json({ status: "ok", purpose: "browser-tests" });
    const asset = assets.get(url.pathname);
    if (!asset) return new Response("Not found", { status: 404 });
    const file = Bun.file(join(frontend, asset));
    return new Response(file, {
      headers: {
        "cache-control": "no-store",
        "content-type": file.type,
      },
    });
  },
});

console.log(`Browser test assets available at http://127.0.0.1:${port}`);
