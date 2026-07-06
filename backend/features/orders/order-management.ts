/**
 * Cancel/replace preview validation plus the in-memory projection of broker
 * orders maintained by stream events and periodic recovery.
 */
import type { trading } from "@alpacahq/alpaca-ts-alpha";
import { z } from "zod";
import { signToken, verifyToken } from "./orders";

const cancellable = new Set([
  "new",
  "accepted",
  "partially_filled",
  "held",
  "accepted_for_bidding",
  "calculated",
  "stopped",
  "suspended",
]);
const replaceable = new Set(["new", "partially_filled"]);
const working = new Set([
  "new",
  "accepted",
  "pending_new",
  "pending_cancel",
  "pending_replace",
  "accepted_for_bidding",
  "partially_filled",
  "held",
  "calculated",
  "stopped",
  "suspended",
]);

export function canCancelOrder(status: unknown) {
  return typeof status === "string" && cancellable.has(status);
}

export function canReplaceOrder(
  order: Pick<trading.Order, "status" | "type" | "notional" | "qty">,
) {
  return (
    typeof order.status === "string" &&
    replaceable.has(order.status) &&
    order.notional === null &&
    Number.isInteger(Number(order.qty)) &&
    ["limit", "stop", "stop_limit", "trailing_stop"].includes(order.type)
  );
}

export const ReplacementInput = z.object({
  qty: z.number().int().positive(),
  limitPrice: z.number().positive().finite().nullable(),
  stopPrice: z.number().positive().finite().nullable(),
});
export type ReplacementInput = z.infer<typeof ReplacementInput>;

export const ReplacementPreview = z.object({
  orderId: z.string().uuid(),
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  expectedUpdatedAt: z.string().nullable(),
  original: ReplacementInput,
  replacement: ReplacementInput,
  expiresAt: z.number().int(),
});
export type ReplacementPreview = z.infer<typeof ReplacementPreview>;

const numeric = (value: string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

export function buildReplacementPreview(
  order: trading.Order,
  raw: unknown,
  expiresAt: number,
): ReplacementPreview {
  if (!order.id || !order.symbol || !order.side || !canReplaceOrder(order))
    throw new Error("This order is not currently replaceable");
  const replacement = ReplacementInput.parse(raw);
  const original = ReplacementInput.parse({
    qty: Number(order.qty),
    limitPrice: numeric(order.limitPrice),
    stopPrice: numeric(order.stopPrice),
  });
  const filled = Number(order.filledQty ?? 0);
  if (replacement.qty > original.qty || replacement.qty <= filled)
    throw new Error(
      "Replacement quantity must reduce or preserve the order and remain above the filled quantity",
    );
  if (
    ["limit", "stop_limit"].includes(order.type) &&
    replacement.limitPrice === null
  )
    throw new Error("A limit price is required");
  if (
    ["stop", "stop_limit"].includes(order.type) &&
    replacement.stopPrice === null
  )
    throw new Error("A stop price is required");
  const improves = (next: number | null, prior: number | null) =>
    next === null ||
    prior === null ||
    (order.side === "buy" ? next <= prior : next >= prior);
  if (
    !improves(replacement.limitPrice, original.limitPrice) ||
    !improves(replacement.stopPrice, original.stopPrice)
  )
    throw new Error(
      "Replacement prices may not worsen the original order's exposure",
    );
  if (
    replacement.qty === original.qty &&
    replacement.limitPrice === original.limitPrice &&
    replacement.stopPrice === original.stopPrice
  )
    throw new Error("At least one order field must change");
  return {
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    expectedUpdatedAt: order.updatedAt?.toISOString() ?? null,
    original,
    replacement,
    expiresAt,
  };
}

export function signReplacementPreview(
  preview: ReplacementPreview,
  secret: string,
) {
  return signToken(ReplacementPreview.parse(preview), secret);
}
export function verifyReplacementPreview(
  token: string,
  secret: string,
  now = Date.now(),
) {
  const preview = ReplacementPreview.parse(
    verifyToken(token, secret, "Invalid replacement preview token"),
  );
  if (preview.expiresAt < now) throw new Error("Replacement preview expired");
  return preview;
}

const CancelAllPreview = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(100),
  expiresAt: z.number().int(),
});
export type CancelAllPreview = z.infer<typeof CancelAllPreview>;
export function signCancelAllPreview(
  preview: CancelAllPreview,
  secret: string,
) {
  return signToken(CancelAllPreview.parse(preview), secret);
}
export function verifyCancelAllPreview(
  token: string,
  secret: string,
  now = Date.now(),
) {
  const preview = CancelAllPreview.parse(
    verifyToken(token, secret, "Invalid cancel-all preview token"),
  );
  if (preview.expiresAt < now) throw new Error("Cancel-all preview expired");
  return preview;
}

