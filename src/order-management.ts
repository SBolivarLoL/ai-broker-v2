import type { trading } from "@alpacahq/alpaca-ts-alpha";

const cancellable = new Set(["new", "accepted", "partially_filled", "held", "accepted_for_bidding", "calculated", "stopped", "suspended"]);

export function canCancelOrder(status: unknown) {
  return typeof status === "string" && cancellable.has(status);
}

export function managedOrderDto(order: trading.Order): Record<string, unknown> {
  const qty = order.qty === null || order.qty === undefined ? null : Number(order.qty);
  const filledQty = Number(order.filledQty ?? 0);
  return {
    id: order.id,
    clientOrderId: order.clientOrderId,
    symbol: order.symbol,
    side: order.side,
    qty,
    notional: order.notional === null ? null : Number(order.notional),
    filledQty,
    remainingQty: qty === null ? null : Math.max(0, qty - filledQty),
    filledAvgPrice: order.filledAvgPrice === null || order.filledAvgPrice === undefined ? null : Number(order.filledAvgPrice),
    type: order.type,
    orderClass: order.orderClass,
    timeInForce: order.timeInForce,
    status: order.status,
    limitPrice: order.limitPrice === null || order.limitPrice === undefined ? null : Number(order.limitPrice),
    stopPrice: order.stopPrice === null || order.stopPrice === undefined ? null : Number(order.stopPrice),
    extendedHours: Boolean(order.extendedHours),
    submittedAt: order.submittedAt,
    filledAt: order.filledAt,
    canceledAt: order.canceledAt,
    updatedAt: order.updatedAt,
    replacedBy: order.replacedBy,
    replaces: order.replaces,
    cancelable: canCancelOrder(order.status),
    legs: order.legs?.map(leg => managedOrderDto(leg as trading.Order)) ?? [],
  };
}
