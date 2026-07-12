import { describe, expect, test } from "bun:test";
import { accountStateDto } from "../../backend/features/portfolio/account-state";
import { buildFixedIncomeResearchStatus } from "../../backend/features/research/fixed-income-research";
import { CompanyResearchOutput } from "../../backend/features/research/research";
import { buildSecFinancialTrends } from "../../backend/features/research/sec-financial-trends";
import { validPortfolioQuestionOutput } from "../../backend/features/research/copilot";
import { DATA_GOVERNANCE_SOURCES } from "../../backend/features/operations/data-governance";
import { companyMarketSnapshot } from "../../backend/features/markets/company-market";
import { monitoringNews } from "../../backend/features/markets/market-monitoring";
import { buildVersionedCryptoDataset } from "../../backend/features/strategies/strategy-datasets";
import { getStockBarsWithFallback } from "../../backend/integrations/alpaca/market-data";
import { FinnhubClient } from "../../backend/integrations/finnhub";
import { GdeltClient } from "../../backend/integrations/gdelt";
import { MacroContextClient } from "../../backend/integrations/macro-context";
import { OpenFigiClient } from "../../backend/integrations/openfigi";
import {
  SecEdgarClient,
  type SecCompany,
  type SecFacts,
} from "../../backend/integrations/sec-edgar";
import {
  fixturePayload,
  loadProviderFixture,
  loadProviderFixtureManifest,
} from "./provider-fixtures";

const now = Date.UTC(2026, 6, 12, 20, 30);
const at = "2026-07-12T20:30:00.000Z";

type TransportFixture = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

function responseFromTransport(value: TransportFixture) {
  return new Response(
    typeof value.body === "string" ? value.body : JSON.stringify(value.body),
    { status: value.status, headers: value.headers },
  );
}

async function fixturesByFile() {
  const manifest = await loadProviderFixtureManifest();
  return Promise.all(
    manifest.fixtures.map(async (entry) => ({
      entry,
      fixture: await loadProviderFixture(entry.file),
    })),
  );
}

function inspectPayload(value: unknown, path = "payload") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectPayload(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      expect(value, `${path} contains a credential-like value`).not.toMatch(
        /(?:\bBearer\s+|\bsk-(?:proj-)?|\bgh[opsu]_|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
      );
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (/^(?:authorization|cookie|api[_-]?key|access[_-]?token|secret)$/i.test(key))
      throw new Error(`${itemPath} is a forbidden credential field`);
    if (/^(?:account[_-]?(?:id|number)|email)$/i.test(key))
      throw new Error(`${itemPath} is a forbidden identity field`);
    if (/^phone$/i.test(key)) expect(item).toBe("removed");
    inspectPayload(item, itemPath);
  }
}

describe("recorded and redacted provider fixture inventory", () => {
  test("covers every external governance source and every required edge class", async () => {
    const loaded = await fixturesByFile();
    const manifestIds = loaded.flatMap(({ entry }) => entry.sourceIds).toSorted();
    const fixtureIds = loaded
      .flatMap(({ fixture }) => fixture.sourceIds)
      .toSorted();
    const governedExternalIds = DATA_GOVERNANCE_SOURCES
      .filter((source) => source.id !== "local_derived_analytics")
      .map((source) => source.id)
      .toSorted();

    expect(manifestIds).toEqual(governedExternalIds);
    expect(fixtureIds).toEqual(governedExternalIds);
    expect(new Set(manifestIds).size).toBe(manifestIds.length);
    expect(
      [...new Set(loaded.flatMap(({ fixture }) =>
        fixture.cases.map((contractCase) => contractCase.class)
      ))].toSorted(),
    ).toEqual([
      "baseline",
      "malformed",
      "partial",
      "rate_limit",
      "revision",
      "timestamp_edge",
    ]);

    for (const { entry, fixture } of loaded) {
      expect(entry.sourceIds.toSorted()).toEqual(fixture.sourceIds.toSorted());
      expect(fixture.redaction.review.length).toBeGreaterThan(20);
      for (const origin of fixture.origins) {
        expect(Boolean(origin.rawSha256)).not.toBe(
          Boolean(origin.digestOmissionReason),
        );
        if (origin.kind === "live_redacted")
          expect(origin.rawSha256 ?? origin.digestOmissionReason).toBeTruthy();
      }
      for (const contractCase of fixture.cases)
        expect(fixture.payloads).toHaveProperty(contractCase.payload);
      inspectPayload(fixture.payloads, fixture.id);
    }
  });

  test("does not misrepresent documentation or application contracts as recordings", async () => {
    const loaded = await fixturesByFile();
    for (const { fixture } of loaded) {
      const originKinds = new Set(fixture.origins.map((origin) => origin.kind));
      for (const contractCase of fixture.cases) {
        if (contractCase.derivation === "official_documentation_mutation")
          expect(originKinds.has("official_documentation_redacted")).toBe(true);
        if (contractCase.derivation === "application_contract")
          expect(originKinds.has("application_capability_contract")).toBe(true);
        if (contractCase.derivation.startsWith("redacted_recording"))
          expect(originKinds.has("live_redacted")).toBe(true);
      }
    }
  });
});

