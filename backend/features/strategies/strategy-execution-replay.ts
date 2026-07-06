/**
 * Reconstructs paper-order execution from stored traces using explicit latency,
 * fee, slippage, and market-impact assumptions.
 */
import type { StrategyRunStatus } from "../../persistence/store";
import { finiteNumber, validDate } from "../../shared/values";

type StrategyReplayRun = {
  id: string;
  strategyId: string;
  strategyVersion: string;
  status: StrategyRunStatus;
  symbols: string[];
  config?: any;
};
type StrategyReplayOrder = {
  id: string;
  decisionId: string;
  paperOrderId: string;
  status: string;
  payload: any;
  createdAt: string;
  updatedAt: string;
};
type StrategyReplayTrace = {
  id: string;
  traceId: string;
  symbol: string;
  snapshots?: {
    symbol: string;
    observedAt: string;
    latencyMs?: number | null;
    payload?: any;
  }[];
};
export type StrategyReplayAssumptions = {
  assumedOrderLatencyMs?: number;
  maxReplayLatencyMs?: number;
  maxSpreadBps?: number;
  maxDepthLevels?: number;
};

const positiveNumber = (value: unknown) => {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
};
const average = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

function replayAssumptions(input?: StrategyReplayAssumptions) {
  const maxSpreadBps = positiveNumber(input?.maxSpreadBps);
  return {
    assumedOrderLatencyMs: positiveNumber(input?.assumedOrderLatencyMs) ?? 250,
    maxReplayLatencyMs: positiveNumber(input?.maxReplayLatencyMs) ?? 5_000,
    maxSpreadBps: maxSpreadBps ?? 200,
    maxDepthLevels: Math.max(
      1,
      Math.min(100, Math.trunc(positiveNumber(input?.maxDepthLevels) ?? 25)),
    ),
    marketOrderExecution:
      "cross_visible_opposite_book_until_requested_quantity_or_depth_exhausted",
    partialFill:
      "visible opposite-side depth is positive but smaller than requested quantity",
    missedFill:
      "no usable opposite-side depth, spread above assumption, or decision-to-submit latency above assumption",
  };
}

function rawLevels(orderbook: any, side: "bid" | "ask") {
  if (!orderbook) return [];
  if (side === "bid")
    return orderbook.b ?? orderbook.bids ?? orderbook.bid ?? [];
  return orderbook.a ?? orderbook.asks ?? orderbook.ask ?? [];
}

function normalizeLevels(
  orderbook: any,
  side: "bid" | "ask",
  maxDepthLevels: number,
) {
  return rawLevels(orderbook, side)
    .map((level: any) => {
      const price = positiveNumber(level?.p ?? level?.price ?? level?.[0]);
      const size = positiveNumber(level?.s ?? level?.size ?? level?.[1]);
      return price && size ? { price, size } : null;
    })
    .filter(
      (
        level: { price: number; size: number } | null,
      ): level is { price: number; size: number } => Boolean(level),
    )
    .sort((a: { price: number }, b: { price: number }) =>
      side === "ask" ? a.price - b.price : b.price - a.price,
    )
    .slice(0, maxDepthLevels);
}

function orderEvidence(order: StrategyReplayOrder) {
  const payload = order.payload ?? {};
  const broker = payload.broker ?? {};
  const side = String(payload.side ?? broker.side ?? "").toLowerCase();
  const referencePrice = positiveNumber(payload.referencePrice);
  const notional = positiveNumber(payload.notional);
  const qty = positiveNumber(payload.qty ?? broker.qty ?? broker.filledQty);
  const requestedQty =
    qty ?? (notional && referencePrice ? notional / referencePrice : null);
  const requestedNotional =
    notional ??
    (requestedQty && referencePrice ? requestedQty * referencePrice : null);
  const symbol = String(payload.symbol ?? broker.symbol ?? "");
  const submittedAt = validDate(
    payload.submittedAt ?? broker.submittedAt ?? order.createdAt,
  );
  return {
    symbol,
    side,
    referencePrice,
    requestedQty,
    requestedNotional,
    submittedAt,
  };
}

function snapshotForOrder(
  order: StrategyReplayOrder,
  traces: StrategyReplayTrace[],
  symbol: string,
) {
  const trace = traces.find((item) => item.id === order.decisionId);
  const snapshots = trace?.snapshots ?? [];
  return (
    snapshots.find(
      (snapshot) => snapshot.symbol === symbol && snapshot.payload?.orderbook,
    ) ??
    snapshots.find((snapshot) => snapshot.payload?.orderbook) ??
    null
  );
}

