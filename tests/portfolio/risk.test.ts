import { describe, expect, test } from "bun:test";
import {
  historicalRisk,
  portfolioHistory,
  riskSnapshot,
  rollingTurnover,
  simulateTrade,
} from "../../backend/features/portfolio/risk";

const positions = [
  { symbol: "AAPL", qty: "10", marketValue: "2000", unrealizedPl: "100" },
  { symbol: "MSFT", qty: "5", marketValue: "1000", unrealizedPl: "-25" },
];
const snapshot = riskSnapshot("10000", "7000", positions);

describe("risk engine", () => {
  test("calculates deterministic historical volatility and drawdown", () => {
    expect(historicalRisk([100, 110, 88, 99]).maxDrawdown).toBeCloseTo(20);
    expect(historicalRisk([100, 100, 100]).annualizedVolatility).toBe(0);
    expect(
      portfolioHistory(1_000, 500, [{ marketValue: 500, closes: [50, 100] }]),
    ).toEqual([0.75, 1]);
  });
  test("counts only fills from the rolling 24 hour window", () => {
    const now = Date.parse("2026-06-20T12:00:00Z");
    expect(
      rollingTurnover(
        [
          {
            filledAt: "2026-06-20T11:00:00Z",
            filledQty: "2",
            filledAvgPrice: "100",
          },
          {
            filledAt: "2026-06-19T11:00:00Z",
            filledQty: "9",
            filledAvgPrice: "100",
          },
          { filledAt: null, filledQty: "1", filledAvgPrice: "100" },
        ],
        now,
      ),
    ).toBe(200);
  });
  test("calculates concentration and P&L", () => {
    expect(snapshot.cashPercent).toBe(70);
    expect(snapshot.largestPositionPercent).toBe(20);
    expect(snapshot.topThreePercent).toBe(30);
    expect(snapshot.hhi).toBeCloseTo(0.05);
    expect(snapshot.unrealizedPl).toBe(75);
  });

  test("allows a small diversified buy", () => {
    expect(
      simulateTrade({
        snapshot,
        positions,
        symbol: "SPY",
        side: "buy",
        qty: 0.25,
        price: 400,
      }),
    ).toMatchObject({
      allowed: true,
      estimatedNotional: 100,
      resultingPositionPercent: 1,
    });
  });

  test("blocks oversells, concentration, and large orders", () => {
    expect(
      simulateTrade({
        snapshot,
        positions,
        symbol: "AAPL",
        side: "sell",
        qty: 11,
        price: 200,
      }).reasons,
    ).toContain("Sell quantity exceeds owned quantity");
    const result = simulateTrade({
      snapshot,
      positions,
      symbol: "AAPL",
      side: "buy",
      qty: 2,
      price: 200,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain(
      "Resulting position exceeds 20% concentration limit",
    );
  });

  test("permits only explicitly bounded short exposure", () => {
    const empty = riskSnapshot(100_000, 50_000, []);
    expect(
      simulateTrade({
        snapshot: empty,
        positions: [],
        symbol: "AAPL",
        side: "sell",
        qty: 10,
        price: 100,
      }).reasons,
    ).toContain("Sell quantity exceeds owned quantity");
    expect(
      simulateTrade({
        snapshot: empty,
        positions: [],
        symbol: "AAPL",
        side: "sell",
        qty: 10,
        price: 100,
        allowShort: true,
      }).allowed,
    ).toBeTrue();
    expect(
      simulateTrade({
        snapshot: empty,
        positions: [],
        symbol: "AAPL",
        side: "sell",
        qty: 60,
        price: 100,
        allowShort: true,
      }).reasons,
    ).toContain("Order exceeds $2500.00 limit");
  });

  test("includes pending buys in cash, concentration, and turnover", () => {
    const pendingOrders = [
      { symbol: "SPY", side: "buy" as const, qty: 10, price: 200 },
    ];
    const result = simulateTrade({
      snapshot,
      positions,
      symbol: "SPY",
      side: "buy",
      qty: 1,
      price: 100,
      dailyTurnover: 7_000,
      pendingOrders,
    });
    expect(result.resultingCash).toBe(4_900);
    expect(result.resultingPositionPercent).toBe(21);
    expect(result.turnoverPercent).toBe(91);
    expect(result.reasons).toContain(
      "Resulting position exceeds 20% concentration limit",
    );
    expect(result.reasons).toContain("Daily turnover exceeds 10% limit");
  });

  test("pending buys reserve cash and pending sells reserve inventory", () => {
    const lowCash = riskSnapshot(10_000, 500, positions);
    expect(
      simulateTrade({
        snapshot: lowCash,
        positions,
        symbol: "SPY",
        side: "buy",
        qty: 2,
        price: 200,
        pendingOrders: [{ symbol: "QQQ", side: "buy", qty: 1, price: 200 }],
      }).reasons,
    ).toContain("Insufficient cash");
    expect(
      simulateTrade({
        snapshot,
        positions,
        symbol: "AAPL",
        side: "sell",
        qty: 6,
        price: 200,
        pendingOrders: [{ symbol: "AAPL", side: "sell", qty: 5, price: 200 }],
      }).reasons,
    ).toContain("Sell quantity exceeds owned quantity");
  });
});
