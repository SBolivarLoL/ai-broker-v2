import { expect, test } from "bun:test";
import { GdeltClient } from "./gdelt";

const payload = {
  articles: [
    { url: "https://news.example/apple-update?utm_source=feed", title: "Apple &amp; supplier update", seendate: "20260628T123000Z", domain: "news.example", language: "English", sourcecountry: "United States" },
    { url: "https://news.example/apple-update?utm_source=feed", title: "Apple &amp; supplier update", seendate: "20260628T123000Z", domain: "news.example", language: "English", sourcecountry: "United States" },
    { url: "https://news.example/trademark-guide", title: "A complete guide to trademark litigation", seendate: "20260628T121500Z", domain: "news.example", language: "English", sourcecountry: "United States" },
    { url: "javascript:alert(1)", title: "Invalid URL", seendate: "20260628T120000Z" },
    { url: "https://news.example/missing-date", title: "Missing date", seendate: "invalid" },
  ],
};

test("GDELT normalizes bounded company media signals into canonical evidence", async () => {
  let calls = 0;
  const client = new GdeltClient({
    fetchImpl: async input => {
      calls++;
      const url = new URL(String(input));
      expect(url.searchParams.get("query")).toBe('"Apple Inc."');
      expect(url.searchParams.get("mode")).toBe("artlist");
      expect(url.searchParams.get("timespan")).toBe("3d");
      expect(url.searchParams.get("sort")).toBe("datedesc");
      return Response.json(payload);
    },
    now: () => Date.UTC(2026, 5, 29), minIntervalMs: 0,
  });
  const result = await client.companySignals("aapl", "Apple Inc. Common Stock");
  expect(result).toMatchObject({ symbol: "AAPL", companyName: "Apple Inc. Common Stock", query: '"Apple Inc."', available: true, rateLimited: false, filteredOut: 1, warnings: [expect.stringContaining("headline-level company relevance")] });
  expect(result.articles).toEqual([expect.objectContaining({ headline: "Apple & supplier update", domain: "news.example", publishedAt: "2026-06-28T12:30:00.000Z" })]);
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toMatchObject({ provider: "gdelt", authority: "public_web", claimStatus: "media_signal", category: "news", canonicalUrl: "https://news.example/apple-update" });
  expect(result.sources[0]?.data).toMatchObject({ classification: "media signal, not verified fact" });
  await client.companySignals("AAPL", "Apple Inc. Common Stock");
  expect(calls).toBe(1);
});

test("GDELT retries a transient throttle and keeps one in-flight request", async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = new GdeltClient({
    fetchImpl: async () => ++calls === 1 ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }) : Response.json({ articles: [] }),
    sleep: async ms => { delays.push(ms); }, now: () => Date.UTC(2026, 5, 29), minIntervalMs: 0,
  });
  const [first, second] = await Promise.all([client.companySignals("AAPL", "Apple Inc."), client.companySignals("AAPL", "Apple Inc.")]);
  expect(first.available).toBe(true);
  expect(second).toBe(first);
  expect(calls).toBe(2);
  expect(delays).toContain(0);
});

test("GDELT caches explicit rate-limit coverage loss without inventing no-news", async () => {
  let calls = 0;
  const client = new GdeltClient({ fetchImpl: async () => { calls++; return new Response("rate limited", { status: 429 }); }, sleep: async () => {}, now: () => Date.UTC(2026, 5, 29), minIntervalMs: 0 });
  const result = await client.companySignals("MSFT", "Microsoft Corporation");
  expect(result).toMatchObject({ available: false, rateLimited: true, articles: [], sources: [] });
  expect(result.warnings[0]).toContain("no absence of events should be inferred");
  await client.companySignals("MSFT", "Microsoft Corporation");
  expect(calls).toBe(2);
});

test("GDELT serializes distinct company queries at the documented interval", async () => {
  let now = 100_000;
  const requestedAt: number[] = [];
  const client = new GdeltClient({
    fetchImpl: async () => { requestedAt.push(now); return Response.json({ articles: [] }); },
    sleep: async ms => { now += ms; }, now: () => now, minIntervalMs: 5_000,
  });
  await Promise.all([client.companySignals("AAPL", "Apple Inc."), client.companySignals("MSFT", "Microsoft Corporation")]);
  expect(requestedAt).toEqual([100_000, 105_000]);
});

test("GDELT rejects ambiguous or unbounded requests before fetching", async () => {
  const client = new GdeltClient({ fetchImpl: async () => { throw new Error("must not fetch"); } });
  expect(() => client.companySignals("bad symbol", "Apple Inc.")).toThrow("valid stock symbol");
  expect(() => client.companySignals("AAPL", "A", 3, 10)).toThrow("company name");
  expect(() => client.companySignals("AAPL", "Apple Inc.", 30, 10)).toThrow("1 to 7 days");
});
