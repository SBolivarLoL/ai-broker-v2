import { TimeFrame, type Alpaca } from "@alpacahq/alpaca-ts-alpha";
import type { SecEdgarClient } from "../../integrations/sec-edgar";

export type DisclosureSource = Pick<SecEdgarClient, "institutionalDisclosures" | "institutionalHoldings">;
const filers = [
  { cik: "0001067983", name: "Berkshire Hathaway" },
  { cik: "0001697748", name: "ARK Investment Management" },
] as const;
const sevenDays = 7 * 86_400_000;
const minute = 60_000;
const cutoffDelay = 15 * minute;
const costPerSide = 0.0005;

// A deliberately small, fixed US common-stock universe. Identity is by CUSIP
// and issuer name from the filing, never by a ticker guess from the issuer text.
const universe = new Map([
  ["037833100", { symbol: "AAPL", issuer: "APPLE INC" }],
  ["025816109", { symbol: "AXP", issuer: "AMERICAN EXPRESS CO" }],
  ["191216100", { symbol: "KO", issuer: "COCA COLA CO" }],
  ["594918104", { symbol: "MSFT", issuer: "MICROSOFT CORP" }],
  ["88160R101", { symbol: "TSLA", issuer: "TESLA INC" }],
]);
export const disclosurePaperRule = {
  version: "13f-largest-eligible-v1",
  symbols: [...universe.values()].map(({ symbol }) => symbol).sort(),
  benchmark: "SPY",
  totalEstimatedCostBps: 10,
};

export async function disclosureFeed(source: DisclosureSource, now: () => Date) {
  const requests = await Promise.allSettled(filers.map(filer =>
    source.institutionalDisclosures(filer.cik),
  ));
  const nowMs = now().getTime();
  const sources = filers.map((filer, index) => {
    const result = requests[index]!;
    if (result.status === "rejected")
      return { ...filer, status: "unavailable" as const, checkedAt: null, records: [] };
    const { checkedAt, records } = result.value;
    const visible = records.filter(record =>
      record.filingDate <= checkedAt.slice(0, 10) &&
      (!record.acceptedAt || Date.parse(record.acceptedAt) <= Date.parse(checkedAt)),
    ).sort((a, b) => b.filingDate.localeCompare(a.filingDate) ||
      (b.acceptedAt ?? "").localeCompare(a.acceptedAt ?? "") ||
      b.accession.localeCompare(a.accession));
    const latest = visible[0];
    const usable = Date.parse(checkedAt) <= nowMs && latest?.form === "13F-HR" &&
      latest.reportDate !== null && latest.acceptedAt !== null &&
      nowMs - Date.parse(latest.acceptedAt) <= sevenDays &&
      !visible.some(record => record.form.endsWith("/A") &&
        record.reportDate === latest.reportDate);
    return {
      ...filer, status: "available" as const, checkedAt,
      records: visible.slice(0, 4).map(record => ({
        ...record, filer: filer.name, canStartPaper: Boolean(usable && record === latest),
      })),
    };
  });
  return { mode: "paper" as const, sources, rule: disclosurePaperRule };
}

function safePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export async function largestEligibleHolding(xml: string) {
  // Only the named SEC tags are used. Some EDGAR tables prefix them with ns1.
  const unprefixed = xml.replace(/(<\/?)[\w.-]+:([\w.-]+)(?=[\s>/])/g, "$1$2");
  const totals = new Map<string, number>();
  let recognized = false;
  let row: Record<string, string> | null = null;
  let invalid = false;
  const rewriter = new HTMLRewriter().on("informationtable", {
    element() { recognized = true; },
  }).on("informationtable infotable", {
    element(element) {
      if (row) invalid = true;
      row = {};
      element.onEndTag(() => {
        const values = row;
        row = null;
        if (!values) return;
        const target = universe.get(values.cusip?.trim() ?? "");
        if (!target || Object.hasOwn(values, "putcall")) return;
        const value = safePositiveInteger(values.value?.trim());
        const issuer = values.nameofissuer?.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
        if (issuer !== target.issuer || values.sshprnamttype?.trim() !== "SH" || value === null ||
          safePositiveInteger(values.sshprnamt?.trim()) === null || !values.titleofclass?.trim()) {
          invalid = true;
          return;
        }
        const combined = (totals.get(target.symbol) ?? 0) + value;
        if (Number.isSafeInteger(combined)) totals.set(target.symbol, combined);
        else invalid = true;
      });
    },
  });
  for (const key of ["nameofissuer", "titleofclass", "cusip", "value", "sshprnamt", "sshprnamttype", "putcall"]) {
    rewriter.on(`informationtable infotable ${key}`, {
      element() {
        if (!row) return;
        if (Object.hasOwn(row, key)) invalid = true;
        row[key] = "";
      },
      text(chunk) {
        if (row) row[key] = (row[key] ?? "") + chunk.text;
      },
    });
  }
  await rewriter.transform(new Response(unprefixed)).arrayBuffer();
  if (!recognized || row || invalid) throw new Error("SEC holdings evidence is incomplete or ambiguous");
  const candidate = [...totals].sort(([a, sizeA], [b, sizeB]) => sizeB - sizeA || a.localeCompare(b))[0];
  return candidate ? { symbol: candidate[0], reportedValueUsd: candidate[1] } : null;
}