describe("Alpaca provider contracts", () => {
  test("preserves missing private state, UTC edge timestamps, revisions, and fixed-income gating", async () => {
    const fixture = await loadProviderFixture("alpaca.json");
    const state = fixturePayload<{
      account: Record<string, unknown>;
      positions: Array<Record<string, unknown>>;
      orders: unknown[];
    }>(fixture, "paper_state_partial");
    const account = accountStateDto({
      account: state.account,
      positions: state.positions as any,
      orders: state.orders as any,
      retrievedAt: at,
      serverRespondedAt: at,
    });
    expect(account.positions[0]?.marketValue).toBeNull();
    expect(account.positions[0]?.observedAt).toBeNull();

    const edge = fixturePayload<Record<string, unknown>>(
      fixture,
      "iex_bar_timestamp_edge",
    );
    const market = companyMarketSnapshot(
      { symbol: "ACME", exchange: "IEX" },
      {},
      [edge as any],
      [],
      {},
      "1Y",
      "SPY",
      [],
      at,
      at,
    );
    expect(market.bars[0]?.observedAt).toBe("2026-03-29T00:59:59.999Z");

    const rawBars = fixturePayload<Record<string, unknown[]>>(
      fixture,
      "crypto_revision_bars",
    );
    const dataset = buildVersionedCryptoDataset({
      request: {
        symbols: ["BTC/USD"],
        timeframe: "1Hour",
        start: new Date("2026-10-25T00:00:00.000Z"),
        end: new Date("2026-10-25T02:00:00.000Z"),
      },
      rawBars,
    });
    expect(dataset.stats).toMatchObject({
      requestedBars: 3,
      acceptedBars: 1,
      rejectedBars: 1,
      duplicateBars: 1,
      conflictingDuplicates: 1,
    });
    expect(dataset.bars[0]?.timestamp).toBe("2026-10-25T00:59:00.000Z");

    const news = monitoringNews(
      fixturePayload<unknown[]>(fixture, "news_partial"),
      [{ symbol: "ACME", qty: "1" }],
      [],
      at,
      at,
    );
    expect(news).toHaveLength(1);
    expect(news[0]?.url).toBe("https://example.invalid/acme-update");

    expect(buildFixedIncomeResearchStatus(at)).toMatchObject({
      status: "unavailable",
      accountSupport: { enabledForThisAccount: false },
    });
  });

  test("does not misclassify a SIP transport throttle as entitlement denial", async () => {
    const fixture = await loadProviderFixture("alpaca.json");
    const throttle = fixturePayload<TransportFixture>(fixture, "sip_rate_limit");
    let calls = 0;
    await expect(
      getStockBarsWithFallback(
        {
          async getStockBarsFor() {
            calls++;
            const body = throttle.body as { message: string };
            throw new Error(body.message);
          },
        },
        "ACME",
        { start: new Date("2026-07-01T00:00:00.000Z") },
      ),
    ).rejects.toThrow("rate limit exceeded");
    expect(calls).toBe(1);
  });
});

