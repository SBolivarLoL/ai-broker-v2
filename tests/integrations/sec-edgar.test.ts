import { expect, test } from "bun:test";
import { extractSec8KItems, extractSecFilingSections, SecEdgarClient, validateSecUserAgent } from "../../backend/integrations/sec-edgar";
import { getCompanySecEvidence } from "../../backend/features/research/research";

const paragraph = (label: string, count = 40) => Array.from({ length: count }, (_, index) => `${label} evidence sentence ${index + 1} describes operations, uncertainty, liquidity, competition and possible adverse outcomes.`).join(" ");

const providerTime = (retrievedAt: string, serverRespondedAt = retrievedAt) => ({
  retrievedAt,
  serverRespondedAt,
  time: {
    observationTime: null,
    publicationTime: null,
    effectivePeriod: null,
    retrievalTime: retrievedAt,
    serverResponseTime: serverRespondedAt,
  },
  asOf: serverRespondedAt,
});

const filingTime = (filed: string, reportDate: string, retrievedAt: string, serverRespondedAt = retrievedAt) => ({
  publishedAt: `${filed}T00:00:00.000Z`,
  effectivePeriod: {
    start: `${reportDate}T00:00:00.000Z`,
    end: `${reportDate}T00:00:00.000Z`,
    label: "SEC report date",
  },
  retrievedAt,
  serverRespondedAt,
  time: {
    observationTime: null,
    publicationTime: `${filed}T00:00:00.000Z`,
    effectivePeriod: {
      start: `${reportDate}T00:00:00.000Z`,
      end: `${reportDate}T00:00:00.000Z`,
      label: "SEC report date",
    },
    retrievalTime: retrievedAt,
    serverResponseTime: serverRespondedAt,
  },
  asOf: serverRespondedAt,
});

test("extracts bounded 10-K sections instead of table of contents labels", async () => {
  const html = `<html><body>
    <div>Table of contents Item 1A. Risk Factors Item 1B. Unresolved Staff Comments Item 7. Management's Discussion and Analysis Item 7A. Quantitative Disclosures</div>
    <h2>Item 1A.&#160;&#160;Risk Factors</h2><p>${paragraph("Annual risk")}</p><h2>Item 1B.&#160;Unresolved Staff Comments</h2>
    <h2>Item 7.&#160;Management&#8217;s Discussion and Analysis</h2><p>${paragraph("Annual MD&A")}</p><h2>Item 7A.&#160;Quantitative and Qualitative Disclosures</h2>
  </body></html>`;
  const sections = await extractSecFilingSections(html, "10-K", 1_200);
  expect(sections).toHaveLength(2);
  expect(sections.find(section => section.kind === "risk_factors")).toMatchObject({ locator: "Item 1A", truncated: true });
  expect(sections.find(section => section.kind === "management_discussion")?.text).toContain("Annual MD&A evidence sentence");
  expect(sections.every(section => section.contentHash.startsWith("sha256:"))).toBe(true);
});

test("extracts 10-Q management discussion and risk factors", async () => {
  const html = `<html><body>
    <h2>Part I Item 2. Management's Discussion and Analysis</h2><p>${paragraph("Quarterly MD&A", 12)}</p><h2>Part I Item 3. Quantitative and Qualitative Disclosures</h2>
    <h2>Part II Item 1A. Risk Factors</h2><p>${paragraph("Quarterly risk", 12)}</p><h2>Part II Item 2. Unregistered Sales</h2>
  </body></html>`;
  const sections = await extractSecFilingSections(html, "10-Q", 4_000);
  expect(sections.map(section => section.kind)).toEqual(["management_discussion", "risk_factors"]);
  expect(sections.find(section => section.kind === "risk_factors")?.locator).toBe("Part II, Item 1A");
});