export type DisclosurePaperTrial = {
  accession: string;
  filer: string;
  reportDate: string;
  acceptedAt: string;
  recordedAt: string;
  filingUrl: string;
  tableUrl: string;
  tableHash: string;
  symbol: string;
  reportedValueUsd: number;
  rule: typeof disclosurePaperRule;
};

export async function evaluateDisclosurePaperTrial(
  trial: DisclosurePaperTrial,
  alpaca: Alpaca,
  now: Date,
) {
  const recorded = Date.parse(trial.recordedAt);
  const earliest = recorded + cutoffDelay;
  const observationEnd = recorded + sevenDays;
  const base = { mode: "paper" as const, trial, feed: "IEX" as const };
  if (!Number.isFinite(earliest) || !Number.isFinite(Date.parse(trial.acceptedAt)) ||
    Date.parse(trial.acceptedAt) > recorded || recorded > now.getTime())
    return { ...base, status: "unavailable" as const, reason: "Receipt or filing time is invalid." };
  try {
    const calendar = await alpaca.trading.calendar.calendar({
      market: "NASDAQ",
      start: new Date(recorded - 86_400_000),
      end: new Date(observationEnd),
    });
    const session = calendar.calendar
      .map(row => ({ open: new Date(row.coreStart).getTime(), close: new Date(row.coreEnd).getTime() }))
      .filter(({ open, close }) => open > earliest && close <= observationEnd && close > open + minute)
      .sort((left, right) => left.open - right.open)[0];
    if (!session)
      return { ...base, status: "unavailable" as const, reason: "No eligible core session was returned by Alpaca." };
    const { open, close } = session;
    const window = { open: new Date(open).toISOString(), close: new Date(close).toISOString() };
    if (now.getTime() < close + cutoffDelay)
      return { ...base, status: "pending" as const, session: window, reason: "Waiting for the first eligible session to close and its bars to settle." };
    const symbols = [trial.symbol, trial.rule.benchmark];
    const prices = await Promise.all(symbols.map(async symbol => {
      const bars = await alpaca.marketData.getStockBarsFor(symbol, {
        timeframe: TimeFrame.Minute, start: new Date(open), end: new Date(close),
        feed: "iex", adjustment: "raw",
      });
      const first = bars.filter(bar => new Date(bar.timestamp).getTime() === open);
      const last = bars.filter(bar => new Date(bar.timestamp).getTime() === close - minute);
      const entry = first[0]?.open;
      const exit = last[0]?.close;
      if (first.length !== 1 || last.length !== 1 || typeof entry !== "number" ||
        typeof exit !== "number" || !Number.isFinite(entry) || !Number.isFinite(exit) ||
        entry <= 0 || exit <= 0) return null;
      const net = exit * (1 - costPerSide) / (entry * (1 + costPerSide)) - 1;
      return { symbol, entry, exit, returnPercent: net * 100 };
    }));
    const [candidate, benchmark] = prices;
    if (!candidate || !benchmark)
      return { ...base, status: "unavailable" as const, session: window, reason: "IEX lacks unambiguous first or last core-minute prices for this session." };
    return {
      ...base, status: "complete" as const, session: window, candidate, benchmark,
      excessPercentagePoints: candidate.returnPercent - benchmark.returnPercent,
    };
  } catch {
    return { ...base, status: "unavailable" as const, reason: "Paper market-data inputs are temporarily unavailable." };
  }
}
