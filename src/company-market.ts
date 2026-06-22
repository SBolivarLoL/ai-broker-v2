export type CompanyBar = { timestamp: string; open: number; high: number; low: number; close: number; volume: number; vwap: number };

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);

export function companyMarketSnapshot(asset: any, snapshot: any, bars: any[], news: any[], clock: any, period: string, benchmarkSymbol = "SPY", benchmarkBars: any[] = []) {
  const normalizedBars: CompanyBar[] = bars.map(bar => ({ timestamp: new Date(bar.timestamp).toISOString(), open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volume), vwap: Number(bar.vwap) }))
    .filter(bar => Object.values(bar).every(value => typeof value === "string" || finite(value)) && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0 && bar.volume >= 0)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const quote = snapshot.latestQuote ?? {};
  const trade = snapshot.latestTrade ?? {};
  const daily = snapshot.dailyBar ?? {};
  const previous = snapshot.prevDailyBar ?? {};
  const bid = Number(quote.bp), ask = Number(quote.ap), midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const spread = midpoint && ask >= bid ? ask - bid : null;
  const spreadBps = spread !== null && midpoint ? spread / midpoint * 10_000 : null;
  const exchangeClock = clock?.clocks?.find((item: any) => item.market?.acronym === asset.exchange) ?? clock?.clocks?.find((item: any) => item.market?.acronym === "IEX");
  const marketPhase = exchangeClock?.phase ?? "unknown";
  const quoteAt = quote.t ? new Date(quote.t).toISOString() : null;
  const clockAt = exchangeClock?.timestamp ? new Date(exchangeClock.timestamp).getTime() : Date.now();
  const quoteAgeSeconds = quoteAt ? Math.max(0, (clockAt - new Date(quoteAt).getTime()) / 1_000) : null;
  const quality = !midpoint ? "unavailable" : marketPhase === "closed" ? "market_closed" : quoteAgeSeconds !== null && quoteAgeSeconds > 120 ? "stale" : spreadBps !== null && spreadBps > 50 ? "wide" : "healthy";
  const recentVolumes = normalizedBars.slice(-20).map(bar => bar.volume);
  const averageVolume20d = recentVolumes.length ? recentVolumes.reduce((sum, volume) => sum + volume, 0) / recentVolumes.length : null;
  const currentVolume = finite(daily.v) ? daily.v : normalizedBars.at(-1)?.volume ?? null;
  const price = finite(trade.p) && trade.p > 0 ? trade.p : normalizedBars.at(-1)?.close ?? null;
  const previousClose = finite(previous.c) && previous.c > 0 ? previous.c : normalizedBars.at(-2)?.close ?? null;
  const dayChangePercent = price && previousClose ? (price / previousClose - 1) * 100 : null;
  const normalizedBenchmark = benchmarkBars.map(bar => ({ timestamp: new Date(bar.timestamp).toISOString(), close: Number(bar.close) }))
    .filter(bar => finite(bar.close) && bar.close > 0).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const periodReturnPercent = normalizedBars.length > 1 ? (normalizedBars.at(-1)!.close / normalizedBars[0].close - 1) * 100 : null;
  const benchmarkReturnPercent = normalizedBenchmark.length > 1 ? (normalizedBenchmark.at(-1)!.close / normalizedBenchmark[0].close - 1) * 100 : null;
  return {
    company: { symbol: asset.symbol, name: asset.name ?? asset.symbol, exchange: asset.exchange, status: asset.status, tradable: Boolean(asset.tradable), fractionable: Boolean(asset.fractionable), shortable: Boolean(asset.shortable), marginable: Boolean(asset.marginable) },
    period,
    quote: { price, tradeAt: trade.t ? new Date(trade.t).toISOString() : null, bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null, bidSize: finite(quote.bs) ? quote.bs : null, askSize: finite(quote.as) ? quote.as : null, midpoint, spread, spreadBps, quoteAt, quoteAgeSeconds, quality, feed: "iex" },
    session: { phase: marketPhase, nextOpen: exchangeClock?.nextMarketOpen ? new Date(exchangeClock.nextMarketOpen).toISOString() : null, nextClose: exchangeClock?.nextMarketClose ? new Date(exchangeClock.nextMarketClose).toISOString() : null },
    stats: { dayChangePercent, periodReturnPercent, periodHigh: normalizedBars.length ? Math.max(...normalizedBars.map(bar => bar.high)) : null, periodLow: normalizedBars.length ? Math.min(...normalizedBars.map(bar => bar.low)) : null, currentVolume, averageVolume20d, relativeVolume: currentVolume !== null && averageVolume20d ? currentVolume / averageVolume20d : null },
    benchmark: { symbol: benchmarkSymbol, returnPercent: benchmarkReturnPercent, relativeStrengthPercent: periodReturnPercent !== null && benchmarkReturnPercent !== null ? periodReturnPercent - benchmarkReturnPercent : null, observations: normalizedBenchmark.length, quality: normalizedBenchmark.length > 1 ? "complete" : "insufficient", bars: normalizedBenchmark },
    bars: normalizedBars,
    news: news.slice(0, 8).map(article => ({ id: article.id, headline: article.headline, summary: article.summary, source: article.source, author: article.author, createdAt: new Date(article.createdAt).toISOString(), updatedAt: new Date(article.updatedAt).toISOString(), url: article.url ?? null })),
    asOf: new Date().toISOString(),
  };
}