describe("SEC EDGAR provider contracts", () => {
  test("omits malformed filing rows and applies amendment cutoffs", async () => {
    const fixture = await loadProviderFixture("sec-edgar.json");
    const tickers = fixturePayload(fixture, "tickers");
    const submissions = fixturePayload(fixture, "submissions_partial");
    const client = new SecEdgarClient({
      userAgent: "AI Broker contract-tests@example.invalid",
      now: () => now,
      sleep: async () => {},
      minIntervalMs: 100,
      fetchImpl: async (input) =>
        String(input).endsWith("company_tickers.json")
          ? Response.json(tickers)
          : Response.json(submissions),
    });
    const result = await client.recentFilings("ACME");
    expect(result.filings).toHaveLength(2);
    expect(result.filings.every((filing) => filing.publishedAt !== null)).toBe(
      true,
    );
    expect(result.filings[1]).toMatchObject({
      reportDate: "",
      effectivePeriod: null,
    });
    expect(JSON.stringify(result)).not.toContain("not-a-date");

    const facts = fixturePayload<SecFacts>(fixture, "company_facts_revisions");
    const company: SecCompany = {
      cik: "0001234567",
      cikNumber: "1234567",
      ticker: "ACME",
      title: "ACME Corp",
    };
    const latest = buildSecFinancialTrends(company, facts);
    const historical = buildSecFinancialTrends(
      company,
      facts,
      4,
      8,
      "2025-06-30",
    );
    expect(latest.metrics[0]?.quarterly[0]?.value).toBe(110);
    expect(historical.metrics[0]?.quarterly[0]?.value).toBe(100);
    expect(historical.pointInTime.excludedPostCutoffObservations).toBe(1);
  });

  test("retries the recorded SEC throttle within the configured bound", async () => {
    const fixture = await loadProviderFixture("sec-edgar.json");
    const throttle = fixturePayload<TransportFixture>(fixture, "rate_limit");
    const tickers = fixturePayload(fixture, "tickers");
    let calls = 0;
    const client = new SecEdgarClient({
      userAgent: "AI Broker contract-tests@example.invalid",
      now: () => now,
      sleep: async () => {},
      minIntervalMs: 100,
      maxRetries: 1,
      fetchImpl: async () =>
        ++calls === 1
          ? responseFromTransport(throttle)
          : Response.json(tickers),
    });
    expect((await client.company("ACME")).ticker).toBe("ACME");
    expect(calls).toBe(2);
  });
});

describe("public and optional enrichment provider contracts", () => {
  test("normalizes GDELT timestamps and excludes unsafe or undated rows", async () => {
    const fixture = await loadProviderFixture("gdelt.json");
    const client = new GdeltClient({
      now: () => now,
      minIntervalMs: 0,
      fetchImpl: async () =>
        Response.json(fixturePayload(fixture, "articles_mixed")),
    });
    const result = await client.companySignals("ACME", "ACME Corp");
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.publishedAt).toBe("2026-10-25T01:30:00.000Z");
    expect(result.articles[0]?.url).toBe(
      "https://example.invalid/acme-update?utm_source=feed",
    );
  });

  test("makes GDELT throttling explicit without inventing no-news", async () => {
    const fixture = await loadProviderFixture("gdelt.json");
    const throttle = fixturePayload<TransportFixture>(fixture, "rate_limit");
    const result = await new GdeltClient({
      now: () => now,
      minIntervalMs: 0,
      maxRetries: 0,
      fetchImpl: async () => responseFromTransport(throttle),
    }).companySignals("ACME", "ACME Corp");
    expect(result).toMatchObject({
      available: false,
      rateLimited: true,
      articles: [],
    });
    expect(result.warnings.join(" ")).toContain("no absence");
  });

  test("allow-lists Finnhub fields and retains valid rows from malformed arrays", async () => {
    const fixture = await loadProviderFixture("finnhub.json");
    const client = new FinnhubClient({
      env: { FINNHUB_API_KEY: "fixture_key_123" },
      now: () => now,
      minIntervalMs: 0,
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/stock/profile2"))
          return Response.json(fixturePayload(fixture, "profile"));
        if (path.endsWith("/stock/earnings"))
          return Response.json(fixturePayload(fixture, "earnings_partial"));
        return Response.json(fixturePayload(fixture, "news_timestamp_edge"));
      },
    });
    const result = await client.companyEnrichment("ACME");
    expect(result.profile).not.toHaveProperty("phone");
    expect(result.profile).not.toHaveProperty("marketCapitalization");
    expect(result.earnings).toHaveLength(1);
    expect(result.news).toHaveLength(1);
    expect(result.news[0]?.publishedAt).toBe("2026-10-25T01:30:00.000Z");
  });

  test("keeps Finnhub endpoint throttling partial rather than erasing other endpoints", async () => {
    const fixture = await loadProviderFixture("finnhub.json");
    const throttle = fixturePayload<TransportFixture>(fixture, "rate_limit");
    const client = new FinnhubClient({
      env: { FINNHUB_API_KEY: "fixture_key_123" },
      now: () => now,
      minIntervalMs: 0,
      maxRetries: 0,
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/stock/profile2"))
          return Response.json(fixturePayload(fixture, "profile"));
        if (path.endsWith("/stock/earnings"))
          return responseFromTransport(throttle);
        return Response.json(fixturePayload(fixture, "news_timestamp_edge"));
      },
    });
    const result = await client.companyEnrichment("ACME");
    expect(result).toMatchObject({
      status: "partial",
      coverage: {
        profile: "available",
        earnings: "rate_limited",
        news: "available",
      },
    });
  });

  test("distinguishes OpenFIGI match, warning, malformed, and throttle envelopes", async () => {
    const fixture = await loadProviderFixture("openfigi.json");
    const run = (payload: unknown | TransportFixture) =>
      new OpenFigiClient({
        env: {},
        now: () => now,
        minIntervalMs: 0,
        maxRetries: 0,
        fetchImpl: async () =>
          (payload as TransportFixture).status
            ? responseFromTransport(payload as TransportFixture)
            : Response.json(payload),
      }).mapIdentity("IBM", "International Business Machines Corp");

    expect(await run(fixturePayload(fixture, "mapping"))).toMatchObject({
      status: "matched",
      canonicalFigi: "BBG000BLNNH6",
    });
    expect(await run(fixturePayload(fixture, "partial_warning"))).toMatchObject(
      { status: "not_found", selected: null },
    );
    expect(await run(fixturePayload(fixture, "malformed"))).toMatchObject({
      status: "unavailable",
      selected: null,
    });
    expect(await run(fixturePayload(fixture, "rate_limit"))).toMatchObject({
      status: "rate_limited",
      selected: null,
    });
  });
});

