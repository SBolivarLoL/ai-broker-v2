/** Attributes filled strategy orders to signal, timing, and post-fill movement. */
import type { StrategyRunStatus } from "../../persistence/store";
import {
  finiteNumber,
  normalizePriceBars,
  validDate,
  type PriceBarInput,
} from "../../shared/values";

export const STRATEGY_ATTRIBUTION_WINDOWS = [
  { key: "1h", label: "1 hour", ms: 60 * 60_000 },
  { key: "1d", label: "1 day", ms: 24 * 60 * 60_000 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 60 * 60_000 },
] as const;

type StrategyAttributionRun = {
  id: string;
  strategyId: string;
  strategyVersion: string;
  status: StrategyRunStatus;
  symbols: string[];
};
type StrategyAttributionOrder = {
  id: string;
  decisionId: string;
  paperOrderId: string;
  status: string;
  payload: any;
  createdAt: string;
  updatedAt: string;
};
type AttributionBar = PriceBarInput;

const average = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

function orderEvidence(order: StrategyAttributionOrder) {
  const payload = order.payload ?? {};
  const broker = payload.broker ?? {};
  const symbol = String(payload.symbol ?? broker.symbol ?? "");
  const status = String(broker.status ?? order.status ?? "");
  const side = String(payload.side ?? broker.side ?? "").toLowerCase();
  const referencePrice = finiteNumber(payload.referencePrice);
  const filledAvgPrice = finiteNumber(
    broker.filledAvgPrice ?? payload.filledAvgPrice,
  );
  const filledAt = validDate(
    broker.filledAt ??
      payload.filledAt ??
      (status === "filled" ? order.updatedAt : null),
  );
  const submittedAt = validDate(
    payload.submittedAt ?? broker.submittedAt ?? order.createdAt,
  );
  const filledQty = finiteNumber(
    broker.filledQty ?? payload.filledQty ?? payload.qty,
  );
  const filledNotional =
    finiteNumber(payload.notional) ??
    (filledQty && filledAvgPrice ? filledQty * filledAvgPrice : null);
  return {
    payload,
    broker,
    symbol,
    status,
    side,
    referencePrice,
    filledAvgPrice,
    filledAt,
    submittedAt,
    filledQty,
    filledNotional,
  };
}

function fillSlippageBps(
  side: string,
  referencePrice: number | null,
  filledAvgPrice: number | null,
) {
  if (!referencePrice || !filledAvgPrice || !["buy", "sell"].includes(side))
    return null;
  return side === "buy"
    ? ((filledAvgPrice - referencePrice) / referencePrice) * 10_000
    : ((referencePrice - filledAvgPrice) / referencePrice) * 10_000;
}

