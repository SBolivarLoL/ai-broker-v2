import { z } from "zod";

export const OptionChainQuery = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z.]{1,10}$/),
  expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalPdf = (value: number) => Math.exp(-.5 * value * value) / Math.sqrt(2 * Math.PI);
const normalCdf = (value: number) => {
  const sign = value < 0 ? -1 : 1, x = Math.abs(value) / Math.sqrt(2), t = 1 / (1 + .3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - .284496736) * t + .254829592) * t) * Math.exp(-x * x);
  return .5 * (1 + sign * erf);
};

export function blackScholesGreeks(type: "call" | "put", spot: number, strike: number, years: number, volatility: number, riskFreeRate = .04) {
  if (![spot, strike, years, volatility].every(value => Number.isFinite(value) && value > 0)) return null;
  const rootT = Math.sqrt(years), d1 = (Math.log(spot / strike) + (riskFreeRate + volatility * volatility / 2) * years) / (volatility * rootT), d2 = d1 - volatility * rootT;
  const delta = type === "call" ? normalCdf(d1) : normalCdf(d1) - 1;
  const gamma = normalPdf(d1) / (spot * volatility * rootT);
  const vega = spot * normalPdf(d1) * rootT / 100;
  const thetaAnnual = -(spot * normalPdf(d1) * volatility) / (2 * rootT) + (type === "call" ? -riskFreeRate * strike * Math.exp(-riskFreeRate * years) * normalCdf(d2) : riskFreeRate * strike * Math.exp(-riskFreeRate * years) * normalCdf(-d2));
  const rho = (type === "call" ? strike * years * Math.exp(-riskFreeRate * years) * normalCdf(d2) : -strike * years * Math.exp(-riskFreeRate * years) * normalCdf(-d2)) / 100;
  return { delta, gamma, theta: thetaAnnual / 365, vega, rho };
}

export function optionPayoff(type: "call" | "put", strike: number, premium: number, multiplier = 100) {
  const points = Array.from({ length: 41 }, (_, index) => strike * (.6 + index * .02)).map(underlyingPrice => ({
    underlyingPrice,
    profit: ((type === "call" ? Math.max(underlyingPrice - strike, 0) : Math.max(strike - underlyingPrice, 0)) - premium) * multiplier,
  }));
  return { breakEven: type === "call" ? strike + premium : strike - premium, maxLoss: premium * multiplier, points };
}

export function optionChainDto(contracts: any[], snapshots: Record<string, any>, underlyingPrice: number, account: any) {
  const rows = contracts.map(contract => {
    const snapshot = snapshots[contract.symbol] ?? {}, quote = snapshot.latestQuote ?? {};
    const bid = finite(quote.bp), ask = finite(quote.ap);
    const midpoint = bid !== null && ask !== null && bid > 0 && ask >= bid ? (bid + ask) / 2 : null;
    const spreadBps = midpoint && ask !== null && bid !== null ? (ask - bid) / midpoint * 10_000 : null;
    const strike = Number(contract.strikePrice), multiplier = Number(contract.multiplier ?? 100);
    const impliedVolatility = finite(snapshot.impliedVolatility), expiration = new Date(contract.expirationDate), years = Math.max(1 / 365, (expiration.getTime() + 20 * 3_600_000 - Date.now()) / (365 * 86_400_000));
    return {
      symbol: String(contract.symbol), type: contract.type as "call" | "put", expiration: expiration.toISOString().slice(0, 10), strike,
      tradable: Boolean(contract.tradable), multiplier, openInterest: finite(contract.openInterest), volume: finite(snapshot.dailyBar?.v),
      bid, ask, midpoint, spreadBps, impliedVolatility, modelGreeks: impliedVolatility ? blackScholesGreeks(contract.type, underlyingPrice, strike, years, impliedVolatility) : null, greeks: snapshot.greeks ? {
        delta: finite(snapshot.greeks.delta), gamma: finite(snapshot.greeks.gamma), theta: finite(snapshot.greeks.theta), vega: finite(snapshot.greeks.vega), rho: finite(snapshot.greeks.rho),
      } : null,
    };
  }).filter(row => Number.isFinite(row.strike)).sort((a, b) => a.expiration.localeCompare(b.expiration) || a.strike - b.strike || a.type.localeCompare(b.type));
  const expirations = [...new Set(rows.map(row => row.expiration))];
  const selected = rows.filter(row => row.midpoint !== null).sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice))[0] ?? null;
  return {
    underlyingPrice,
    expirations,
    contracts: rows,
    selected: selected ? { symbol: selected.symbol, ...optionPayoff(selected.type, selected.strike, selected.midpoint!, selected.multiplier) } : null,
    account: { approvedLevel: Number(account.optionsApprovedLevel ?? 0), tradingLevel: Number(account.optionsTradingLevel ?? 0), buyingPower: finite(account.optionsBuyingPower) },
    source: "Alpaca OPRA indicative option snapshots",
    modelAssumptions: "Independent Black-Scholes comparison uses a 4% risk-free rate, no dividend yield and the snapshot implied volatility.",
    asOf: new Date().toISOString(),
  };
}

export function optionPortfolioGreeks(positions: any[], snapshots: Record<string, any>, contracts: any[], underlyingPrices: Record<string, number> = {}) {
  const contractMap = new Map(contracts.map(contract => [String(contract.symbol), contract]));
  const legs = positions.map(position => {
    const symbol = String(position.symbol), snapshot = snapshots[symbol] ?? {}, contract = contractMap.get(symbol), qty = Number(position.qty), multiplier = Number(contract?.multiplier ?? 100), greeks = snapshot.greeks;
    return { symbol, underlying: contract?.underlyingSymbol ?? null, qty, marketValue: Number(position.marketValue ?? 0), greeks: greeks ? {
      delta: Number(greeks.delta) * multiplier * qty,
      gamma: Number(greeks.gamma) * multiplier * qty,
      theta: Number(greeks.theta) * multiplier * qty,
      vega: Number(greeks.vega) * multiplier * qty,
    } : null };
  });
  const total = (key: "delta" | "gamma" | "theta" | "vega") => legs.reduce((sum, leg) => sum + (leg.greeks?.[key] ?? 0), 0);
  const shockPnl = (shock: number) => legs.reduce((sum, leg) => {
    const spot = underlyingPrices[leg.underlying ?? ""], move = spot * shock;
    return sum + (leg.greeks && Number.isFinite(spot) ? leg.greeks.delta * move + .5 * leg.greeks.gamma * move * move : 0);
  }, 0);
  return { legs, totals: { delta: total("delta"), gamma: total("gamma"), theta: total("theta"), vega: total("vega") }, scenarios: [
    { name: "Underlying −10%", estimatedPnl: shockPnl(-.1) }, { name: "Underlying −5%", estimatedPnl: shockPnl(-.05) },
    { name: "Underlying +5%", estimatedPnl: shockPnl(.05) }, { name: "Underlying +10%", estimatedPnl: shockPnl(.1) },
    { name: "IV +10 points", estimatedPnl: total("vega") * 10 }, { name: "One day decay", estimatedPnl: total("theta") },
  ], missingGreeks: legs.filter(leg => !leg.greeks).map(leg => leg.symbol), asOf: new Date().toISOString() };
}