describe("official macro and application-owned model contracts", () => {
  test("retains valid macro rows, marks partial BLS, and preserves FRED revisions", async () => {
    const fixture = await loadProviderFixture("official-macro.json");
    const context = await new MacroContextClient({
      env: {
        FRED_API_KEY: "a".repeat(32),
        BEA_USER_ID: "b".repeat(36),
      },
      now: () => now,
      maxRetries: 0,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "api.fiscaldata.treasury.gov")
          return Response.json(fixturePayload(fixture, "treasury_malformed"));
        if (url.hostname === "api.bls.gov")
          return Response.json(fixturePayload(fixture, "bls_partial"));
        if (url.hostname === "api.stlouisfed.org")
          return Response.json(fixturePayload(fixture, "fred_revisions"));
        return Response.json(fixturePayload(fixture, "bea_malformed"));
      },
    }).context();

    expect(context.coverage).toMatchObject({
      treasury: { status: "partial", indicators: 3 },
      bls: { status: "partial", indicators: 1 },
      fred: { status: "available", indicators: 3 },
      bea: { status: "unavailable", indicators: 0 },
    });
    expect(context.indicators.some((item) => item.period.includes("Annual"))).toBe(
      false,
    );
    expect(
      context.indicators
        .filter((item) => item.provider === "fred")
        .every((item) => item.value === 3.65),
    ).toBe(true);
    const fredSource = context.sources.find(
      (source) => source.id === "macro:fred:DFF",
    );
    expect(fredSource?.data).toMatchObject({ revisionCount: 1 });
    expect(context.warnings.join(" ")).toContain("only part");
  });

  test("isolates one throttled macro provider from independent partial data", async () => {
    const fixture = await loadProviderFixture("official-macro.json");
    const throttle = fixturePayload<TransportFixture>(fixture, "rate_limit");
    const context = await new MacroContextClient({
      env: {},
      now: () => now,
      maxRetries: 0,
      fetchImpl: async (input) =>
        String(input).includes("fiscaldata.treasury.gov")
          ? responseFromTransport(throttle)
          : Response.json(fixturePayload(fixture, "bls_partial")),
    }).context();
    expect(context.coverage.treasury.status).toBe("unavailable");
    expect(context.coverage.bls).toMatchObject({
      status: "partial",
      indicators: 1,
    });
  });

  test("rejects incomplete or unsafe OpenAI structured outputs without a model call", async () => {
    const fixture = await loadProviderFixture("openai.json");
    expect(
      CompanyResearchOutput.safeParse(
        fixturePayload(fixture, "company_research_partial"),
      ).success,
    ).toBe(false);
    expect(
      validPortfolioQuestionOutput(
        fixturePayload(fixture, "portfolio_answer_malformed"),
        new Set(["fixture:market"]),
      ),
    ).toBe(false);
    expect(
      fixturePayload<TransportFixture>(fixture, "transport_rate_limit").status,
    ).toBe(429);
  });
});
