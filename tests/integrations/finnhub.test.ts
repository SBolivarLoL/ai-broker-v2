import { expect, test } from "bun:test";
import { FinnhubClient } from "../../backend/integrations/finnhub";

const now = Date.UTC(2026, 5, 29, 12);
const payload = (path: string) => {
  if (path.endsWith("/stock/profile2"))
    return {
      name: "Apple Inc",
      ticker: "AAPL",
      country: "US",
      currency: "USD",
      exchange: "NASDAQ NMS - GLOBAL MARKET",
      finnhubIndustry: "Technology",
      ipo: "1980-12-12",
      weburl: "https://www.apple.com/",
      phone: "must not leak",
      marketCapitalization: 123,
    };
  if (path.endsWith("/stock/earnings"))
    return [
      {
        actual: 1.65,
        estimate: 1.63,
        period: "2026-03-31",
        quarter: 2,
        surprise: 0.02,
        surprisePercent: 1.227,
        symbol: "AAPL",
        year: 2026,
      },
      { actual: "invalid", estimate: 1.2, period: "2025-12-31" },
    ];
  return [
    {
      category: "company",
      datetime: 1782730800,
      headline: "Apple supplier update",
      id: 41,
      related: "AAPL,MSFT",
      source: "Example News",
      summary: "A bounded summary.",
      url: "https://news.example/apple?utm_source=feed",
    },
    {
      category: "company",
      datetime: 0,
      headline: "Bad item",
      id: 42,
      url: "javascript:alert(1)",
    },
  ];
};

test("Finnhub stays optional and does not fetch without a valid key", async () => {
  let calls = 0;
  const missing = new FinnhubClient({
    env: {},
    fetchImpl: async () => {
      calls++;
      throw new Error("must not fetch");
    },
    now: () => now,
  });
  expect(await missing.companyEnrichment("aapl")).toMatchObject({
    symbol: "AAPL",
    configured: false,
    status: "missing_key",
    sources: [],
    coverage: {
      profile: "missing_key",
      earnings: "missing_key",
      news: "missing_key",
    },
  });
  const invalid = new FinnhubClient({
    env: { FINNHUB_API_KEY: "bad key" },
    fetchImpl: async () => {
      calls++;
      throw new Error("must not fetch");
    },
    now: () => now,
  });
  expect(await invalid.companyEnrichment("AAPL")).toMatchObject({
    configured: false,
    status: "misconfigured",
  });
  expect(calls).toBe(0);
});

test("Finnhub normalizes free profile, earnings, and news into typed canonical evidence", async () => {
  const urls: string[] = [];
  const client = new FinnhubClient({
    env: { FINNHUB_API_KEY: "valid_key_123" },
    now: () => now,
    minIntervalMs: 0,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      expect(new Headers(init?.headers).get("X-Finnhub-Token")).toBe(
        "valid_key_123",
      );
      expect(url.searchParams.has("token")).toBe(false);
      return Response.json(payload(url.pathname));
    },
  });
  const result = await client.companyEnrichment("aapl");
  expect(result).toMatchObject({
    symbol: "AAPL",
    configured: true,
    status: "available",
    profile: {
      name: "Apple Inc",
      ticker: "AAPL",
      industry: "Technology",
      ipoDate: "1980-12-12",
    },
  });
  expect(result.profile).not.toHaveProperty("phone");
  expect(result.profile).not.toHaveProperty("marketCapitalization");
  expect(result.earnings).toEqual([
    {
      period: "2026-03-31",
      actual: 1.65,
      estimate: 1.63,
      surprise: 0.02,
      surprisePercent: 1.227,
      quarter: 2,
      year: 2026,
    },
  ]);
  expect(result.news).toEqual([
    expect.objectContaining({
      id: "41",
      headline: "Apple supplier update",
      relatedSymbols: ["AAPL", "MSFT"],
    }),
  ]);
  expect(result.sources).toHaveLength(3);
  expect(
    result.sources.find((source) => source.id === "finnhub:profile:AAPL"),
  ).toMatchObject({
    authority: "licensed_provider",
    claimStatus: "provider_record",
    category: "identity",
  });
  expect(
    result.sources.find((source) => source.id === "finnhub:earnings:AAPL"),
  ).toMatchObject({ claimStatus: "provider_record", category: "fundamentals" });
  expect(
    result.sources.find((source) => source.id === "finnhub:news:41"),
  ).toMatchObject({
    claimStatus: "media_signal",
    category: "news",
    canonicalUrl: "https://news.example/apple",
  });
  expect(JSON.stringify(result)).not.toContain("valid_key_123");
  expect(urls).toHaveLength(3);
  await client.companyEnrichment("AAPL");
  expect(urls).toHaveLength(3);
});

test("Finnhub preserves partial results and makes throttling explicit", async () => {
  const calls = new Map<string, number>();
  const client = new FinnhubClient({
    env: { FINNHUB_API_KEY: "valid_key_123" },
    now: () => now,
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.set(path, (calls.get(path) ?? 0) + 1);
      if (path.endsWith("/stock/profile2")) return Response.json(payload(path));
      if (path.endsWith("/stock/earnings"))
        return new Response("limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      return new Response("down", { status: 503 });
    },
  });
  const result = await client.companyEnrichment("AAPL");
  expect(result).toMatchObject({
    status: "partial",
    coverage: {
      profile: "available",
      earnings: "rate_limited",
      news: "unavailable",
    },
  });
  expect(result.profile?.name).toBe("Apple Inc");
  expect(result.warnings.join(" ")).toContain("rate limited");
  expect(calls.get("/api/v1/stock/earnings")).toBe(2);
  expect(calls.get("/api/v1/company-news")).toBe(2);
});

test("Finnhub rejects a mismatched profile and serializes calls below the free-tier ceiling", async () => {
  let clock = 100_000;
  const requestedAt: number[] = [];
  const client = new FinnhubClient({
    env: { FINNHUB_API_KEY: "valid_key_123" },
    now: () => clock,
    minIntervalMs: 1_100,
    sleep: async (ms) => {
      clock += ms;
    },
    fetchImpl: async (input) => {
      requestedAt.push(clock);
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stock/profile2"))
        return Response.json({ name: "Microsoft", ticker: "MSFT" });
      return Response.json([]);
    },
  });
  const result = await client.companyEnrichment("AAPL");
  expect(requestedAt).toEqual([100_000, 101_100, 102_200]);
  expect(result.coverage.profile).toBe("unavailable");
  expect(result.profile).toBeNull();
  expect(result.warnings.join(" ")).toContain("no matching company profile");
});

test("Finnhub rejects invalid or unbounded requests before fetching", async () => {
  const client = new FinnhubClient({
    env: { FINNHUB_API_KEY: "valid_key_123" },
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  expect(() => client.companyEnrichment("bad symbol")).toThrow(
    "valid stock symbol",
  );
  expect(() => client.companyEnrichment("AAPL", 31)).toThrow("1 to 30 days");
});
