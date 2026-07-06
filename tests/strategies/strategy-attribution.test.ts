import { expect, test } from "bun:test";
import { buildStrategyOrderAttribution } from "../../backend/features/strategies/strategy-attribution";

test("attributes filled strategy paper orders across post-fill windows", () => {
  const attribution = buildStrategyOrderAttribution({
    generatedAt: "2026-06-25T12:00:00.000Z",
    run: {
      id: "run-1",
      strategyId: "moving-average-trend",
      strategyVersion: "backtest-v1",
      status: "paper",
      symbols: ["BTC/USD"],
    },
    orders: [
      {
        id: "row-1",
        decisionId: "decision-1",
        paperOrderId: "paper-1",
        status: "filled",
        createdAt: "2026-06-24T10:00:00.000Z",
        updatedAt: "2026-06-24T10:01:00.000Z",
        payload: {
          symbol: "BTC/USD",
          side: "buy",
          notional: 100,
          referencePrice: 50_000,
          broker: {
            status: "filled",
            filledAvgPrice: 50_100,
            filledQty: 0.001996,
            filledAt: "2026-06-24T10:01:00.000Z",
          },
        },
      },
    ],
    barsBySymbol: {
      "BTC/USD": [
        { timestamp: "2026-06-24T11:01:00.000Z", close: 50_601 },
        { timestamp: "2026-06-25T10:01:00.000Z", close: 49_599 },
      ],
    },
  });

  expect(attribution).toMatchObject({
    attributionVersion: "strategy-attribution-v1",
    summary: {
      orderCount: 1,
      filledOrders: 1,
      ordersWithFillQuality: 1,
      attributedWindows: 2,
      averageSlippageBps: 20,
    },
    warnings: [],
  });
  const order = attribution.orders[0]!;
  expect(order).toMatchObject({
    paperOrderId: "paper-1",
    fillQuality: { status: "available", slippageBps: 20 },
  });
  expect(order.windows[0]).toMatchObject({ window: "1h", status: "available" });
  expect(order.windows[0]!.sideAdjustedReturnPercent!).toBeCloseTo(1, 6);
  expect(order.windows[0]!.estimatedPnl!).toBeCloseTo(1, 6);
  expect(order.windows[1]).toMatchObject({ window: "1d", status: "available" });
  expect(order.windows[1]!.sideAdjustedReturnPercent!).toBeCloseTo(-1, 6);
  expect(order.windows[1]!.estimatedPnl!).toBeCloseTo(-1, 6);
  expect(order.windows[2]).toMatchObject({ window: "7d", status: "pending" });
  expect(attribution.summary.estimatedPnlByWindow["7d"]).toBe(null);
});

test("keeps unfilled and missing market data explicit", () => {
  const attribution = buildStrategyOrderAttribution({
    generatedAt: "2026-06-25T12:00:00.000Z",
    run: {
      id: "run-2",
      strategyId: "mean-reversion",
      strategyVersion: "backtest-v1",
      status: "paper",
      symbols: ["ETH/USD"],
    },
    orders: [
      {
        id: "row-2",
        decisionId: "decision-2",
        paperOrderId: "paper-2",
        status: "accepted",
        createdAt: "2026-06-24T10:00:00.000Z",
        updatedAt: "2026-06-24T10:00:00.000Z",
        payload: {
          symbol: "ETH/USD",
          side: "buy",
          notional: 50,
          referencePrice: 2_500,
          broker: { status: "accepted" },
        },
      },
    ],
    barsBySymbol: {},
  });

  expect(attribution.summary).toMatchObject({
    filledOrders: 0,
    ordersWithFillQuality: 0,
    attributedWindows: 0,
    averageSlippageBps: null,
  });
  expect(attribution.orders[0]!.windows[0]).toMatchObject({
    window: "1h",
    status: "not_filled",
  });
  expect(attribution.warnings).toContain(
    "No filled strategy paper orders are available for attribution yet.",
  );
});