test("SEC client requires a declared contact and retries transient responses with caching", async () => {
  expect(() => validateSecUserAgent("ai-broker-v2 your-email@example.com")).toThrow("real contact email");
  expect(validateSecUserAgent("AI Broker research ops@broker.test")).toBe("AI Broker research ops@broker.test");

  let calls = 0, now = 0;
  const delays: number[] = [];
  const client = new SecEdgarClient({
    userAgent: "AI Broker research ops@broker.test",
    minIntervalMs: 100,
    maxRetries: 1,
    now: () => now,
    sleep: async ms => { delays.push(ms); now += ms; },
    fetchImpl: async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).get("user-agent")).toBe("AI Broker research ops@broker.test");
      if (calls === 1) return new Response("busy", { status: 429 });
      return Response.json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }, { headers: { etag: "ticker-v1" } });
    },
  });

  const first = await client.company("AAPL");
  const cached = await client.company("AAPL");
  expect(first).toMatchObject({ cik: "0000320193", cikNumber: "320193", title: "Apple Inc." });
  expect(cached).toEqual(first);
  expect(calls).toBe(2);
  expect(delays).toContain(250);
});

test("reads official SIC classification from SEC submissions", async () => {
  const now = Date.parse("2026-06-29T12:00:00.000Z");
  const client = new SecEdgarClient({
    userAgent: "AI Broker research ops@broker.test",
    minIntervalMs: 100,
    now: () => now,
    sleep: async () => {},
    fetchImpl: async input => String(input).endsWith("company_tickers.json")
      ? Response.json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } })
      : Response.json({ name: "Apple Inc.", sic: "3571", sicDescription: "Electronic Computers", filings: { recent: { accessionNumber: [], filingDate: [], reportDate: [], form: [], primaryDocument: [] } } }),
  });
  const at = "2026-06-29T12:00:00.000Z";
  expect(await client.companyClassification("AAPL")).toEqual({ symbol: "AAPL", companyName: "Apple Inc.", cik: "0000320193", sic: "3571", industry: "Electronic Computers", sourceUrl: "https://data.sec.gov/submissions/CIK0000320193.json", ...providerTime(at) });
});

test("SEC cache preserves provider retrieval while normalized responses refresh server time", async () => {
  let now = Date.parse("2026-06-29T12:00:00.000Z");
  let calls = 0;
  const client = new SecEdgarClient({
    userAgent: "AI Broker research ops@broker.test",
    minIntervalMs: 100,
    now: () => now,
    sleep: async ms => { now += ms; },
    fetchImpl: async input => {
      calls++;
      return String(input).endsWith("company_tickers.json")
        ? Response.json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } })
        : Response.json({ name: "Apple Inc.", sic: "3571", sicDescription: "Electronic Computers", filings: { recent: { accessionNumber: [], filingDate: [], reportDate: [], form: [], primaryDocument: [] } } });
    },
  });

  const first = await client.companyClassification("AAPL");
  now += 60_000;
  const cached = await client.companyClassification("AAPL");
  expect(calls).toBe(2);
  expect(cached.retrievedAt).toBe(first.retrievedAt);
  expect(cached.serverRespondedAt).toBe("2026-06-29T12:01:00.100Z");
  expect(cached.asOf).toBe(cached.serverRespondedAt);
  expect(cached.time.retrievalTime).toBe(first.retrievedAt);
  expect(cached.time.serverResponseTime).toBe(cached.serverRespondedAt);
});