export function buildStrategyOrderAttribution(input: {
  run: StrategyAttributionRun;
  orders: StrategyAttributionOrder[];
  barsBySymbol?: Record<string, AttributionBar[]>;
  generatedAt?: string;
}) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const generatedDate = validDate(generatedAt) ?? new Date();
  const normalizedBarsBySymbol = Object.fromEntries(
    Object.entries(input.barsBySymbol ?? {}).map(([symbol, bars]) => [
      symbol,
      normalizePriceBars(bars),
    ]),
  );
  const orders = input.orders.map((order) => {
    const evidence = orderEvidence(order);
    const slippageBps = fillSlippageBps(
      evidence.side,
      evidence.referencePrice,
      evidence.filledAvgPrice,
    );
    const fillComplete =
      evidence.status === "filled" &&
      Boolean(evidence.filledAt && evidence.filledAvgPrice);
    const bars = normalizedBarsBySymbol[evidence.symbol] ?? [];
    const windows = STRATEGY_ATTRIBUTION_WINDOWS.map((window) => {
      const targetAt = evidence.filledAt
        ? new Date(evidence.filledAt.getTime() + window.ms)
        : null;
      if (!fillComplete || !targetAt)
        return {
          window: window.key,
          label: window.label,
          targetAt: null,
          status: "not_filled" as const,
          price: null,
          marketReturnPercent: null,
          sideAdjustedReturnPercent: null,
          estimatedPnl: null,
        };
      if (targetAt.getTime() > generatedDate.getTime())
        return {
          window: window.key,
          label: window.label,
          targetAt: targetAt.toISOString(),
          status: "pending" as const,
          price: null,
          marketReturnPercent: null,
          sideAdjustedReturnPercent: null,
          estimatedPnl: null,
        };
      const bar = bars.find(
        (item) => item.timestamp.getTime() >= targetAt.getTime(),
      );
      if (!bar)
        return {
          window: window.key,
          label: window.label,
          targetAt: targetAt.toISOString(),
          status: "missing_data" as const,
          price: null,
          marketReturnPercent: null,
          sideAdjustedReturnPercent: null,
          estimatedPnl: null,
        };
      const marketReturnPercent =
        (bar.close / evidence.filledAvgPrice! - 1) * 100;
      const sideAdjustedReturnPercent =
        evidence.side === "sell" ? -marketReturnPercent : marketReturnPercent;
      return {
        window: window.key,
        label: window.label,
        targetAt: targetAt.toISOString(),
        status: "available" as const,
        price: bar.close,
        marketReturnPercent,
        sideAdjustedReturnPercent,
        estimatedPnl: evidence.filledNotional
          ? (evidence.filledNotional * sideAdjustedReturnPercent) / 100
          : null,
      };
    });
    return {
      id: order.id,
      decisionId: order.decisionId,
      paperOrderId: order.paperOrderId,
      symbol: evidence.symbol,
      side: evidence.side || null,
      status: evidence.status,
      submittedAt: evidence.submittedAt?.toISOString() ?? null,
      filledAt: evidence.filledAt?.toISOString() ?? null,
      referencePrice: evidence.referencePrice,
      filledAvgPrice: evidence.filledAvgPrice,
      filledQty: evidence.filledQty,
      filledNotional: evidence.filledNotional,
      fillQuality: {
        status: slippageBps === null ? "missing_fill_evidence" : "available",
        slippageBps,
      },
      windows,
    };
  });
  const slippages = orders
    .map((order) => order.fillQuality.slippageBps)
    .filter((value): value is number => value !== null);
  const availableWindows = orders.flatMap((order) =>
    order.windows.filter((window) => window.status === "available"),
  );
  const averageWindowReturnPercent = Object.fromEntries(
    STRATEGY_ATTRIBUTION_WINDOWS.map((window) => [
      window.key,
      average(
        orders.flatMap((order) =>
          order.windows
            .filter(
              (item) =>
                item.window === window.key &&
                item.sideAdjustedReturnPercent !== null,
            )
            .map((item) => item.sideAdjustedReturnPercent!),
        ),
      ),
    ]),
  );
  const estimatedPnlByWindow = Object.fromEntries(
    STRATEGY_ATTRIBUTION_WINDOWS.map((window) => [
      window.key,
      (() => {
        const values = orders.flatMap((order) =>
          order.windows
            .filter(
              (item) =>
                item.window === window.key && item.estimatedPnl !== null,
            )
            .map((item) => item.estimatedPnl!),
        );
        return values.length
          ? values.reduce((sum, value) => sum + value, 0)
          : null;
      })(),
    ]),
  );
  const filledOrders = orders.filter(
    (order) => order.status === "filled",
  ).length;
  const warnings = [
    input.orders.length
      ? null
      : "No strategy paper orders have been submitted for this run yet.",
    filledOrders
      ? null
      : "No filled strategy paper orders are available for attribution yet.",
    availableWindows.length
      ? null
      : "No post-fill attribution windows have enough market data yet.",
  ].filter(Boolean) as string[];

  return {
    attributionVersion: "strategy-attribution-v1",
    generatedAt,
    run: {
      id: input.run.id,
      strategyId: input.run.strategyId,
      strategyVersion: input.run.strategyVersion,
      status: input.run.status,
      symbols: input.run.symbols,
    },
    windows: STRATEGY_ATTRIBUTION_WINDOWS.map((window) => ({
      key: window.key,
      label: window.label,
    })),
    summary: {
      orderCount: input.orders.length,
      filledOrders,
      ordersWithFillQuality: slippages.length,
      attributedWindows: availableWindows.length,
      averageSlippageBps: average(slippages),
      averageSideAdjustedReturnPercent: averageWindowReturnPercent,
      estimatedPnlByWindow,
    },
    orders,
    warnings,
  };
}
