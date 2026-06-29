import { expect, test } from "bun:test";
import { MacroContextClient, describeMacroRegime, type MacroIndicator } from "./macro-context";

const treasuryPayload = {
  data: [
    { record_date: "2026-06-25", debt_held_public_amt: "31594497290975.03", intragov_hold_amt: "7716525439187.41", tot_pub_debt_out_amt: "39311022730162.44" },
    { record_date: "2026-06-24", debt_held_public_amt: "31606937181849.92", intragov_hold_amt: "7713571561250.48", tot_pub_debt_out_amt: "39320508743100.40" },
  ],
};

const blsPayload = {
  status: "REQUEST_SUCCEEDED",
  message: [],
  Results: { series: [
    { seriesID: "CUUR0000SA0", data: [
      { year: "2026", period: "M05", periodName: "May", value: "335.123" },
      { year: "2025", period: "M05", periodName: "May", value: "321.465" },
    ] },
    { seriesID: "LNS14000000", data: [
      { year: "2026", period: "M05", periodName: "May", value: "4.3" },
      { year: "2026", period: "M04", periodName: "April", value: "4.2" },
    ] },
  ] },
};

function publicFetch(counter?: { value: number }) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    if (counter) counter.value++;
    const url = String(input);
    if (url.includes("fiscaldata.treasury.gov")) return Response.json(treasuryPayload);
    if (url.includes("bls.gov")) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ startyear: "2024", endyear: "2026" });
      return Response.json(blsPayload);
    }
    throw new Error(`Unexpected URL ${url}`);
  };
}

test("macro context keeps public providers available and explains key-gated gaps", async () => {
  const calls = { value: 0 };
  const client = new MacroContextClient({ fetchImpl: publicFetch(calls), env: {}, now: () => Date.UTC(2026, 5, 29), sleep: async () => {} });
  const context = await client.context();
  expect(context.coverage).toEqual({
    fred: { status: "missing_key", indicators: 0 },
    treasury: { status: "available", indicators: 3 },
    bls: { status: "available", indicators: 2 },
    bea: { status: "missing_key", indicators: 0 },
  });
  expect(context.indicators.find(item => item.id === "cpi_all_items_yoy")).toMatchObject({ value: 4.2487, provider: "bls", calculation: expect.any(String) });
  expect(context.indicators.find(item => item.id === "unemployment_rate")).toMatchObject({ value: 4.3, previousValue: 4.2, change: 0.1 });
  expect(context.sources).toHaveLength(3);
  expect(context.sources.every(source => source.authority === "official" && source.category === "macro" && source.contentHash.startsWith("sha256:"))).toBe(true);
  expect(context.regime.dimensions.map(item => item.id)).toEqual(["inflation", "labor", "fiscal"]);
  expect(context.warnings).toEqual(expect.arrayContaining([expect.stringContaining("FRED_API_KEY"), expect.stringContaining("BEA_USER_ID")]));
  expect(context.disclosures[0]?.text).toContain("not endorsed or certified");
  await client.context();
  expect(calls.value).toBe(2);
});

test("macro context normalizes configured FRED and BEA observations", async () => {
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.fiscaldata.treasury.gov") return Response.json(treasuryPayload);
    if (url.hostname === "api.bls.gov") return Response.json(blsPayload);
    if (url.hostname === "api.stlouisfed.org") {
      expect(url.searchParams.get("api_key")).toBe("a".repeat(32));
      const values: Record<string, Array<{ date: string; value: string }>> = {
        DFF: [{ date: "2026-06-26", value: "3.64" }, { date: "2026-06-25", value: "3.65" }],
        DGS10: [{ date: "2026-06-26", value: "4.28" }, { date: "2026-06-25", value: "4.31" }],
        T10Y2Y: [{ date: "2026-06-26", value: "0.52" }, { date: "2026-06-25", value: "0.50" }],
      };
      return Response.json({ observations: values[url.searchParams.get("series_id")!] });
    }
    if (url.hostname === "apps.bea.gov") {
      expect(url.searchParams.get("UserID")).toBe("b".repeat(36));
      return Response.json({ BEAAPI: { Results: { Data: [
        { LineNumber: "1", LineDescription: "Gross domestic product", TimePeriod: "2026Q1", DataValue: "2.8", CL_UNIT: "Percent change" },
        { LineNumber: "1", LineDescription: "Gross domestic product", TimePeriod: "2025Q4", DataValue: "1.9", CL_UNIT: "Percent change" },
      ] } } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const context = await new MacroContextClient({ fetchImpl, env: { FRED_API_KEY: "a".repeat(32), BEA_USER_ID: "b".repeat(36) }, now: () => Date.UTC(2026, 5, 29), sleep: async () => {} }).context();
  expect(context.indicators).toHaveLength(9);
  expect(context.coverage.fred).toEqual({ status: "available", indicators: 3 });
  expect(context.coverage.bea).toEqual({ status: "available", indicators: 1 });
  expect(context.indicators.find(item => item.id === "real_gdp_qoq_annualized")).toMatchObject({ value: 2.8, previousValue: 1.9, period: "2026Q1" });
  expect(context.regime.dimensions.map(item => item.id)).toEqual(["rates", "inflation", "labor", "growth", "fiscal"]);
  expect(context.sources.find(source => source.provider === "fred")?.url).not.toContain("api_key");
  expect(context.sources.find(source => source.provider === "bea")?.url).not.toContain("UserID");
});

test("macro context preserves successful providers when one source fails", async () => {
  const fetchImpl = async (input: string | URL | Request) => String(input).includes("treasury.gov") ? Response.json(treasuryPayload) : new Response("unavailable", { status: 503 });
  const context = await new MacroContextClient({ fetchImpl, env: {}, now: () => Date.UTC(2026, 5, 29), maxRetries: 0 }).context();
  expect(context.coverage.treasury.status).toBe("available");
  expect(context.coverage.bls.status).toBe("unavailable");
  expect(context.indicators).toHaveLength(3);
  expect(context.regime.dimensions.map(item => item.id)).toEqual(["fiscal"]);
  expect(context.warnings).toContain("BLS is temporarily unavailable.");
});

test("macro regime descriptions cite only the observations they use", () => {
  const indicators: MacroIndicator[] = [
    { id: "effective_federal_funds_rate", label: "Fed funds", value: 4.5, unit: "%", period: "2026-01-01", provider: "fred", evidenceId: "fred-rate" },
    { id: "unemployment_rate", label: "Unemployment", value: 5.2, previousValue: 5, change: .2, unit: "%", period: "May 2026", provider: "bls", evidenceId: "bls-labor" },
  ];
  const regime = describeMacroRegime(indicators);
  expect(regime.summary).toContain("Rates: elevated rates");
  expect(regime.summary).toContain("Labor: soft labor market");
  expect(regime.evidence).toEqual(["fred-rate", "bls-labor"]);
});