test("company-facts wrapper distinguishes cache hits from conditional revalidation", async () => {
  let now = Date.parse("2026-06-29T12:00:00.000Z");
  let calls = 0;
  let factsCalls = 0;
  const client = new SecEdgarClient({
    userAgent: "AI Broker research ops@broker.test",
    minIntervalMs: 100,
    now: () => now,
    sleep: async ms => { now += ms; },
    fetchImpl: async (input, init) => {
      calls++;
      if (String(input).endsWith("company_tickers.json")) return Response.json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
      factsCalls++;
      if (factsCalls === 2) {
        expect(new Headers(init?.headers).get("if-none-match")).toBe("facts-v1");
        return new Response(null, { status: 304 });
      }
      return Response.json({ entityName: "Apple Inc.", facts: {} }, { headers: { etag: "facts-v1" } });
    },
  });

  const company = await client.company("AAPL");
  const first = await client.companyFactsResult(company);
  now += 60_000;
  const cached = await client.companyFactsResult(company);
  expect(calls).toBe(2);
  expect(first.sourceUrl).toBe("https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json");
  expect(cached.facts).toEqual(first.facts);
  expect(cached.retrievedAt).toBe(first.retrievedAt);
  expect(cached.serverRespondedAt).toBe("2026-06-29T12:01:00.100Z");
  expect(cached.time).toEqual(providerTime(first.retrievedAt, cached.serverRespondedAt).time);

  now += 5 * 60_000 + 1;
  const revalidated = await client.companyFactsResult(company);
  expect(calls).toBe(3);
  expect(revalidated.facts).toEqual(first.facts);
  expect(revalidated.retrievedAt).toBe("2026-06-29T12:06:00.101Z");
  expect(revalidated.time.retrievalTime).toBe(revalidated.retrievedAt);
});

test("builds accession-linked filing evidence from official archive paths", async () => {
  let now = Date.parse("2026-06-28T10:00:00.000Z");
  const annualHtml = `<html><body><h2>Item 1A. Risk Factors</h2><p>${paragraph("Annual risk", 12)}</p><h2>Item 1B. Unresolved Staff Comments</h2><h2>Item 7. Management's Discussion and Analysis</h2><p>${paragraph("Annual MD&A", 12)}</p><h2>Item 7A. Quantitative Disclosures</h2></body></html>`;
  const quarterHtml = `<html><body><h2>Part I Item 2. Management's Discussion and Analysis</h2><p>${paragraph("Quarter MD&A", 12)}</p><h2>Part I Item 3. Quantitative Disclosures</h2><h2>Part II Item 1A. Risk Factors</h2><p>${paragraph("Quarter risk", 12)}</p><h2>Part II Item 2. Unregistered Sales</h2></body></html>`;
  const client = new SecEdgarClient({
    userAgent: "AI Broker research ops@broker.test",
    minIntervalMs: 100,
    now: () => now,
    sleep: async ms => { now += ms; },
    fetchImpl: async input => {
      const url = String(input);
      if (url.endsWith("company_tickers.json")) return Response.json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
      if (url.includes("submissions/CIK0000320193.json")) return Response.json({
        name: "Apple Inc.",
        filings: { recent: {
          accessionNumber: ["0000320193-25-000001", "0000320193-25-000002", "0000320193-25-000003"],
          filingDate: ["2025-11-01", "2025-08-01", "2025-07-20"],
          reportDate: ["2025-09-30", "2025-06-30", "2025-07-18"],
          form: ["10-K", "10-Q", "8-K"],
          primaryDocument: ["annual.htm", "quarter.htm", "event.htm"],
        } },
      });
      if (url.endsWith("annual.htm")) return new Response(annualHtml);
      if (url.endsWith("quarter.htm")) return new Response(quarterHtml);
      throw new Error(`Unexpected fixture URL: ${url}`);
    },
  });

  const evidence = await client.filingEvidence("AAPL", 12, 1_200);
  expect(evidence.filings[0]).toMatchObject({
    accession: "0000320193-25-000001",
    url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/annual.htm",
  });
  expect(evidence.sections).toHaveLength(4);
  expect(evidence.sections[0]?.id.startsWith("sec:section:AAPL:0000320193-25-000001:")).toBe(true);
  expect(evidence.sections.every(section => section.sourceUrl.startsWith("https://www.sec.gov/Archives/edgar/data/320193/"))).toBe(true);
  expect(evidence).toMatchObject(providerTime("2026-06-28T10:00:00.300Z"));
  expect(evidence.filings[0]).toMatchObject(filingTime("2025-11-01", "2025-09-30", "2026-06-28T10:00:00.100Z", "2026-06-28T10:00:00.300Z"));
  expect(evidence.sections[0]).toMatchObject(filingTime("2025-11-01", "2025-09-30", "2026-06-28T10:00:00.200Z", "2026-06-28T10:00:00.300Z"));
  expect(evidence.limitations).toEqual([]);

  now += 60_000;
  const cached = await client.filingEvidence("AAPL", 12, 1_200);
  expect(cached.retrievedAt).toBe(evidence.retrievedAt);
  expect(cached.serverRespondedAt).toBe("2026-06-28T10:01:00.300Z");
  expect(cached.sections.map(section => section.retrievedAt)).toEqual(evidence.sections.map(section => section.retrievedAt));
  expect(cached.sections.map(section => section.contentHash)).toEqual(evidence.sections.map(section => section.contentHash));
  expect(cached.sections.every(section => section.serverRespondedAt === cached.serverRespondedAt)).toBe(true);
  expect(cached.filings.every(filing => filing.serverRespondedAt === cached.serverRespondedAt)).toBe(true);
});

