import { expect, test } from "bun:test";
import { OpenFigiClient } from "../../backend/integrations/openfigi";

const now = Date.UTC(2026, 5, 29, 12);
const apple = {
  figi: "BBG000B9XRY4",
  compositeFIGI: "BBG000B9XRY4",
  shareClassFIGI: "BBG001S5N8V8",
  ticker: "AAPL",
  name: "APPLE INC",
  exchCode: "US",
  marketSector: "Equity",
  securityType: "Common Stock",
  securityType2: "Common Stock",
  securityDescription: "AAPL",
};

test("OpenFIGI maps a constrained public ticker job into canonical identity evidence", async () => {
  let calls = 0;
  const client = new OpenFigiClient({
    env: {},
    now: () => now,
    minIntervalMs: 0,
    fetchImpl: async (input, init) => {
      calls++;
      expect(String(input)).toBe("https://api.openfigi.com/v3/mapping");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).has("X-OPENFIGI-APIKEY")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual([
        {
          idType: "TICKER",
          idValue: "AAPL",
          exchCode: "US",
          marketSecDes: "Equity",
        },
      ]);
      return Response.json([{ data: [apple] }]);
    },
  });
  const result = await client.mapIdentity("aapl", "Apple Inc. Common Stock");
  expect(result).toMatchObject({
    symbol: "AAPL",
    status: "matched",
    keyStatus: "anonymous",
    matchQuality: "company_name_confirmed",
    canonicalFigi: "BBG000B9XRY4",
    candidateCount: 1,
  });
  expect(result.selected).toMatchObject({
    figi: "BBG000B9XRY4",
    name: "APPLE INC",
    securityType2: "Common Stock",
  });
  expect(result.sources).toEqual([
    expect.objectContaining({
      provider: "openfigi",
      category: "identity",
      authority: "official",
      claimStatus: "official_record",
      entityIds: { symbol: "AAPL", figi: "BBG000B9XRY4" },
    }),
  ]);
  await client.mapIdentity("AAPL", "Apple Inc. Common Stock");
  expect(calls).toBe(1);
});

test("OpenFIGI sends a valid optional key only in the request header", async () => {
  const client = new OpenFigiClient({
    env: { OPENFIGI_API_KEY: "valid_key_123" },
    now: () => now,
    minIntervalMs: 0,
    fetchImpl: async (input, init) => {
      expect(new URL(String(input)).search).toBe("");
      expect(new Headers(init?.headers).get("X-OPENFIGI-APIKEY")).toBe(
        "valid_key_123",
      );
      return Response.json([{ data: [apple] }]);
    },
  });
  const result = await client.mapIdentity("AAPL", "Apple Inc.");
  expect(result.keyStatus).toBe("configured");
  expect(JSON.stringify(result)).not.toContain("valid_key_123");
});

test("OpenFIGI collapses venue rows but refuses distinct ambiguous identities", async () => {
  const other = {
    ...apple,
    figi: "BBG000000001",
    compositeFIGI: "BBG000000001",
    shareClassFIGI: "BBG000000002",
    name: "APPLE HOSPITALITY REIT INC",
  };
  const venue = { ...apple, figi: "BBG000000003", exchCode: "US" };
  const client = new OpenFigiClient({
    env: {},
    now: () => now,
    minIntervalMs: 0,
    fetchImpl: async () => Response.json([{ data: [apple, venue, other] }]),
  });
  const result = await client.mapIdentity(
    "AAPL",
    "Unrelated Company Common Stock",
  );
  expect(result).toMatchObject({
    status: "ambiguous",
    canonicalFigi: null,
    selected: null,
    candidateCount: 2,
  });
  expect(result.warnings.join(" ")).toContain("no FIGI was selected");
  expect(result.sources[0]?.entityIds).toEqual({ symbol: "AAPL" });
});

test("OpenFIGI treats a v3 warning as a sourced no-match outcome", async () => {
  const client = new OpenFigiClient({
    env: {},
    now: () => now,
    minIntervalMs: 0,
    fetchImpl: async () => Response.json([{ warning: "No identifier found." }]),
  });
  const result = await client.mapIdentity("ZZZZ", "Unknown Company");
  expect(result).toMatchObject({
    status: "not_found",
    selected: null,
    candidates: [],
    candidateCount: 0,
  });
  expect(result.warnings).toContain("No identifier found.");
  expect(result.sources).toHaveLength(1);
});

test("OpenFIGI retries and caches explicit rate-limit coverage loss", async () => {
  let calls = 0;
  const client = new OpenFigiClient({
    env: {},
    now: () => now,
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      return new Response("limited", {
        status: 429,
        headers: { "ratelimit-reset": "0" },
      });
    },
  });
  const result = await client.mapIdentity("AAPL", "Apple Inc.");
  expect(result).toMatchObject({
    status: "rate_limited",
    selected: null,
    sources: [],
  });
  expect(result.warnings[0]).toContain(
    "no ticker-to-FIGI join should be assumed",
  );
  await client.mapIdentity("AAPL", "Apple Inc.");
  expect(calls).toBe(2);
});

test("OpenFIGI serializes public mapping calls below the anonymous limit", async () => {
  let clock = 100_000;
  const requestedAt: number[] = [];
  const client = new OpenFigiClient({
    env: {},
    now: () => clock,
    minIntervalMs: 2_500,
    sleep: async (ms) => {
      clock += ms;
    },
    fetchImpl: async () => {
      requestedAt.push(clock);
      return Response.json([{ warning: "No identifier found." }]);
    },
  });
  await Promise.all([
    client.mapIdentity("AAPL", "Apple Inc."),
    client.mapIdentity("MSFT", "Microsoft Corporation"),
  ]);
  expect(requestedAt).toEqual([100_000, 102_500]);
});

test("OpenFIGI rejects invalid mapping inputs before fetching", () => {
  const client = new OpenFigiClient({
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  expect(() => client.mapIdentity("bad symbol", "Apple Inc.")).toThrow(
    "valid stock symbol",
  );
  expect(() => client.mapIdentity("AAPL", " ")).toThrow("company name");
});
