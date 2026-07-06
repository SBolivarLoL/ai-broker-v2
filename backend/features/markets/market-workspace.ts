/** Pure validation and presentation helpers for market-discovery endpoints. */
const symbolPattern = /^[A-Z.]{1,10}$/;

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

export function discoveryDto(movers: any, actives: any, clock: any) {
  const exchange = clock?.clocks?.find(
    (item: any) => item.market?.acronym === "NASDAQ",
  );
  const mover = (item: any) => ({
    symbol: String(item.symbol),
    price: Number(item.price),
    change: Number(item.change),
    percentChange: Number(item.percentChange),
  });
  return {
    gainers: (movers.gainers ?? []).map(mover),
    losers: (movers.losers ?? []).map(mover),
    mostActive: (actives.mostActives ?? []).map((item: any) => ({
      symbol: String(item.symbol),
      volume: Number(item.volume),
      tradeCount: Number(item.tradeCount),
    })),
    session: {
      phase: String(exchange?.phase ?? "unknown"),
      isMarketDay: Boolean(exchange?.isMarketDay),
      timestamp: exchange?.timestamp
        ? new Date(exchange.timestamp).toISOString()
        : new Date().toISOString(),
      nextOpen: exchange?.nextMarketOpen
        ? new Date(exchange.nextMarketOpen).toISOString()
        : null,
      nextClose: exchange?.nextMarketClose
        ? new Date(exchange.nextMarketClose).toISOString()
        : null,
    },
    asOf: new Date().toISOString(),
    source: "Alpaca SIP screener and NASDAQ clock",
    screenerAsOf: movers.lastUpdated ?? actives.lastUpdated ?? null,
  };
}

export function orderSessionGuidance(clock: any) {
  const exchange = clock?.clocks?.find(
    (item: any) => item.market?.acronym === "NASDAQ",
  );
  const phase = String(exchange?.phase ?? "unknown");
  const core = ["open", "core", "continuous"].includes(phase.toLowerCase());
  return {
    phase,
    coreSession: core,
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

export function calendarDto(response: any, clock: any) {
  const guidance = orderSessionGuidance(clock);
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
        durationMinutes,
        earlyClose: durationMinutes < 390,
      };
    }),
    guidance,
    asOf: new Date().toISOString(),
  };
}
