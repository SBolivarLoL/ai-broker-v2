import { expect, test } from "bun:test";
import { buildStrategyPerformance } from "./strategy-performance";

test("calculates active-run P&L drawdown and baselines from filled strategy orders", () => {
  const performance = buildStrategyPerformance({
    generatedAt: "2026-06-25T12:00:00.000Z",
    run: {
      id: "run-1",
      strategyId: "moving-average-trend",
      strategyVersion: "backtest-v1",
      status: "paper",
      symbols: ["BTC/USD"],
      budget: 500,
      config: { paperApproval: { budget: 500 } },
    },
    orders: [{
      id: "row-1",
      paperOrderId: "paper-1",
      status: "filled",
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T10:01:00.000Z",
      payload: {
        symbol: "BTC/USD",
        side: "buy",
        notional: 100,
        broker: { status: "filled", filledQty: 0.002, filledAvgPrice: 50_000, filledAt: "2026-06-24T10:01:00.000Z" },
      },
    }],
    barsBySymbol: {
      "BTC/USD": [
        { timestamp: "2026-06-24T11:00:00.000Z", close: 50_000 },
        { timestamp: "2026-06-24T12:00:00.000Z", close: 45_000 },
        { timestamp: "2026-06-24T13:00:00.000Z", close: 55_000 },
      ],
    },
  });

  expect(performance).toMatchObject({
    performanceVersion: "strategy-performance-v1",
    summary: {
      status: "available",
      initialCapital: 500,
      currentEquity: 510,
      totalPnl: 10,
      totalReturnPercent: 2,
      filledOrders: 1,
    },
    baselines: {
      cash: { equity: 500, returnPercent: 0, activeReturnPercent: 2 },
      buyAndHold: { symbol: "BTC/USD", equity: 550, returnPercent: 10, activeReturnPercent: -8 },
      equalWeight: { symbols: ["BTC/USD"], equity: 550, returnPercent: 10, activeReturnPercent: -8 },
    },
  });
  expect(performance.summary.maxDrawdownPercent!).toBeCloseTo(2, 6);
  expect(performance.points).toHaveLength(3);
});

test("reports insufficient data when no filled strategy orders exist", () => {
  const performance = buildStrategyPerformance({
    generatedAt: "2026-06-25T12:00:00.000Z",
    run: {
      id: "run-empty",
      strategyId: "mean-reversion",
      strategyVersion: "backtest-v1",
      status: "paper",
      symbols: ["ETH/USD"],
      budget: 250,
      config: { paperApproval: { budget: 250 } },
    },
    orders: [],
    barsBySymbol: {},
  });

  expect(performance.summary).toMatchObject({ status: "insufficient_data", currentEquity: null, totalPnl: null, maxDrawdownPercent: null });
  expect(performance.warnings).toContain("No filled strategy paper orders are available for active-run performance yet.");
});
