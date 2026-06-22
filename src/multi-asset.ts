const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function multiAssetDto(input: { indices?: Record<string, any>; forex?: Record<string, any>; crypto?: Record<string, any>; warnings?: string[] }) {
  const indices = Object.entries(input.indices ?? {}).map(([symbol, value]) => ({ symbol, value: finite(value.v), asOf: value.t ? new Date(value.t).toISOString() : null }));
  const forex = Object.entries(input.forex ?? {}).map(([symbol, rate]) => ({ symbol, bid: finite(rate.bp), ask: finite(rate.ap), midpoint: finite(rate.mp), asOf: rate.t ? new Date(rate.t).toISOString() : null }));
  const crypto = Object.entries(input.crypto ?? {}).map(([symbol, snapshot]) => {
    const quote = snapshot.latestQuote ?? {}, daily = snapshot.dailyBar ?? {}, previous = snapshot.prevDailyBar ?? {}, bid = finite(quote.bp), ask = finite(quote.ap), midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null, previousClose = finite(previous.c), close = finite(daily.c);
    return { symbol, bid, ask, midpoint, spreadBps: midpoint && ask !== null && bid !== null ? (ask - bid) / midpoint * 10_000 : null, dayChangePercent: close !== null && previousClose ? (close / previousClose - 1) * 100 : null, dayHigh: finite(daily.h), dayLow: finite(daily.l), volume: finite(daily.v), asOf: quote.t ? new Date(quote.t).toISOString() : null };
  });
  return { indices, forex, crypto, warnings: input.warnings ?? [], source: "Alpaca market data", cryptoRisk: "Crypto trades 24/7, has no equity market close, is cash-only collateral at Alpaca, and can gap through thin liquidity.", asOf: new Date().toISOString() };
}
