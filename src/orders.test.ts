import { expect, test } from "bun:test";
import { signPreview, verifyPreview } from "./orders";
import { createStore } from "./store";

const secret = "12345678901234567890123456789012";
const preview = { symbol: "SPY", side: "buy" as const, qty: 1, price: 500, expiresAt: 2_000 };

test("preview tokens are signed and expire", () => {
  const token = signPreview(preview, secret);
  expect(verifyPreview(token, secret, 1_000)).toEqual(preview);
  expect(() => verifyPreview(`${token}x`, secret, 1_000)).toThrow("Invalid preview token");
  expect(() => verifyPreview(token, secret, 3_000)).toThrow("Preview expired");
});

test("submission idempotency and receipts persist", () => {
  const store = createStore(":memory:");
  expect(store.submission("key")).toBeNull();
  expect(store.reserveSubmission("key")).toBe(true);
  expect(store.reserveSubmission("key")).toBe(false);
  store.reserveSubmission("retry-key");
  store.releaseSubmission("retry-key");
  expect(store.reserveSubmission("retry-key")).toBe(true);
  store.completeSubmission("key", "order-1", { id: "order-1" });
  expect(store.submission("key")).toEqual({ id: "order-1" });
  store.receipt("receipt-1", { status: "submitted" });
  expect(store.getReceipt("receipt-1")).toEqual({ status: "submitted" });
  store.receipt("receipt-2", { orderId: "order-1", status: "accepted" });
  store.reconcileOrder("order-1", "filled");
  expect(store.getReceipt("receipt-2")).toMatchObject({ orderId: "order-1", status: "filled" });
  expect(store.receipts()).toHaveLength(2);
  store.plan("plan-1", "balanced_growth", { summary: "Balanced" });
  expect(store.getPlan("plan-1")).toMatchObject({ id: "plan-1", intent: "balanced_growth", summary: "Balanced" });
  store.close();
});
