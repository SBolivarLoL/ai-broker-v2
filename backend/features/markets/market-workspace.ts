/** Pure validation and presentation helpers for market-discovery endpoints. */
import { normalizeTimeProvenance } from "../../shared/time-provenance";

type DateInput = string | number | Date;

export type MarketWorkspaceSource = {
  movers: any;
  actives: any;
  clock: any;
  retrievedAt: string;
};

export type MarketCalendarSource = {
  response: any;
  clock: any;
  retrievedAt: string;
};

const symbolPattern = /^[A-Z.]{1,10}$/;

const iso = (value: DateInput) => new Date(value).toISOString();

const optionalIso = (value: unknown) => (value ? iso(value as DateInput) : null);

const latest = (times: (string | null)[]) =>
  times
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

export function parseWatchlistInput(input: unknown) {
  const value = input as { name?: unknown; symbols?: unknown };
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 64)
    throw new Error("Watchlist name must contain 1 to 64 characters");
  if (!Array.isArray(value.symbols) || value.symbols.length > 50)
    throw new Error("Watchlist symbols must be an array of at most 50 tickers");
  const symbols = [
    ...new Set(
      value.symbols.map((symbol) => String(symbol).trim().toUpperCase()),
    ),
  ];
  if (symbols.some((symbol) => !symbolPattern.test(symbol)))
    throw new Error("Watchlist contains an invalid stock symbol");
  return { name, symbols };
}

export function parseSymbol(input: unknown) {
  const symbol = String(input ?? "")
    .trim()
    .toUpperCase();
  if (!symbolPattern.test(symbol))
    throw new Error("A valid stock symbol is required");
  return symbol;
}

export function watchlistDto(watchlist: any) {
  return {
    id: String(watchlist.id),
    name: String(watchlist.name),
    updatedAt: new Date(watchlist.updatedAt).toISOString(),
    assets: (watchlist.assets ?? []).map((asset: any) => ({
      symbol: String(asset.symbol),
      name: String(asset.name ?? asset.symbol),
      exchange: String(asset.exchange ?? ""),
      tradable: Boolean(asset.tradable),
    })),
  };
}

export function discoveryDto(
  movers: any,
  actives: any,
  clock: any,
  retrievedAtInput: DateInput = new Date(),
  serverRespondedAtInput: DateInput = retrievedAtInput,
) {
  const retrievedAt = iso(retrievedAtInput);
  const serverRespondedAt = iso(serverRespondedAtInput);
  const exchange = clock?.clocks?.find(
    (item: any) => item.market?.acronym === "NASDAQ",
  );
  const moversObservedAt = optionalIso(movers.lastUpdated);
  const activesObservedAt = optionalIso(actives.lastUpdated);
  const sessionObservedAt = optionalIso(exchange?.timestamp);
  const mover = (item: any) => ({
    symbol: String(item.symbol),
    price: Number(item.price),
    change: Number(item.change),
    percentChange: Number(item.percentChange),
    observedAt: moversObservedAt,
    retrievedAt,
    serverRespondedAt,
    time: normalizeTimeProvenance({
      observationTime: moversObservedAt,
      retrievalTime: retrievedAt,
      serverResponseTime: serverRespondedAt,
    }),
  });
  const observedAt = latest([moversObservedAt, activesObservedAt, sessionObservedAt]);
  return {
    gainers: (movers.gainers ?? []).map(mover),
    losers: (movers.losers ?? []).map(mover),
    mostActive: (actives.mostActives ?? []).map((item: any) => ({
      symbol: String(item.symbol),
      volume: Number(item.volume),
      tradeCount: Number(item.tradeCount),
      observedAt: activesObservedAt,
      retrievedAt,
      serverRespondedAt,
      time: normalizeTimeProvenance({
        observationTime: activesObservedAt,
        retrievalTime: retrievedAt,
        serverResponseTime: serverRespondedAt,
      }),
    })),
    session: {
      phase: String(exchange?.phase ?? "unknown"),
      isMarketDay: Boolean(exchange?.isMarketDay),
      timestamp: sessionObservedAt ?? serverRespondedAt,
      observedAt: sessionObservedAt,
      retrievedAt,
      serverRespondedAt,
      time: normalizeTimeProvenance({
        observationTime: sessionObservedAt,
        retrievalTime: retrievedAt,
        serverResponseTime: serverRespondedAt,
      }),
      nextOpen: exchange?.nextMarketOpen
        ? new Date(exchange.nextMarketOpen).toISOString()
        : null,
      nextClose: exchange?.nextMarketClose
        ? new Date(exchange.nextMarketClose).toISOString()
        : null,
    },
    observedAt,
    retrievedAt,
    serverRespondedAt,
    time: normalizeTimeProvenance({
      observationTime: observedAt,
      retrievalTime: retrievedAt,
      serverResponseTime: serverRespondedAt,
    }),
    asOf: serverRespondedAt,
    source: "Alpaca SIP screener and NASDAQ clock",
    screenerAsOf: latest([moversObservedAt, activesObservedAt]),
  };
}

