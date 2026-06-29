import { expect, test } from "bun:test";
import { extractSec8KItems, extractSecFilingSections, SecEdgarClient, validateSecUserAgent } from "./sec-edgar";

const paragraph = (label: string, count = 40) => Array.from({ length: count }, (_, index) => `${label} evidence sentence ${index + 1} describes operations, uncertainty, liquidity, competition and possible adverse outcomes.`).join(" ");

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
  expect(evidence.limitations).toEqual([]);
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
  });
  expect(result.alerts[0]?.relevanceSummary).toContain("Quarterly results were released");
  expect(result.alerts[0]?.relevanceSummary).not.toContain(": .");
  expect(result.limitations).toEqual([]);
});
