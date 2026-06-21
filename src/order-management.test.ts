import { expect, test } from "bun:test";
import { canCancelOrder, managedOrderDto } from "./order-management";

test("only stable working states expose cancellation", () => {
  for (const status of ["new", "accepted", "partially_filled", "held"]) expect(canCancelOrder(status), status).toBe(true);
  for (const status of ["pending_new", "pending_cancel", "pending_replace", "filled", "canceled", "rejected", "expired"]) expect(canCancelOrder(status), status).toBe(false);
});

test("order management DTO calculates remaining quantity and preserves nested legs", () => {
  const order = managedOrderDto({ id: "order-1", symbol: "AAPL", side: "buy", qty: "10", filledQty: "4", notional: null, type: "limit", timeInForce: "day", status: "partially_filled", limitPrice: "200", legs: [{ id: "leg-1", symbol: "AAPL", side: "sell", qty: "10", filledQty: "0", notional: null, type: "stop", timeInForce: "gtc", status: "new" }] } as any);
  expect(order).toMatchObject({ id: "order-1", qty: 10, filledQty: 4, remainingQty: 6, limitPrice: 200, cancelable: true, legs: [{ id: "leg-1", remainingQty: 10, cancelable: true }] });
});
