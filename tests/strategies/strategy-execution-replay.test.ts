import { expect, test } from "bun:test";
import { buildStrategyExecutionReplay } from "../../backend/features/strategies/strategy-execution-replay";

const run = {
  id: "run-1",
  strategyId: "moving-average-trend",
  strategyVersion: "backtest-v1",
  status: "paper" as const,
  symbols: ["BTC/USD"],
  config: { paperApproval: { maxSpreadBps: 250 } },
};

test("replays full market-order execution across visible order-book levels", () => {
  const replay = buildStrategyExecutionReplay({
    run,
    generatedAt: "2026-06-24T10:01:00.000Z",
    orders: [
      {
        id: "row-1",
        decisionId: "decision-1",
        paperOrderId: "paper-1",
        status: "filled",
        payload: {
          symbol: "BTC/USD",
          side: "buy",
          qty: 0.75,
          notional: 75,
          referencePrice: 100,
          submittedAt: "2026-06-24T10:00:01.000Z",
        },
        createdAt: "2026-06-24T10:00:01.000Z",
        updatedAt: "2026-06-24T10:00:02.000Z",
      },
    ],
    traces: [
      {
        id: "decision-1",
        traceId: "trace-1",
        symbol: "BTC/USD",
        snapshots: [
          {
            symbol: "BTC/USD",
            observedAt: "2026-06-24T10:00:00.000Z",
            latencyMs: 100,
            payload: {
              orderbook: {
                bids: [{ p: 99, s: 1 }],
                asks: [
                  { p: 101, s: 0.5 },
                  { p: 102, s: 0.5 },
                ],
              },
            },
          },
        ],
      },
    ],
    assumptions: { assumedOrderLatencyMs: 250, maxReplayLatencyMs: 5_000 },
  });

  expect(replay).toMatchObject({
    replayVersion: "strategy-execution-replay-v1",
    summary: {
      orderCount: 1,
      replayedOrders: 1,
      fullFills: 1,
      partialFills: 0,
      missedFills: 0,
    },
    assumptions: { maxSpreadBps: 250, assumedOrderLatencyMs: 250 },
  });
  expect(replay.orders[0]?.replay.status).toBe("full_fill");
  expect(replay.orders[0]?.replay.avgFillPrice).toBeCloseTo(101.333333, 5);
  expect(replay.orders[0]?.replay.slippageBps).toBeCloseTo(133.333333, 5);
  expect(replay.orders[0]?.spreadBps).toBeCloseTo(199.999999, 5);
});

test("classifies partial fills and latency-based missed fills", () => {
  const replay = buildStrategyExecutionReplay({
    run: { ...run, config: { paperApproval: { maxSpreadBps: 500 } } },
    orders: [
      {
        id: "row-1",
        decisionId: "decision-1",
        paperOrderId: "paper-1",
        status: "accepted",
        payload: {
          symbol: "BTC/USD",
          side: "sell",
          qty: 2,
          referencePrice: 100,
          submittedAt: "2026-06-24T10:00:01.000Z",
        },
        createdAt: "2026-06-24T10:00:01.000Z",
        updatedAt: "2026-06-24T10:00:02.000Z",
      },
      {
        id: "row-2",
        decisionId: "decision-2",
        paperOrderId: "paper-2",
        status: "accepted",
        payload: {
          symbol: "BTC/USD",
          side: "buy",
          qty: 1,
          referencePrice: 100,
          submittedAt: "2026-06-24T10:02:00.000Z",
        },
        createdAt: "2026-06-24T10:02:00.000Z",
        updatedAt: "2026-06-24T10:02:00.000Z",
      },
    ],
    traces: [
      {
        id: "decision-1",
        traceId: "trace-1",
        symbol: "BTC/USD",
        snapshots: [
          {
            symbol: "BTC/USD",
            observedAt: "2026-06-24T10:00:00.000Z",
            latencyMs: 100,
            payload: {
              orderbook: { b: [{ p: 99, s: 0.5 }], a: [{ p: 101, s: 2 }] },
            },
          },
        ],
      },
      {
        id: "decision-2",
        traceId: "trace-2",
        symbol: "BTC/USD",
        snapshots: [
          {
            symbol: "BTC/USD",
            observedAt: "2026-06-24T10:00:00.000Z",
            latencyMs: 100,
            payload: {
              orderbook: { b: [{ p: 99, s: 2 }], a: [{ p: 101, s: 2 }] },
            },
          },
        ],
      },
    ],
    assumptions: { maxReplayLatencyMs: 5_000, assumedOrderLatencyMs: 250 },
  });

  expect(replay.summary).toMatchObject({ partialFills: 1, missedFills: 1 });
  expect(replay.orders[0]?.replay).toMatchObject({
    status: "partial_fill",
    reason: "visible_depth_exhausted",
    filledQty: 0.5,
    unfilledQty: 1.5,
  });
  expect(replay.orders[1]?.replay).toMatchObject({
    status: "missed_fill",
    reason: "latency_exceeded",
    filledQty: 0,
  });
  expect(replay.warnings).toContain(
    "At least one paper order only partially filled against visible order-book depth under replay assumptions.",
  );
  expect(replay.warnings).toContain(
    "At least one paper order is treated as missed under spread, latency or visible-depth assumptions.",
  );
});

test("keeps missing order-book evidence explicit", () => {
  const replay = buildStrategyExecutionReplay({
    run,
    orders: [
      {
        id: "row-1",
        decisionId: "decision-1",
        paperOrderId: "paper-1",
        status: "accepted",
        payload: {
          symbol: "BTC/USD",
          side: "buy",
          qty: 1,
          referencePrice: 100,
          submittedAt: "2026-06-24T10:00:01.000Z",
        },
        createdAt: "2026-06-24T10:00:01.000Z",
        updatedAt: "2026-06-24T10:00:01.000Z",
      },
    ],
    traces: [
      {
        id: "decision-1",
        traceId: "trace-1",
        symbol: "BTC/USD",
        snapshots: [
          {
            symbol: "BTC/USD",
            observedAt: "2026-06-24T10:00:00.000Z",
            payload: { quote: { bid: 99, ask: 101 } },
          },
        ],
      },
    ],
  });

  expect(replay.summary).toMatchObject({
    replayedOrders: 0,
    missingOrderBooks: 1,
  });
  expect(replay.orders[0]?.replay).toMatchObject({
    status: "missing_order_book",
    reason: "order_book_snapshot_unavailable",
  });
  expect(replay.warnings).toContain(
    "Order-book replay needs decision snapshots with order-book payloads for every linked paper order.",
  );
});
