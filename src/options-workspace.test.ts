import { expect, test } from "bun:test";
import { blackScholesGreeks, OptionChainQuery, optionChainDto, optionPayoff, optionPortfolioGreeks } from "./options-workspace";

test("normalizes bounded option-chain queries", () => {
  expect(OptionChainQuery.parse({ symbol: " aapl ", expiration: "2026-07-17" })).toEqual({ symbol: "AAPL", expiration: "2026-07-17" });
  expect(OptionChainQuery.safeParse({ symbol: "bad!" }).success).toBeFalse();
});

test("combines contract metadata, liquidity and Greeks", () => {
  const dto = optionChainDto([{ symbol: "AAPL260717C00300000", type: "call", expirationDate: new Date("2026-07-17"), strikePrice: "300", multiplier: "100", tradable: true, openInterest: "120" }], {
    AAPL260717C00300000: { latestQuote: { bp: 4, ap: 6 }, dailyBar: { v: 50 }, impliedVolatility: .25, greeks: { delta: .5, gamma: .02, theta: -.1, vega: .2, rho: .1 } },
  }, 299, { optionsApprovedLevel: 3, optionsTradingLevel: 2, optionsBuyingPower: "5000" });
  expect(dto.contracts[0]).toMatchObject({ midpoint: 5, spreadBps: 4000, openInterest: 120, volume: 50, impliedVolatility: .25, greeks: { delta: .5 } });
  expect(dto.account).toEqual({ approvedLevel: 3, tradingLevel: 2, buyingPower: 5000 });
  expect(dto.selected?.maxLoss).toBe(500);
});

test("calculates independent long-option payoff boundaries", () => {
  expect(optionPayoff("call", 100, 5)).toMatchObject({ breakEven: 105, maxLoss: 500 });
  expect(optionPayoff("put", 100, 5)).toMatchObject({ breakEven: 95, maxLoss: 500 });
  expect(optionPayoff("call", 100, 5).points.find(point => point.underlyingPrice === 100)?.profit).toBe(-500);
});

test("independently calculates finite Black-Scholes Greeks", () => {
  const call = blackScholesGreeks("call", 100, 100, 1, .2, .05)!;
  expect(call.delta).toBeCloseTo(.6368, 3);
  expect(call.gamma).toBeCloseTo(.0188, 3);
  expect(call.vega).toBeCloseTo(.3752, 3);
  expect(blackScholesGreeks("put", 100, 100, 1, .2, .05)?.delta).toBeCloseTo(-.3632, 3);
  expect(blackScholesGreeks("call", 0, 100, 1, .2)).toBeNull();
});

test("aggregates signed portfolio Greeks by contract multiplier", () => {
  const result = optionPortfolioGreeks([{ symbol: "AAPL-C", qty: "2", marketValue: "500" }, { symbol: "AAPL-P", qty: "-1", marketValue: "-200" }], {
    "AAPL-C": { greeks: { delta: .5, gamma: .02, theta: -.1, vega: .2 } }, "AAPL-P": { greeks: { delta: -.4, gamma: .03, theta: -.08, vega: .15 } },
  }, [{ symbol: "AAPL-C", underlyingSymbol: "AAPL", multiplier: "100" }, { symbol: "AAPL-P", underlyingSymbol: "AAPL", multiplier: "100" }], { AAPL: 100 });
  expect(result.totals).toEqual({ delta: 140, gamma: 1, theta: -12, vega: 25 });
  expect(result.missingGreeks).toEqual([]);
  expect(result.scenarios.find(item => item.name === "IV +10 points")?.estimatedPnl).toBe(250);
  expect(result.scenarios.find(item => item.name === "One day decay")?.estimatedPnl).toBe(-12);
});
