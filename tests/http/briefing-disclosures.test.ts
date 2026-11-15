import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createApp } from "../../backend/app";
import { createStore } from "../../backend/persistence/store";
import { SecEdgarClient } from "../../backend/integrations/sec-edgar";

const accession = "0001104659-26-126785";
const accepted = "2026-11-13T17:00:19.000Z";
const captured = "2026-11-16T14:22:00.000Z";
const afterSession = "2026-11-17T22:00:00.000Z";
const assertNoBrokerOrder = () => { throw new Error("Broker order must never be called"); };
const item = (issuer: string, cusip: string, value: number, option = "") =>
  `<ns1:infoTable><ns1:nameOfIssuer>${issuer}</ns1:nameOfIssuer><ns1:titleOfClass>COM</ns1:titleOfClass>
    <ns1:cusip>${cusip}</ns1:cusip><ns1:value>${value}</ns1:value>
    <ns1:shrsOrPrnAmt><ns1:sshPrnamt>2</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>
    ${option}</ns1:infoTable>`;
const holdings = `<ns1:informationTable xmlns:ns1="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  ${item("TESLA INC", "88160R101", 100)}
  ${item("TESLA INC", "88160R101", 70)}
  ${item("APPLE INC", "037833100", 150)}
  ${item("APPLE INC", "037833100", 9000, "<ns1:putCall>Call</ns1:putCall>")}
  </ns1:informationTable>`;

function fakeAlpaca(getStockBarsFor?: (symbol: string, query: any) => Promise<unknown[]>) {
  return {
    marketData: {
      stockStream: () => ({
        send() {}, connect() {}, onStateChange() {}, onConnect() {}, onDisconnect() {},
        onError() {}, onQuote() {}, onBar() {},
      }),
      getStockBarsFor, news: { news: async () => ({
      news: [
        { id: 1, symbols: ["TSLA"], createdAt: "2026-11-16T13:00:00Z", source: "Issuer", headline: "A holding published an update", url: "https://news.example/update" },
        { id: 2, symbols: ["TSLA"], createdAt: "2026-11-16T15:00:00Z", source: "Issuer", headline: "Future event", url: "https://news.example/future" },
        { id: 3, symbols: ["OTHER"], createdAt: "2026-11-16T13:00:00Z", headline: "Unrelated event", url: "https://news.example/other" },
      ],
    }) } },
    trading: {
      account: { getAccount: async () => ({ equity: "1020", lastEquity: "1000", currency: "USD" }) },
      positions: { getAllOpenPositions: async () => [
        { symbol: "AAPL", qty: "1", unrealizedIntradayPl: "5" },
        { symbol: "TSLA", qty: "1", unrealizedIntradayPl: "-17" },
        { symbol: "KO", qty: "1", unrealizedIntradayPl: "" },
      ] },
      calendar: { calendar: async () => ({ calendar: [
        { coreStart: new Date("2026-11-16T14:30:00Z"), coreEnd: new Date("2026-11-16T21:00:00Z") },
        { coreStart: new Date("2026-11-17T14:30:00Z"), coreEnd: new Date("2026-11-17T18:00:00Z") },
        { coreStart: new Date("2026-11-18T14:30:00Z"), coreEnd: new Date("2026-11-18T21:00:00Z") },
      ] }) },
      orders: { placeOrder: assertNoBrokerOrder, placeMarketOrder: assertNoBrokerOrder },
    },
  } as unknown as Alpaca;
}

test("Overview briefing keeps position P&L, equity change and sourced headlines distinct", async () => {
  const store = createStore(":memory:");
  try {
    const app = createApp({
      alpaca: fakeAlpaca(), store, codeIdentity: { gitCommit: "a".repeat(40), workingTreeDirty: false },
      env: { NODE_ENV: "test" }, now: () => new Date(captured),
    });
    const response = await app.fetch(new Request("http://localhost/api/portfolio/briefing"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "paper", equityChange: 20, equityChangePercent: 2,
      contributors: [{ symbol: "TSLA", pnl: -17 }, { symbol: "AAPL", pnl: 5 }],
      coverage: { positions: 3, withIntradayPnl: 2, checkedForNews: 3 },
      developments: [{ symbols: ["TSLA"], source: "Issuer", url: "https://news.example/update" }],
    });
  } finally { store.close(); }
});

