import { expect, test } from "bun:test";
import { signPreview, verifyPreview, verifyPreviewFresh, type Preview } from "./orders";
import { createStore } from "./store";

const secret = "12345678901234567890123456789012";
const preview: Preview = { symbol: "SPY", side: "buy", qty: 1, amountType: "quantity", type: "market", orderClass: "simple", limitPrice: null, stopPrice: null, trailPercent: null, takeProfitPrice: null, stopLossPrice: null, stopLossLimitPrice: null, timeInForce: "day", extendedHours: false, allowShort: false, price: 500, expiresAt: 2_000 };

test("preview tokens are signed and expire", () => {
  const token = signPreview(preview, secret);
  expect(verifyPreview(token, secret, 1_000)).toEqual(preview);
  expect(() => verifyPreview(`${token}x`, secret, 1_000)).toThrow("Invalid preview token");
  expect(() => verifyPreview(token, secret, 3_000)).toThrow("Preview expired");
});

test("submission validation receives intent without trusting preview simulation", async () => {
  const withOldSimulation = signPreview({ ...preview, simulation: { allowed: true, estimatedNotional: 500, resultingCash: 500, resultingPositionPercent: 5, turnoverPercent: 5, reasons: [] } }, secret);
  const result = await verifyPreviewFresh(withOldSimulation, secret, intent => ({ allowed: false, checked: intent }), 1_000);
  expect(result.validation).toMatchObject({ allowed: false, checked: { symbol: "SPY", side: "buy", qty: 1, type: "market", amountType: "quantity", price: 500 } });
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
  expect(store.decisionAuditTrail("receipt-2")).toMatchObject([{ kind: "receipt.decision", actor: "system", payload: { orderId: "order-1", status: "accepted" } }]);
  expect(store.decisionAuditTrail("plan-1")).toMatchObject([{ kind: "agent.plan", actor: "agent", payload: { intent: "balanced_growth", summary: "Balanced" } }]);
  expect(store.verifyDecisionAuditTrail()).toEqual({ valid: true, entries: 3, invalidEntryId: null });
  store.close();
});

test("risk reservations have a durable lifecycle", () => {
  const store = createStore(":memory:");
  const candidate = { symbol: "SPY", side: "buy" as const, qty: 1, price: 100 };
  expect(store.reserveRisk("risk-1", candidate, active => ({ allowed: active.length === 0, value: active.length }))).toEqual({ reserved: true, validation: 0 });
  expect(store.activeRiskReservations()).toMatchObject([{ key: "risk-1", status: "reserved", ...candidate }]);
  expect(store.markRiskSubmitted("risk-1", "order-1")).toBe(true);
  expect(store.activeRiskReservations()[0]).toMatchObject({ status: "submitted", orderId: "order-1" });
  expect(store.finishRiskReservation("risk-1", "filled")).toBe(true);
  expect(store.activeRiskReservations()).toEqual([]);
  store.close();
});

test("transactional reservations cannot stack past policy", () => {
  const store = createStore(":memory:");
  const reserve = (key: string) => store.reserveRisk(key, { symbol: "SPY", side: "buy", qty: 1, price: 600 }, active => {
    const projected = active.reduce((sum, order) => sum + order.qty * order.price, 600);
    return { allowed: projected <= 1_000, value: projected };
  });
  expect(reserve("candidate-1")).toMatchObject({ reserved: true });
  expect(reserve("candidate-2")).toEqual({ reserved: false, reason: "risk", validation: 1_200 });
  expect(store.activeRiskReservations()).toHaveLength(1);
  expect(store.finishRiskReservation("candidate-1", "released")).toBe(true);
  expect(reserve("candidate-2")).toMatchObject({ reserved: true });
  store.close();
});

test("basket risk reservations are all-or-nothing", () => {
  const store = createStore(":memory:");
  const candidates = [
    { symbol: "AAPL", side: "sell" as const, qty: 1, price: 100 },
    { symbol: "MSFT", side: "buy" as const, qty: 2, price: 100 },
  ];
  expect(store.reserveRiskBasket("basket", candidates, active => ({ allowed: active.length === 0, value: active.length }))).toMatchObject({ reserved: true, keys: ["basket:0", "basket:1"] });
  expect(store.activeRiskReservations()).toHaveLength(2);
  expect(store.reserveRiskBasket("second", candidates, active => ({ allowed: active.length === 0, value: active.length }))).toEqual({ reserved: false, reason: "risk", validation: 2 });
  expect(store.activeRiskReservations()).toHaveLength(2);
  store.finishRiskReservation("basket:0", "released");
  store.finishRiskReservation("basket:1", "released");
  expect(store.reserveRiskBasket("basket", candidates, active => ({ allowed: active.length === 0, value: active.length }))).toMatchObject({ reserved: true, keys: ["basket:0", "basket:1"] });
  store.close();
});

test("abandoned pre-submission reservations expire safely", async () => {
  const store = createStore(":memory:");
  store.reserveRisk("abandoned", { symbol: "SPY", side: "buy", qty: 1, price: 100 }, () => ({ allowed: true, value: null }), 1);
  await Bun.sleep(3);
  expect(store.activeRiskReservations()).toEqual([]);
  expect(store.markRiskSubmitted("abandoned", "too-late")).toBe(false);
  expect(store.reserveRisk("abandoned", { symbol: "SPY", side: "buy", qty: 1, price: 100 }, () => ({ allowed: true, value: null }))).toMatchObject({ reserved: true });
  store.close();
});
