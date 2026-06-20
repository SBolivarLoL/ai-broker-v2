import { expect, test } from "bun:test";
import { riskSnapshot, simulateTrade } from "./risk";

test("broker safety scenario corpus", () => {
  const base = riskSnapshot(10_000, 8_000, [{ symbol: "AAPL", qty: 10, marketValue: 2_000 }]);
  const cases = [
    ["small ETF buy", "SPY", "buy", 0.1, 500, true],
    ["large ETF buy", "SPY", "buy", 10, 500, false],
    ["oversell", "AAPL", "sell", 11, 200, false],
    ["owned sell", "AAPL", "sell", 1, 200, true],
    ["concentrated buy", "AAPL", "buy", 1, 200, false],
    ["zero qty", "SPY", "buy", 0, 500, "throw"],
    ["negative qty", "SPY", "buy", -1, 500, "throw"],
    ["NaN price", "SPY", "buy", 1, Number.NaN, "throw"],
    ["infinite price", "SPY", "buy", 1, Infinity, "throw"],
    ["turnover breach", "SPY", "buy", 0.1, 500, false, 1_000],
  ] as const;
  for (const [name, symbol, side, qty, price, expected, dailyTurnover = 0] of cases) {
    const run = () => simulateTrade({ snapshot: base, positions: [{ symbol: "AAPL", qty: 10, marketValue: 2_000 }], symbol, side, qty, price, dailyTurnover });
    if (expected === "throw") expect(run, name).toThrow();
    else expect(run().allowed, name).toBe(expected);
  }
});

test("portfolio fixtures reject invalid trust-boundary data", () => {
  for (const input of [0, -1, Number.NaN, Infinity]) expect(() => riskSnapshot(input, 0, [])).toThrow();
  expect(() => riskSnapshot(100, "nope", [])).toThrow();
});