test("SEC feed and forward paper test preserve receipt and exact regular-session IEX prices", async () => {
  const store = createStore(":memory:");
  let clock = new Date(captured);
  let missingExit = false;
  let barRequests = 0;
  let tableRequests = 0;
  const sec = new SecEdgarClient({
    userAgent: "Paper disclosure test ci@invalid.test",
    now: () => clock.getTime(), sleep: async () => {}, maxRetries: 0,
    fetchImpl: (async (url: string) => {
      if (url.endsWith("CIK0001067983.json")) return new Response(null, { status: 503 });
      if (url.endsWith("CIK0001697748.json")) return Response.json({
        name: "ARK Investment Management",
        filings: { recent: {
          accessionNumber: [accession, "0001104659-26-999999"],
          filingDate: ["2026-11-13", "2026-11-16"],
          reportDate: ["2026-09-30", "2026-09-30"],
          form: ["13F-HR", "13F-HR/A"],
          acceptanceDateTime: [accepted, "2026-11-22T14:00:00.000Z"],
          primaryDocument: ["xslForm13F_X02/primary_doc.xml", "primary_doc.xml"],
        } },
      });
      if (url.endsWith("/index.json")) return Response.json({
        directory: { item: [{ name: "primary_doc.xml" }, { name: "infotable.xml" }] },
      });
      if (url.endsWith("/infotable.xml")) {
        tableRequests++;
        return new Response(holdings);
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch,
  });
  const alpaca = fakeAlpaca(async (symbol, query) => {
    barRequests++;
    expect(query.feed).toBe("iex");
    expect(query.start.toISOString()).toBe("2026-11-17T14:30:00.000Z");
    expect(query.end.toISOString()).toBe("2026-11-17T18:00:00.000Z");
    return [
      { timestamp: new Date("2026-11-17T14:29:00Z"), open: 1, close: 1 },
      { timestamp: new Date("2026-11-17T14:30:00Z"), open: 100, close: 101 },
      ...missingExit ? [] : [{ timestamp: new Date("2026-11-17T17:59:00Z"), open: 103, close: symbol === "TSLA" ? 110 : 104 }],
      { timestamp: new Date("2026-11-17T18:00:00Z"), open: 1000, close: 1000 },
    ];
  });
  const app = createApp({
    alpaca, store, codeIdentity: { gitCommit: "a".repeat(40), workingTreeDirty: false },
    env: { NODE_ENV: "test" }, now: () => clock, disclosureSource: () => sec,
  });
  const base = "/api/research/disclosures";
  const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));
  const submit = (body: unknown) => app.fetch(new Request(`http://localhost${base}/paper`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const evaluate = async () => (await get(`${base}/paper?accession=${accession}`)).json();
  try {
    const feed = await (await get(base)).json();
    expect(feed.sources).toMatchObject([
      { name: "Berkshire Hathaway", status: "unavailable", records: [] },
      { name: "ARK Investment Management", status: "available", records: [{ accession, canStartPaper: true }] },
    ]);
    expect((await submit(null)).status).toBe(400);
    expect((await submit({ accession: "0001104659-26-999999" })).status).toBe(409);
    expect((await get(`${base}/paper?accession=${accession}`)).status).toBe(404);
    const started = await submit({ accession, symbol: "UNTRUSTED", recordedAt: "2026-01-01" });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({
      created: true, trial: { accession, symbol: "TSLA", recordedAt: captured, acceptedAt: accepted, reportedValueUsd: 170 },
    });
    expect(store.getDisclosurePaperTrial("different-user", accession)).toBeNull();
    expect(tableRequests).toBe(1);
    expect(await evaluate()).toMatchObject({ status: "pending", session: { close: "2026-11-17T18:00:00.000Z" } });
    expect(barRequests).toBe(0);
    clock = new Date(afterSession);
    expect(await (await submit({ accession })).json()).toMatchObject({ created: false, trial: { recordedAt: captured } });
    const result = await evaluate();
    expect(result).toMatchObject({ mode: "paper", status: "complete", feed: "IEX", candidate: { entry: 100, exit: 110 }, benchmark: { entry: 100, exit: 104 } });
    expect(result.excessPercentagePoints).toBeCloseTo(5.994, 3);
    expect(barRequests).toBe(2);
    missingExit = true;
    expect(await evaluate()).toMatchObject({ status: "unavailable", reason: expect.stringContaining("first or last") });
  } finally { store.close(); }
});