function spreadBps(bids: { price: number }[], asks: { price: number }[]) {
  const bid = bids[0]?.price,
    ask = asks[0]?.price;
  if (!bid || !ask || ask < bid) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 10_000;
}

function replayBook(input: {
  side: string;
  requestedQty: number | null;
  referencePrice: number | null;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  spreadBps: number | null;
  maxSpreadBps: number;
  latencyMs: number | null;
  maxReplayLatencyMs: number;
}) {
  if (!["buy", "sell"].includes(input.side) || !input.requestedQty)
    return {
      status: "missing_order_request" as const,
      reason: "order_request_unavailable",
      filledQty: 0,
      filledNotional: 0,
      avgFillPrice: null,
      unfilledQty: input.requestedQty,
      slippageBps: null,
    };
  if (input.latencyMs !== null && input.latencyMs > input.maxReplayLatencyMs)
    return {
      status: "missed_fill" as const,
      reason: "latency_exceeded",
      filledQty: 0,
      filledNotional: 0,
      avgFillPrice: null,
      unfilledQty: input.requestedQty,
      slippageBps: null,
    };
  if (input.spreadBps !== null && input.spreadBps > input.maxSpreadBps)
    return {
      status: "missed_fill" as const,
      reason: "spread_exceeded",
      filledQty: 0,
      filledNotional: 0,
      avgFillPrice: null,
      unfilledQty: input.requestedQty,
      slippageBps: null,
    };
  const levels = input.side === "buy" ? input.asks : input.bids;
  if (!levels.length)
    return {
      status: "missed_fill" as const,
      reason: "opposite_book_empty",
      filledQty: 0,
      filledNotional: 0,
      avgFillPrice: null,
      unfilledQty: input.requestedQty,
      slippageBps: null,
    };
  let remaining = input.requestedQty,
    filledQty = 0,
    filledNotional = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const qty = Math.min(remaining, level.size);
    filledQty += qty;
    filledNotional += qty * level.price;
    remaining -= qty;
  }
  if (filledQty <= 0)
    return {
      status: "missed_fill" as const,
      reason: "opposite_book_empty",
      filledQty: 0,
      filledNotional: 0,
      avgFillPrice: null,
      unfilledQty: input.requestedQty,
      slippageBps: null,
    };
  const avgFillPrice = filledNotional / filledQty;
  const slippageBps = input.referencePrice
    ? input.side === "buy"
      ? ((avgFillPrice - input.referencePrice) / input.referencePrice) * 10_000
      : ((input.referencePrice - avgFillPrice) / input.referencePrice) * 10_000
    : null;
  return {
    status:
      remaining <= 1e-12 ? ("full_fill" as const) : ("partial_fill" as const),
    reason:
      remaining <= 1e-12
        ? "visible_depth_filled_order"
        : "visible_depth_exhausted",
    filledQty,
    filledNotional,
    avgFillPrice,
    unfilledQty: Math.max(0, remaining),
    slippageBps,
  };
}

