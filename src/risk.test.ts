import { describe, expect, test } from "bun:test";
import { riskSnapshot, rollingTurnover, simulateTrade } from "./risk";

const positions = [
  { symbol: "AAPL", qty: "10", marketValue: "2000", unrealizedPl: "100" },
  { symbol: "MSFT", qty: "5", marketValue: "1000", unrealizedPl: "-25" },
];
const snapshot = riskSnapshot("10000", "7000", positions);

describe("risk engine", () => {
  test("counts only fills from the rolling 24 hour window", () => {
    const now = Date.parse("2026-06-20T12:00:00Z");
    expect(rollingTurnover([
      { filledAt: "2026-06-20T11:00:00Z", filledQty: "2", filledAvgPrice: "100" },
      { filledAt: "2026-06-19T11:00:00Z", filledQty: "9", filledAvgPrice: "100" },
      { filledAt: null, filledQty: "1", filledAvgPrice: "100" },
    ], now)).toBe(200);
  });
  test("calculates concentration and P&L", () => {
    expect(snapshot.cashPercent).toBe(70);
    expect(snapshot.largestPositionPercent).toBe(20);
    expect(snapshot.topThreePercent).toBe(30);
    expect(snapshot.hhi).toBeCloseTo(0.05);
    expect(snapshot.unrealizedPl).toBe(75);
  });

  test("allows a small diversified buy", () => {
    expect(simulateTrade({ snapshot, positions, symbol: "SPY", side: "buy", qty: 0.25, price: 400 })).toMatchObject({ allowed: true, estimatedNotional: 100, resultingPositionPercent: 1 });
  });

  test("blocks oversells, concentration, and large orders", () => {
    expect(simulateTrade({ snapshot, positions, symbol: "AAPL", side: "sell", qty: 11, price: 200 }).reasons).toContain("Sell quantity exceeds owned quantity");
    const result = simulateTrade({ snapshot, positions, symbol: "AAPL", side: "buy", qty: 2, price: 200 });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("Resulting position exceeds 20% concentration limit");
  });
});