export class OrderTracker {
  private orders = new Map<string, trading.Order>();
  private streamState = "connecting";
  private lastEventAt: string | null = null;
  private lastRecoveryAt: string | null = null;
  private lastError: string | null = null;
  recover(orders: trading.Order[], now = new Date()) {
    for (const order of orders) {
      if (!order.id) continue;
      const streamed = this.orders.get(order.id);
      const streamedAt = Number(
          streamed?.updatedAt ?? streamed?.submittedAt ?? 0,
        ),
        recoveredAt = Number(order.updatedAt ?? order.submittedAt ?? 0);
      // Recovery must not overwrite a newer event already received from the
      // stream with an older REST snapshot.
      if (!streamed || recoveredAt >= streamedAt)
        this.orders.set(order.id, order);
    }
    this.lastRecoveryAt = now.toISOString();
  }
  update(order: trading.Order, now = new Date()) {
    if (order.id) this.orders.set(order.id, order);
    this.lastEventAt = now.toISOString();
  }
  setStreamState(state: string, error: string | null = null) {
    this.streamState = state;
    this.lastError = error;
  }
  list(status: "open" | "closed" | "all", limit: number) {
    return [...this.orders.values()]
      .filter(
        (order) =>
          status === "all" ||
          (status === "open") === working.has(String(order.status)),
      )
      .sort(
        (a, b) =>
          Number(b.submittedAt ?? b.createdAt ?? 0) -
          Number(a.submittedAt ?? a.createdAt ?? 0),
      )
      .slice(0, limit);
  }
  metadata(now = Date.now()) {
    const recoveryAgeMs = this.lastRecoveryAt
      ? now - Date.parse(this.lastRecoveryAt)
      : null;
    return {
      streamState: this.streamState,
      lastEventAt: this.lastEventAt,
      lastRecoveryAt: this.lastRecoveryAt,
      recoveryAgeMs,
      stale:
        recoveryAgeMs === null ||
        (this.streamState !== "authenticated" && recoveryAgeMs > 90_000),
      lastError: this.lastError,
    };
  }
  get size() {
    return this.orders.size;
  }
}

export function managedOrderDto(order: trading.Order): Record<string, unknown> {
  const qty =
    order.qty === null || order.qty === undefined ? null : Number(order.qty);
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
    filledAvgPrice:
      order.filledAvgPrice === null || order.filledAvgPrice === undefined
        ? null
        : Number(order.filledAvgPrice),
    type: order.type,
    orderClass: order.orderClass,
    timeInForce: order.timeInForce,
    status: order.status,
    limitPrice:
      order.limitPrice === null || order.limitPrice === undefined
        ? null
        : Number(order.limitPrice),
    stopPrice:
      order.stopPrice === null || order.stopPrice === undefined
        ? null
        : Number(order.stopPrice),
    extendedHours: Boolean(order.extendedHours),
    submittedAt: order.submittedAt,
    filledAt: order.filledAt,
    canceledAt: order.canceledAt,
    updatedAt: order.updatedAt,
    replacedBy: order.replacedBy,
    replaces: order.replaces,
    cancelable: canCancelOrder(order.status),
    replaceable: canReplaceOrder(order),
    legs: order.legs?.map((leg) => managedOrderDto(leg as trading.Order)) ?? [],
  };
}
