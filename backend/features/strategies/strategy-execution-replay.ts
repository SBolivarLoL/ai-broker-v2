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
const DEFAULT_BACKTEST_SLIPPAGE_BPS = 5;
const MIN_CALIBRATION_SAMPLE_SIZE = 20;

function percentile(values: number[], target: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (target / 100) * (sorted.length - 1);
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function observedFeeBps(order: StrategyReplayOrder) {
  const payload = order.payload ?? {}, broker = payload.broker ?? {};
  const qty = positiveNumber(payload.qty ?? broker.filledQty ?? broker.qty);
  const price = positiveNumber(broker.filledAvgPrice ?? payload.filledAvgPrice);
  const fee = finiteNumber(
    payload.fee ??
      payload.commission ??
      broker.fee ??
      broker.fees ??
      broker.commission,
  );
  const notional = positiveNumber(payload.notional) ?? (qty && price ? qty * price : null);
  return fee !== null && notional ? Math.abs(fee / notional) * 10_000 : null;
}

function observedFillSlippageBps(order: StrategyReplayOrder) {
  const payload = order.payload ?? {}, broker = payload.broker ?? {};
  const status = String(broker.status ?? order.status).toLowerCase();
  const side = String(payload.side ?? broker.side ?? "").toLowerCase();
  const referencePrice = positiveNumber(payload.referencePrice);
  const filledAvgPrice = positiveNumber(
    broker.filledAvgPrice ?? payload.filledAvgPrice,
  );
  if (
    status !== "filled" ||
    !["buy", "sell"].includes(side) ||
    !referencePrice ||
    !filledAvgPrice
  )
    return null;
  return side === "buy"
    ? ((filledAvgPrice - referencePrice) / referencePrice) * 10_000
    : ((referencePrice - filledAvgPrice) / referencePrice) * 10_000;
}

function metric(values: number[]) {
  return {
    count: values.length,
    average: average(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
  };
}

function ceilBasisPoints(value: number | null, fallback: number) {
  return value === null || !Number.isFinite(value)
    ? fallback
    : Math.ceil(Math.max(0, value));
}

function ceilMilliseconds(value: number | null, fallback: number) {
  return value === null || !Number.isFinite(value)
    ? fallback
    : Math.ceil(Math.max(0, value));
}

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
  const receiptSlippages = input.orders
    .map(observedFillSlippageBps)
    .filter((value): value is number => value !== null);
  const receiptFees = input.orders
    .map(observedFeeBps)
    .filter((value): value is number => value !== null);
  const replaySlippages = slippages.map((value) => Math.max(0, value));
  const replayedCount = replayed.length;
  const calibrationReady =
    input.orders.length >= MIN_CALIBRATION_SAMPLE_SIZE &&
    replayedCount >= MIN_CALIBRATION_SAMPLE_SIZE &&
    !orders.some((order) => order.replay.status === "missing_order_book");
  const replaySlippageP95 = percentile(replaySlippages, 95);
  const receiptSlippageP95 = percentile(
    receiptSlippages.map((value) => Math.max(0, value)),
    95,
  );
  const spreadP95 = percentile(spreads, 95);
  const latencyP95 = percentile(latencies, 95);
  const feeP95 = percentile(receiptFees, 95);
  const recommendedFeeBps = ceilBasisPoints(feeP95, 0);
  const recommendedSlippageBps = Math.max(
    DEFAULT_BACKTEST_SLIPPAGE_BPS,
    ceilBasisPoints(
      Math.max(replaySlippageP95 ?? 0, receiptSlippageP95 ?? 0),
      DEFAULT_BACKTEST_SLIPPAGE_BPS,
    ),
  );
  const spreadBufferBps = ceilBasisPoints(
    spreadP95 === null ? null : spreadP95 * 1.25,
    assumptions.maxSpreadBps,
  );
  const recommendedMaxSpreadBps = Math.min(
    assumptions.maxSpreadBps,
    spreadBufferBps,
  );
  const recommendedAssumedOrderLatencyMs = Math.max(
    assumptions.assumedOrderLatencyMs,
    ceilMilliseconds(latencyP95, assumptions.assumedOrderLatencyMs),
  );
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
    calibrationReady
      ? null
      : `Friction calibration needs at least ${MIN_CALIBRATION_SAMPLE_SIZE} orders with order-book replay evidence before it is considered stable.`,
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
    calibration: {
      calibrationVersion: "strategy-friction-calibration-v1",
      status: calibrationReady ? "available" : "insufficient_evidence",
      method:
        "paper_receipt_fill_quality_plus_decision_time_order_book_replay",
      minimumSampleSize: MIN_CALIBRATION_SAMPLE_SIZE,
      sampleSize: {
        paperOrders: input.orders.length,
        receiptFillSlippageSamples: receiptSlippages.length,
        receiptFeeSamples: receiptFees.length,
        orderBookReplaySamples: replayedCount,
        spreadSamples: spreads.length,
        latencySamples: latencies.length,
      },
      evidence: {
        feeBps: metric(receiptFees),
        receiptSlippageBps: metric(
          receiptSlippages.map((value) => Math.max(0, value)),
        ),
        replaySlippageBps: metric(replaySlippages),
        spreadBps: metric(spreads),
        replayLatencyMs: metric(latencies),
        partialFillRate: input.orders.length
          ? orders.filter((order) => order.replay.status === "partial_fill")
              .length / input.orders.length
          : null,
        missedFillRate: input.orders.length
          ? orders.filter((order) => order.replay.status === "missed_fill")
              .length / input.orders.length
          : null,
        missingOrderBookRate: input.orders.length
          ? orders.filter((order) => order.replay.status === "missing_order_book")
              .length / input.orders.length
          : null,
      },
      recommendedAssumptions: {
        feeBps: recommendedFeeBps,
        slippageBps: recommendedSlippageBps,
        maxSpreadBps: recommendedMaxSpreadBps,
        assumedOrderLatencyMs: recommendedAssumedOrderLatencyMs,
      },
      overridePolicy: {
        costModel:
          "Use the larger of user-provided/default cost assumptions and calibrated p95 fee/slippage evidence.",
        spreadGuardrail:
          "Use the stricter of the user max-spread override and the calibrated p95 spread buffer.",
        latency:
          "Use the larger of the user latency assumption and observed p95 replay latency.",
      },
      notes: [
        receiptFees.length
          ? "Paper receipt fee samples were observed; live fees still require separate broker schedule review."
          : "No explicit paper fee samples were observed; recommended fee remains zero until receipts expose fees or a user supplies a conservative override.",
        "Paper fills and replayed visible depth are calibration evidence, not live-trading approval.",
      ],
    },
    orders,
    warnings,
  };
}
