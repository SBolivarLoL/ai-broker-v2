import { expect, test } from "bun:test";
import {
  riskSnapshot,
  simulateTrade,
} from "../../backend/shared/risk";

test("broker safety scenario corpus", () => {
  const base = riskSnapshot(10_000, 8_000, [
    { symbol: "AAPL", qty: 10, marketValue: 2_000 },
  ]);
  const cases = [
    ["small ETF buy", "SPY", "buy", 0.1, 500, true],
    ["maximum allowed buy", "SPY", "buy", 0.5, 500, true],
    ["fractional buy", "QQQ", "buy", 0.01, 400, true],
    ["second diversified buy", "IWM", "buy", 0.2, 200, true],
    ["large ETF buy", "SPY", "buy", 10, 500, false],
    ["just over notional limit", "SPY", "buy", 0.501, 500, false],
    ["very large buy", "SPY", "buy", 1_000, 500, false],
    ["oversell", "AAPL", "sell", 11, 200, false],
    ["fractional oversell", "AAPL", "sell", 10.001, 200, false],
    ["sell unowned symbol", "SPY", "sell", 0.1, 500, false],
    ["owned sell", "AAPL", "sell", 1, 200, true],
    ["fractional owned sell", "AAPL", "sell", 0.1, 200, true],
    ["sell exceeds notional limit", "AAPL", "sell", 2, 200, false],
    ["concentrated buy", "AAPL", "buy", 1, 200, false],
    ["tiny concentrated buy", "AAPL", "buy", 0.01, 200, false],
    ["zero qty", "SPY", "buy", 0, 500, "throw"],
    ["negative qty", "SPY", "buy", -1, 500, "throw"],
    ["NaN qty", "SPY", "buy", Number.NaN, 500, "throw"],
    ["infinite qty", "SPY", "buy", Infinity, 500, "throw"],
    ["zero price", "SPY", "buy", 1, 0, "throw"],
    ["negative price", "SPY", "buy", 1, -1, "throw"],
    ["NaN price", "SPY", "buy", 1, Number.NaN, "throw"],
    ["infinite price", "SPY", "buy", 1, Infinity, "throw"],
    ["turnover breach", "SPY", "buy", 0.1, 500, false, 1_000],
    ["turnover below limit", "SPY", "buy", 0.1, 500, true, 900],
    ["turnover exact limit", "SPY", "buy", 0.1, 500, true, 950],
  ] as const;
  expect(cases.length).toBeGreaterThanOrEqual(25);
  for (const [
    name,
    symbol,
    side,
    qty,
    price,
    expected,
    dailyTurnover = 0,
  ] of cases) {
    const run = () =>
      simulateTrade({
        snapshot: base,
        positions: [{ symbol: "AAPL", qty: 10, marketValue: 2_000 }],
        symbol,
        side,
        qty,
        price,
        dailyTurnover,
      });
    if (expected === "throw") expect(run, name).toThrow();
    else expect(run().allowed, name).toBe(expected);
  }
});

test("portfolio fixtures reject invalid trust-boundary data", () => {
  for (const input of [0, -1, Number.NaN, Infinity])
    expect(() => riskSnapshot(input, 0, [])).toThrow();
  expect(() => riskSnapshot(100, "nope", [])).toThrow();
});
