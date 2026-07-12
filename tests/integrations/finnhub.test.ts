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
    endpointTimes: { profile: null, earnings: null, news: null },
    retrievedAt: null,
    serverRespondedAt: "2026-06-29T12:00:00.000Z",
    asOf: "2026-06-29T12:00:00.000Z",
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: null,
      serverResponseTime: "2026-06-29T12:00:00.000Z",
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
  let clock = now;
  const client = new FinnhubClient({
    env: { FINNHUB_API_KEY: "valid_key_123" },
    now: () => clock,
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
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
      time: {
        observationTime: null,
        publicationTime: null,
        effectivePeriod: null,
        retrievalTime: "2026-06-29T12:00:00.000Z",
        serverResponseTime: "2026-06-29T12:00:00.000Z",
      },
    },
    retrievedAt: "2026-06-29T12:00:00.000Z",
    serverRespondedAt: "2026-06-29T12:00:00.000Z",
    asOf: "2026-06-29T12:00:00.000Z",
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: "2026-06-29T12:00:00.000Z",
      serverResponseTime: "2026-06-29T12:00:00.000Z",
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
      effectivePeriod: {
        start: "2026-03-31T00:00:00.000Z",
        end: "2026-03-31T00:00:00.000Z",
        label: "Finnhub earnings period 2026-03-31",
      },
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
      time: {
        observationTime: null,
        publicationTime: null,
        effectivePeriod: {
          start: "2026-03-31T00:00:00.000Z",
          end: "2026-03-31T00:00:00.000Z",
          label: "Finnhub earnings period 2026-03-31",
        },
        retrievalTime: "2026-06-29T12:00:00.000Z",
        serverResponseTime: "2026-06-29T12:00:00.000Z",
      },
    },
  ]);
  expect(result.news).toEqual([
    expect.objectContaining({
      id: "41",
      headline: "Apple supplier update",
      relatedSymbols: ["AAPL", "MSFT"],
      publishedAt: "2026-06-29T11:00:00.000Z",
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
      time: {
        observationTime: null,
        publicationTime: "2026-06-29T11:00:00.000Z",
        effectivePeriod: null,
        retrievalTime: "2026-06-29T12:00:00.000Z",
        serverResponseTime: "2026-06-29T12:00:00.000Z",
      },
    }),
  ]);
  expect(result.endpointTimes).toEqual({
    profile: expect.objectContaining({
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
    }),
    earnings: expect.objectContaining({
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
    }),
    news: expect.objectContaining({
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
    }),
  });
  expect(result.sources).toHaveLength(3);
  expect(
    result.sources.find((source) => source.id === "finnhub:profile:AAPL"),
  ).toMatchObject({
    authority: "licensed_provider",
    claimStatus: "provider_record",
    category: "identity",
    observedAt: null,
    retrievedAt: "2026-06-29T12:00:00.000Z",
    serverRespondedAt: "2026-06-29T12:00:00.000Z",
    time: { observationTime: null },
  });
  expect(
    result.sources.find((source) => source.id === "finnhub:earnings:AAPL"),
  ).toMatchObject({
    claimStatus: "provider_record",
    category: "fundamentals",
    observedAt: null,
    retrievedAt: "2026-06-29T12:00:00.000Z",
    serverRespondedAt: "2026-06-29T12:00:00.000Z",
    effectivePeriod: {
      start: "2026-03-31T00:00:00.000Z",
      end: "2026-03-31T00:00:00.000Z",
      label: "Latest Finnhub earnings period 2026-03-31",
    },
    time: { observationTime: null },
  });
  expect(
    result.sources.find((source) => source.id === "finnhub:news:41"),
  ).toMatchObject({
    claimStatus: "media_signal",
    category: "news",
    canonicalUrl: "https://news.example/apple",
    observedAt: null,
    publishedAt: "2026-06-29T11:00:00.000Z",
    retrievedAt: "2026-06-29T12:00:00.000Z",
    serverRespondedAt: "2026-06-29T12:00:00.000Z",
    time: { observationTime: null },
  });
  expect(JSON.stringify(result)).not.toContain("valid_key_123");
  expect(urls).toHaveLength(3);
  clock += 60_000;
  const cached = await client.companyEnrichment("AAPL");
  expect(urls).toHaveLength(3);
  expect(cached.retrievedAt).toBe(result.retrievedAt);
  expect(cached.serverRespondedAt).toBe("2026-06-29T12:01:00.000Z");
  expect(cached.asOf).toBe(cached.serverRespondedAt);
  expect(cached.time.retrievalTime).toBe(result.retrievedAt);
  expect(cached.time.serverResponseTime).toBe(cached.serverRespondedAt);
  expect(cached.profile?.retrievedAt).toBe(result.profile?.retrievedAt);
  expect(cached.profile?.serverRespondedAt).toBe(cached.serverRespondedAt);
  expect(cached.earnings[0]?.retrievedAt).toBe(
    result.earnings[0]?.retrievedAt,
  );
  expect(cached.earnings[0]?.serverRespondedAt).toBe(
    cached.serverRespondedAt,
  );
  expect(cached.news[0]?.retrievedAt).toBe(result.news[0]?.retrievedAt);
  expect(cached.news[0]?.serverRespondedAt).toBe(cached.serverRespondedAt);
  expect(cached.endpointTimes.profile?.retrievedAt).toBe(
    result.endpointTimes.profile?.retrievedAt,
  );
  expect(cached.endpointTimes.profile?.serverRespondedAt).toBe(
    cached.serverRespondedAt,
  );
  expect(cached.sources.map((source) => source.contentHash)).toEqual(
    result.sources.map((source) => source.contentHash),
  );
  expect(
    cached.sources.every(
      (source) => source.serverRespondedAt === cached.serverRespondedAt,
    ),
  ).toBe(true);
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
  expect(result.endpointTimes).toMatchObject({
    profile: {
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
    },
    earnings: {
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
    },
    news: {
      retrievedAt: "2026-06-29T12:00:00.000Z",
      serverRespondedAt: "2026-06-29T12:00:00.000Z",
    },
  });
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
  const endpointRetrievals = Object.values(result.endpointTimes).map((item) =>
    Date.parse(item!.retrievedAt),
  );
  expect(endpointRetrievals.every((value) =>
    value >= requestedAt[0]! && value <= clock
  )).toBe(true);
  expect(Date.parse(result.retrievedAt!)).toBe(Math.max(...endpointRetrievals));
  expect(result.serverRespondedAt).toBe(new Date(102_200).toISOString());
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
