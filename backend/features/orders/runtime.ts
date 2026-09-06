import { conflict } from "../../http/http";
import { getOrderPrice, assertFreshOrderPrice } from "./market-price";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { containAlpacaSocketRace } from "../../integrations/alpaca/stream-control";
import type { createStore } from "../../persistence/store";
import {
  riskReservationStatusForBrokerStatus,
  workingBrokerOrderStatuses,
} from "../../shared/broker-status";
import { managedOrderDto, OrderTracker } from "./order-management";
import type { Preview } from "./orders";

type Store = ReturnType<typeof createStore>;
type RuntimeLifecycleDependencies = {
  setIntervalFn?: (callback: () => void, milliseconds: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
};

/** Owns broker order state, recovery, placement, and trade-update reconciliation. */
export function createOrderRuntime(
  alpaca: Alpaca,
  store: Store,
  now = () => new Date(),
  {
    setIntervalFn = setInterval,
    clearIntervalFn = (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  }: RuntimeLifecycleDependencies = {},
) {
  const tracker = new OrderTracker();
  let recoveryRequest: Promise<void> | null = null;
  let started = false;
  let updates: ReturnType<Alpaca["trading"]["stream"]> | null = null;
  let recoveryTimer: unknown | null = null;

  function reconcile(order: any) {
    // Broker order ids are canonical after acceptance. During the brief
    // pre-acceptance window, the client id still identifies the reservation.
    if (order.id && order.status) {
      const reconciledAt = now();
      store.reconcileOrder(order.id, order.status);
      store.reconcileStrategyOrder(order.id, order.status, {
        broker: managedOrderDto(order, reconciledAt, reconciledAt),
        brokerReconciledAt: reconciledAt.toISOString(),
      });
    }
    if (!order.status) return;
    const riskStatus = riskReservationStatusForBrokerStatus(order.status);
    if (
      !riskStatus ||
      (order.id && store.finishRiskReservation(order.id, riskStatus))
    )
      return;
    if (order.clientOrderId)
      store.finishRiskReservation(order.clientOrderId, riskStatus);
  }

  function applyBrokerSnapshot(order: any, retrievedAt = now()) {
    const accepted = tracker.recover([order], retrievedAt).has(order?.id);
    if (accepted) reconcile(order);
    return accepted;
  }

  async function recover() {
    recoveryRequest ??= (async () => {
      const brokerOrders = await alpaca.trading.orders.getAllOrders({
        status: "all",
        limit: 100,
        direction: "desc",
        nested: true,
      });
      const retrievedAt = now();
      const accepted = tracker.recover(brokerOrders, retrievedAt);
      for (const order of brokerOrders)
        if (order.id && accepted.has(order.id)) reconcile(order);
    })().finally(() => {
      recoveryRequest = null;
    });
    return recoveryRequest;
  }

  async function pendingBrokerOrders(
    orders: any[],
    candidatePrices: Map<string, number>,
  ) {
    // Risk checks value only the unfilled remainder. Limit/stop prices are
    // authoritative; market orders fall back to a fresh broker price.
    const working = orders.filter((order) =>
      workingBrokerOrderStatuses.has(String(order.status)),
    );
    const unpriced = working.filter((order) =>
      order.limitPrice == null && order.stopPrice == null &&
      !candidatePrices.has(String(order.symbol)));
    if (unpriced.some((order) =>
      (order.assetClass && order.assetClass !== "us_equity") ||
      !/^[A-Z.]{1,10}$/.test(String(order.symbol))))
      throw conflict(
        "A pending non-equity market order has no supported fresh valuation. Wait for its resolution, then refresh orders and create a new preview.",
        "pending_order_price_unavailable", true, "refresh_orders",
      );
    const symbols = [...new Set(unpriced.map((order) => String(order.symbol)))];
    const prices = new Map(
      await Promise.all(
        symbols.map(
          async (symbol) =>
            [
              symbol,
              await getOrderPrice(alpaca.marketData, symbol, now),
            ] as const,
        ),
      ),
    );
    for (const evidence of prices.values()) assertFreshOrderPrice(evidence, now());
    return working.map((order) => {
      const qty = Number(order.qty) - Number(order.filledQty ?? 0);
      const price = Number(
        order.limitPrice ?? order.stopPrice ?? candidatePrices.get(String(order.symbol)) ?? prices.get(String(order.symbol))?.price,
      );
      if (
        !(qty > 0) ||
        !Number.isFinite(price) ||
        price <= 0 ||
        !["buy", "sell"].includes(order.side)
      ) {
        throw new Error("A working order could not be valued safely");
      }
      return {
        orderId: order.id,
        symbol: String(order.symbol),
        side: order.side as "buy" | "sell",
        qty,
        price,
      };
    });
  }

  function placePreviewedOrder(preview: Preview, clientOrderId: string) {
    // The signed preview has already validated legal field combinations. This
    // branch only translates that trusted shape to Alpaca's typed endpoints.
    const common = {
      symbol: preview.symbol,
      side: preview.side,
      timeInForce: preview.timeInForce,
      extendedHours: preview.extendedHours,
      clientOrderId,
    };
    const takeProfit = preview.takeProfitPrice
      ? { limitPrice: preview.takeProfitPrice }
      : undefined;
    const stopLoss = preview.stopLossPrice
      ? {
          stopPrice: preview.stopLossPrice,
          ...(preview.stopLossLimitPrice
            ? { limitPrice: preview.stopLossLimitPrice }
            : {}),
        }
      : undefined;
    if (preview.orderClass === "bracket") {
      return alpaca.trading.orders.bracket({
        ...common,
        side: "buy",
        qty: preview.qty,
        ...(preview.limitPrice ? { limitPrice: preview.limitPrice } : {}),
        takeProfit: takeProfit!,
        stopLoss: stopLoss!,
      });
    }
    if (preview.orderClass === "oco") {
      return alpaca.trading.orders.oco({
        ...common,
        side: "sell",
        qty: preview.qty,
        takeProfit: takeProfit!,
        stopLoss: stopLoss!,
      });
    }
    if (preview.orderClass === "oto") {
      return takeProfit
        ? alpaca.trading.orders.oto({
            ...common,
            side: "buy",
            qty: preview.qty,
            ...(preview.limitPrice ? { limitPrice: preview.limitPrice } : {}),
            takeProfit,
          })
        : alpaca.trading.orders.oto({
            ...common,
            side: "buy",
            qty: preview.qty,
            ...(preview.limitPrice ? { limitPrice: preview.limitPrice } : {}),
            stopLoss: stopLoss!,
          });
    }
    if (preview.type === "market") {
      return preview.amountType === "notional"
        ? alpaca.trading.orders.market({
            ...common,
            notional: preview.notional!,
          })
        : alpaca.trading.orders.market({ ...common, qty: preview.qty });
    }
    if (preview.type === "limit") {
      return alpaca.trading.orders.limit({
        ...common,
        qty: preview.qty,
        limitPrice: preview.limitPrice!,
      });
    }
    if (preview.type === "stop") {
      return alpaca.trading.orders.stop({
        ...common,
        qty: preview.qty,
        stopPrice: preview.stopPrice!,
      });
    }
    if (preview.type === "stop_limit") {
      return alpaca.trading.orders.stopLimit({
        ...common,
        qty: preview.qty,
        stopPrice: preview.stopPrice!,
        limitPrice: preview.limitPrice!,
      });
    }
    return alpaca.trading.orders.trailingStop({
      ...common,
      qty: preview.qty,
      trailPercent: preview.trailPercent!,
    });
  }

  async function optionOrderMarketData(symbols: string[]) {
    const [contracts, snapshots] = await Promise.all([
      Promise.all(
        symbols.map((symbol) =>
          alpaca.trading.assets.getOptionContractSymbolOrId({
            symbolOrId: symbol,
          }),
        ),
      ),
      alpaca.marketData.options.optionSnapshots({ symbols: symbols.join(",") }),
    ]);
    return { contracts, snapshots: snapshots.snapshots ?? {} };
  }

  async function start() {
    if (!started) {
      started = true;
      try {
        if (!updates) {
          updates = alpaca.trading.stream({
            reconnect: true,
            maxReconnectSec: 30,
          });
          containAlpacaSocketRace(updates, (error) => {
            console.error("order stream websocket not ready", error.message);
          });
          updates.onStateChange((state) => tracker.setStreamState(state));
          updates.onConnect(() => tracker.setStreamState("authenticated"));
          updates.onDisconnect(() => tracker.setStreamState("disconnected"));
          updates.onError((error) => {
            tracker.setStreamState("error", error);
            console.error("order stream error", error);
          });
          updates.onTradeUpdate((update) => {
            const retrievedAt = now();
            tracker.update(
              update.order,
              retrievedAt,
              update.timestamp ?? retrievedAt,
            );
            reconcile(update.order);
            store.event("order.stream.update", "alpaca-stream", {
              event: update.event,
              orderId: update.order.id,
              clientOrderId: update.order.clientOrderId,
              symbol: update.order.symbol,
              status: update.order.status,
              timestamp: update.timestamp,
            });
          });
          // Register before connecting so the SDK's authenticated resubscribe
          // path owns both initial subscription and reconnects.
          updates.subscribeTradeUpdates();
        }
        updates.connect();
        // Streaming updates are fastest, while polling repairs missed events
        // after disconnects or process restarts.
        recoveryTimer = setIntervalFn(() => {
          void recover().catch((error) =>
            console.error(
              "order recovery failed",
              error instanceof Error ? error.message : error,
            ),
          );
        }, 30_000);
      } catch (error) {
        started = false;
        try {
          updates?.disconnect();
        } catch (cleanupError) {
          console.error("order stream cleanup failed", cleanupError);
        }
        throw error;
      }
    }
    return recover();
  }

  function stop() {
    if (!started && recoveryTimer === null) return;
    started = false;
    let failure: unknown;
    if (recoveryTimer !== null) {
      const interval = recoveryTimer;
      recoveryTimer = null;
      try {
        clearIntervalFn(interval);
      } catch (error) {
        failure = error;
      }
    }
    try {
      updates?.disconnect();
    } catch (error) {
      failure ??= error;
    }
    tracker.setStreamState("disconnected");
    if (failure) throw failure;
  }

  return {
    tracker,
    reconcile,
    applyBrokerSnapshot,
    recover,
    pendingBrokerOrders,
    placePreviewedOrder,
    optionOrderMarketData,
    start,
    stop,
  };
}