test("SEC research projection refreshes delivery time without changing evidence hashes", async () => {
  let now = Date.parse("2026-06-28T10:00:00.000Z");
  const annualHtml = `<html><body><h2>Item 1A. Risk Factors</h2><p>${paragraph("Annual risk", 12)}</p><h2>Item 1B. Unresolved Staff Comments</h2><h2>Item 7. Management's Discussion and Analysis</h2><p>${paragraph("Annual MD&A", 12)}</p><h2>Item 7A. Quantitative Disclosures</h2></body></html>`;
  const quarterHtml = `<html><body><h2>Part I Item 2. Management's Discussion and Analysis</h2><p>${paragraph("Quarter MD&A", 12)}</p><h2>Part I Item 3. Quantitative Disclosures</h2><h2>Part II Item 1A. Risk Factors</h2><p>${paragraph("Quarter risk", 12)}</p><h2>Part II Item 2. Unregistered Sales</h2></body></html>`;
  const client = new SecEdgarClient({
    userAgent: "AI Broker research ops@broker.test",
    minIntervalMs: 100,
    now: () => now,
    sleep: async ms => { now += ms; },
    fetchImpl: async input => {
      const url = String(input);
      if (url.endsWith("company_tickers.json")) return Response.json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
      if (url.includes("submissions/CIK0000320193.json")) return Response.json({
        name: "Apple Inc.",
        filings: { recent: {
          accessionNumber: ["0000320193-25-000001", "0000320193-25-000002"],
          filingDate: ["2025-11-01", "2025-08-01"],
          reportDate: ["2025-09-30", "2025-06-30"],
          form: ["10-K", "10-Q"],
          primaryDocument: ["annual.htm", "quarter.htm"],
        } },
      });
      if (url.endsWith("annual.htm")) return new Response(annualHtml);
      if (url.endsWith("quarter.htm")) return new Response(quarterHtml);
      if (url.includes("companyfacts/CIK0000320193.json")) return Response.json({ entityName: "Apple Inc.", facts: { "us-gaap": { Revenues: { label: "Revenue", units: { USD: [{ val: 100, start: "2024-10-01", end: "2025-09-30", filed: "2025-11-01", form: "10-K", fy: 2025, fp: "FY", accn: "0000320193-25-000001" }] } } } } });
      throw new Error(`Unexpected fixture URL: ${url}`);
    },
  });

  const first = await getCompanySecEvidence("AAPL", client, () => new Date(now));
  now += 60_000;
  const cached = await getCompanySecEvidence("AAPL", client, () => new Date(now));
  expect(cached.retrievedAt).toBe(first.retrievedAt);
  expect(cached.serverRespondedAt).not.toBe(first.serverRespondedAt);
  expect(cached.sources.map(source => source.retrievedAt)).toEqual(first.sources.map(source => source.retrievedAt));
  expect(cached.sources.map(source => source.contentHash)).toEqual(first.sources.map(source => source.contentHash));
  expect(cached.sources.every(source => source.serverRespondedAt === cached.serverRespondedAt)).toBe(true);
  expect(cached.sources.every(source => source.observedAt === null)).toBe(true);
  expect(cached.sources.find(source => source.id === "sec:filings:AAPL")).toMatchObject({
    publishedAt: "2025-11-01T00:00:00.000Z",
    effectivePeriod: {
      start: "2025-06-30T00:00:00.000Z",
      end: "2025-09-30T00:00:00.000Z",
    },
  });
  expect(cached.sources.find(source => source.id === "sec:facts:AAPL")).toMatchObject({
    publishedAt: "2025-11-01T00:00:00.000Z",
    effectivePeriod: {
      start: "2025-09-30T00:00:00.000Z",
      end: "2025-09-30T00:00:00.000Z",
    },
  });
  expect(
    cached.sources
      .filter(source => source.id.startsWith("sec:section:"))
      .every(source => source.publishedAt && source.effectivePeriod),
  ).toBe(true);
});