export function orderSessionGuidance(
  clock: any,
  retrievedAtInput: DateInput = new Date(),
  serverRespondedAtInput: DateInput = retrievedAtInput,
) {
  const retrievedAt = iso(retrievedAtInput);
  const serverRespondedAt = iso(serverRespondedAtInput);
  const exchange = clock?.clocks?.find(
    (item: any) => item.market?.acronym === "NASDAQ",
  );
  const phase = String(exchange?.phase ?? "unknown");
  const core = ["open", "core", "continuous"].includes(phase.toLowerCase());
  const observedAt = optionalIso(exchange?.timestamp);
  return {
    phase,
    coreSession: core,
    observedAt,
    retrievedAt,
    serverRespondedAt,
    time: normalizeTimeProvenance({
      observationTime: observedAt,
      retrievalTime: retrievedAt,
      serverResponseTime: serverRespondedAt,
    }),
    nextOpen: exchange?.nextMarketOpen
      ? new Date(exchange.nextMarketOpen).toISOString()
      : null,
    nextClose: exchange?.nextMarketClose
      ? new Date(exchange.nextMarketClose).toISOString()
      : null,
    message: core
      ? "The core session is open; a market order may execute promptly but its price is not guaranteed."
      : "The core session is closed; a DAY market order may queue for the next eligible session and open at a materially different price.",
  };
}

export function calendarDto(
  response: any,
  clock: any,
  retrievedAtInput: DateInput = new Date(),
  serverRespondedAtInput: DateInput = retrievedAtInput,
) {
  const retrievedAt = iso(retrievedAtInput);
  const serverRespondedAt = iso(serverRespondedAtInput);
  const guidance = orderSessionGuidance(clock, retrievedAt, serverRespondedAt);
  return {
    market: {
      name: String(response.market?.name ?? "US equities"),
      acronym: String(response.market?.acronym ?? "NASDAQ"),
      timezone: String(response.market?.timezone ?? "America/New_York"),
    },
    sessions: (response.calendar ?? []).map((day: any) => {
      const coreStart = new Date(day.coreStart),
        coreEnd = new Date(day.coreEnd);
      const durationMinutes = Math.round(
        (coreEnd.getTime() - coreStart.getTime()) / 60_000,
      );
      // A regular US equity session is 390 minutes; shorter sessions are
      // surfaced as early closes rather than inferred from a date list.
      return {
        date: new Date(day.date).toISOString().slice(0, 10),
        coreStart: coreStart.toISOString(),
        coreEnd: coreEnd.toISOString(),
        preStart: day.preStart ? new Date(day.preStart).toISOString() : null,
        postEnd: day.postEnd ? new Date(day.postEnd).toISOString() : null,
        settlementDate: day.settlementDate
          ? new Date(day.settlementDate).toISOString().slice(0, 10)
          : null,
        observedAt: null,
        retrievedAt,
        serverRespondedAt,
        time: normalizeTimeProvenance({
          effectivePeriod: {
            start: coreStart,
            end: coreEnd,
            label: "NASDAQ core session",
          },
          retrievalTime: retrievedAt,
          serverResponseTime: serverRespondedAt,
        }),
        durationMinutes,
        earlyClose: durationMinutes < 390,
      };
    }),
    guidance,
    observedAt: guidance.observedAt,
    retrievedAt,
    serverRespondedAt,
    time: normalizeTimeProvenance({
      observationTime: guidance.observedAt,
      retrievalTime: retrievedAt,
      serverResponseTime: serverRespondedAt,
    }),
    asOf: serverRespondedAt,
  };
}