export function buildStrategyExecutionReplay(input: {
  run: StrategyReplayRun;
  orders: StrategyReplayOrder[];
  traces: StrategyReplayTrace[];
  assumptions?: StrategyReplayAssumptions;
  generatedAt?: string;
}) {
  const assumptions = replayAssumptions({
    maxSpreadBps:
      input.assumptions?.maxSpreadBps ??
      input.run.config?.paperApproval?.maxSpreadBps,
    assumedOrderLatencyMs: input.assumptions?.assumedOrderLatencyMs,
    maxReplayLatencyMs: input.assumptions?.maxReplayLatencyMs,
    maxDepthLevels: input.assumptions?.maxDepthLevels,
  });
  const orders = input.orders.map((order) => {
    const evidence = orderEvidence(order);
    const snapshot = snapshotForOrder(order, input.traces, evidence.symbol);
    const orderbook = snapshot?.payload?.orderbook;
    const bids: { price: number; size: number }[] = normalizeLevels(
      orderbook,
      "bid",
      assumptions.maxDepthLevels,
    );
    const asks: { price: number; size: number }[] = normalizeLevels(
      orderbook,
      "ask",
      assumptions.maxDepthLevels,
    );
    const submittedAt = evidence.submittedAt;
    const observedAt = validDate(snapshot?.observedAt);
    const dataLatencyMs = finiteNumber(snapshot?.latencyMs);
    const decisionToSubmitLatencyMs =
      submittedAt && observedAt
        ? Math.max(0, submittedAt.getTime() - observedAt.getTime())
        : null;
    const replayLatencyMs =
      decisionToSubmitLatencyMs === null
        ? null
        : decisionToSubmitLatencyMs +
          assumptions.assumedOrderLatencyMs +
          (dataLatencyMs ?? 0);
    const bookSpreadBps = spreadBps(bids, asks);
    const replay = orderbook
      ? replayBook({
          side: evidence.side,
          requestedQty: evidence.requestedQty,
          referencePrice: evidence.referencePrice,
          bids,
          asks,
          spreadBps: bookSpreadBps,
          maxSpreadBps: assumptions.maxSpreadBps,
          latencyMs: replayLatencyMs,
          maxReplayLatencyMs: assumptions.maxReplayLatencyMs,
        })
      : {
          status: "missing_order_book" as const,
          reason: "order_book_snapshot_unavailable",
          filledQty: 0,
          filledNotional: 0,
          avgFillPrice: null,
          unfilledQty: evidence.requestedQty,
          slippageBps: null,
        };
    const visibleOppositeQty =
      evidence.side === "buy"
        ? asks.reduce((sum, level) => sum + level.size, 0)
        : bids.reduce((sum, level) => sum + level.size, 0);
    const visibleOppositeNotional =
      evidence.side === "buy"
        ? asks.reduce((sum, level) => sum + level.size * level.price, 0)
        : bids.reduce((sum, level) => sum + level.size * level.price, 0);
    return {
      id: order.id,
      decisionId: order.decisionId,
      paperOrderId: order.paperOrderId,
      symbol: evidence.symbol,
      side: evidence.side || null,
      status: order.status,
      requestedQty: evidence.requestedQty,
      requestedNotional: evidence.requestedNotional,
      referencePrice: evidence.referencePrice,
      submittedAt: submittedAt?.toISOString() ?? null,
      bookObservedAt: observedAt?.toISOString() ?? null,
      decisionToSubmitLatencyMs,
      replayLatencyMs,
      spreadBps: bookSpreadBps,
      depth: {
        bidLevels: bids.length,
        askLevels: asks.length,
        visibleOppositeQty,
        visibleOppositeNotional,
      },
      replay,
    };
  });
  const replayed = orders.filter(
    (order) =>
      !["missing_order_book", "missing_order_request"].includes(
        order.replay.status,
      ),
  );
  const slippages = replayed
    .map((order) => order.replay.slippageBps)
    .filter((value): value is number => value !== null);
  const spreads = orders
    .map((order) => order.spreadBps)
    .filter((value): value is number => value !== null);
  const latencies = orders
    .map((order) => order.replayLatencyMs)
    .filter((value): value is number => value !== null);
  const warnings = [
    input.orders.length
      ? null
      : "No strategy paper orders are available for order-book replay.",
    orders.some((order) => order.replay.status === "missing_order_book")
      ? "Order-book replay needs decision snapshots with order-book payloads for every linked paper order."
      : null,
    orders.some((order) => order.replay.status === "partial_fill")
      ? "At least one paper order only partially filled against visible order-book depth under replay assumptions."
      : null,
    orders.some((order) => order.replay.status === "missed_fill")
      ? "At least one paper order is treated as missed under spread, latency or visible-depth assumptions."
      : null,
  ].filter(Boolean) as string[];
  return {
    replayVersion: "strategy-execution-replay-v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    run: {
      id: input.run.id,
      strategyId: input.run.strategyId,
      strategyVersion: input.run.strategyVersion,
      status: input.run.status,
      symbols: input.run.symbols,
    },
    assumptions,
    summary: {
      orderCount: orders.length,
      replayedOrders: replayed.length,
      fullFills: orders.filter((order) => order.replay.status === "full_fill")
        .length,
      partialFills: orders.filter(
        (order) => order.replay.status === "partial_fill",
      ).length,
      missedFills: orders.filter(
        (order) => order.replay.status === "missed_fill",
      ).length,
      missingOrderBooks: orders.filter(
        (order) => order.replay.status === "missing_order_book",
      ).length,
      averageReplaySlippageBps: average(slippages),
      averageSpreadBps: average(spreads),
      averageReplayLatencyMs: average(latencies),
    },
    orders,
    warnings,
  };
}