test("extracts material 8-K items instead of table-of-contents entries", async () => {
  const html = `<html><body>
    <p>Item 1.05 Material Cybersecurity Incidents</p><p>Item 7.01 Regulation FD Disclosure</p><p>Item 9.01 Financial Statements and Exhibits</p>
    <h2>Item 1.05. Material Cybersecurity Incidents</h2><p>${paragraph("The company identified a material cybersecurity incident", 10)}</p>
    <h2>Item 7.01. Regulation FD Disclosure</h2><p>${paragraph("The company furnished an investor update", 8)}</p>
    <h2>Item 9.01. Financial Statements and Exhibits</h2><p>${paragraph("Exhibit 99.1 is furnished herewith", 5)}</p>
  </body></html>`;
  const items = await extractSec8KItems(html, 600);
  expect(items.map(item => item.code)).toEqual(["1.05", "7.01", "9.01"]);
  expect(items[0]).toMatchObject({ importance: "critical", truncated: true });
  expect(items[0]?.text.startsWith("The company identified")).toBe(true);
  expect(items[0]?.contentHash.startsWith("sha256:")).toBe(true);
});

test("builds bounded accession-linked 8-K alerts with deterministic relevance", async () => {
  const now = Date.parse("2026-06-29T12:00:00.000Z");
  const client = new SecEdgarClient({
    userAgent: "AI Broker research ops@broker.test",
    now: () => now,
    sleep: async () => {},
    minIntervalMs: 100,
    fetchImpl: async input => {
      const url = String(input);
      if (url.endsWith("company_tickers.json")) return Response.json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
      if (url.includes("submissions/CIK0000320193.json")) return Response.json({ name: "Apple Inc.", filings: { recent: {
        accessionNumber: ["0000320193-26-000020", "0000320193-26-000019"],
        filingDate: ["2026-06-28", "2026-05-01"], reportDate: ["2026-06-27", "2026-05-01"],
        form: ["8-K", "8-K"], primaryDocument: ["event.htm", "old.htm"],
      } } });
      if (url.endsWith("event.htm")) return new Response(`<html><body><h2>Item 2.02 Results of Operations and Financial Condition</h2><p>${paragraph("Quarterly results were released", 10)}</p><h2>Item 9.01 Financial Statements and Exhibits</h2><p>Exhibit 99.1.</p></body></html>`);
      throw new Error(`Unexpected fixture URL: ${url}`);
    },
  });
  const result = await client.recent8KAlerts("AAPL", 14, 3, 500);
  expect(result.alerts).toHaveLength(1);
  expect(result.alerts[0]).toMatchObject({
    id: "sec:8k:AAPL:0000320193-26-000020",
    importance: "standard",
    primaryItem: { code: "2.02", label: "Results of Operations and Financial Condition" },
    sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/event.htm",
    indexUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/0000320193-26-000020-index.html",
    ...filingTime("2026-06-28", "2026-06-27", "2026-06-29T12:00:00.000Z"),
  });
  expect(result).toMatchObject(providerTime("2026-06-29T12:00:00.000Z"));
  expect(result.alerts[0]?.relevanceSummary).toContain("Quarterly results were released");
  expect(result.alerts[0]?.relevanceSummary).not.toContain(": .");
  expect(result.limitations).toEqual([]);
});
