const symbolPattern = /^[A-Z.]{1,10}$/;

export function parseWatchlistInput(input: unknown) {
  const value = input as { name?: unknown; symbols?: unknown };
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 64) throw new Error("Watchlist name must contain 1 to 64 characters");
  if (!Array.isArray(value.symbols) || value.symbols.length > 50) throw new Error("Watchlist symbols must be an array of at most 50 tickers");
  const symbols = [...new Set(value.symbols.map(symbol => String(symbol).trim().toUpperCase()))];
  if (symbols.some(symbol => !symbolPattern.test(symbol))) throw new Error("Watchlist contains an invalid stock symbol");
  return { name, symbols };
}

export function parseSymbol(input: unknown) {
  const symbol = String(input ?? "").trim().toUpperCase();
  if (!symbolPattern.test(symbol)) throw new Error("A valid stock symbol is required");
  return symbol;
}

export function watchlistDto(watchlist: any) {
  return { id: String(watchlist.id), name: String(watchlist.name), updatedAt: new Date(watchlist.updatedAt).toISOString(), assets: (watchlist.assets ?? []).map((asset: any) => ({ symbol: String(asset.symbol), name: String(asset.name ?? asset.symbol), exchange: String(asset.exchange ?? ""), tradable: Boolean(asset.tradable) })) };
}

export function discoveryDto(movers: any, actives: any, clock: any) {
  const exchange = clock?.clocks?.find((item: any) => item.market?.acronym === "NASDAQ");
  const mover = (item: any) => ({ symbol: String(item.symbol), price: Number(item.price), change: Number(item.change), percentChange: Number(item.percentChange) });
  return {
    gainers: (movers.gainers ?? []).map(mover),
    losers: (movers.losers ?? []).map(mover),
    mostActive: (actives.mostActives ?? []).map((item: any) => ({ symbol: String(item.symbol), volume: Number(item.volume), tradeCount: Number(item.tradeCount) })),
    session: { phase: String(exchange?.phase ?? "unknown"), isMarketDay: Boolean(exchange?.isMarketDay), timestamp: exchange?.timestamp ? new Date(exchange.timestamp).toISOString() : new Date().toISOString(), nextOpen: exchange?.nextMarketOpen ? new Date(exchange.nextMarketOpen).toISOString() : null, nextClose: exchange?.nextMarketClose ? new Date(exchange.nextMarketClose).toISOString() : null },
    asOf: new Date().toISOString(),
    source: "Alpaca SIP screener and NASDAQ clock",
    screenerAsOf: movers.lastUpdated ?? actives.lastUpdated ?? null,
  };
}
