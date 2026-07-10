import { expect, test } from "bun:test";
import {
  buildReplacementPreview,
  canCancelOrder,
  managedOrderDto,
  OrderTracker,
  signCancelAllPreview,
  signReplacementPreview,
  verifyCancelAllPreview,
  verifyReplacementPreview,
} from "../../backend/features/orders/order-management";

test("only stable working states expose cancellation", () => {
  for (const status of ["new", "accepted", "partially_filled", "held"])
    expect(canCancelOrder(status), status).toBe(true);
  for (const status of [
    "pending_new",
    "pending_cancel",
    "pending_replace",
    "filled",
    "canceled",
    "rejected",
    "expired",
  ])
    expect(canCancelOrder(status), status).toBe(false);
});

test("order management DTO calculates quantities and preserves nested time provenance", () => {
  const order = managedOrderDto(
    {
      id: "order-1",
      symbol: "AAPL",
      side: "buy",
      qty: "10",
      filledQty: "4",
      notional: null,
      type: "limit",
      timeInForce: "day",
      status: "partially_filled",
      limitPrice: "200",
      updatedAt: new Date("2026-07-11T09:59:59Z"),
      legs: [
        {
          id: "leg-1",
          symbol: "AAPL",
          side: "sell",
          qty: "10",
          filledQty: "0",
          notional: null,
          type: "stop",
          timeInForce: "gtc",
          status: "new",
        },
      ],
    } as any,
    new Date("2026-07-11T10:00:00Z"),
    new Date("2026-07-11T10:00:01Z"),
  );
  expect(order).toMatchObject({
    id: "order-1",
    qty: 10,
    filledQty: 4,
    remainingQty: 6,
    limitPrice: 200,
    cancelable: true,
    observedAt: "2026-07-11T09:59:59.000Z",
    retrievedAt: "2026-07-11T10:00:00.000Z",
    serverRespondedAt: "2026-07-11T10:00:01.000Z",
    legs: [
      {
        id: "leg-1",
        remainingQty: 10,
        cancelable: true,
        observedAt: null,
        retrievedAt: "2026-07-11T10:00:00.000Z",
        serverRespondedAt: "2026-07-11T10:00:01.000Z",
      },
    ],
  });
});

test("replacement previews only allow quantity reductions and non-worsening prices", () => {
  const order = {
    id: "00000000-0000-4000-8000-000000000001",
    symbol: "AAPL",
    side: "buy",
    qty: "10",
    filledQty: "2",
    notional: null,
    type: "limit",
    timeInForce: "day",
    status: "new",
    limitPrice: "200",
    stopPrice: null,
    updatedAt: new Date("2026-01-01"),
  } as any;
  const preview = buildReplacementPreview(
    order,
    { qty: 8, limitPrice: 195, stopPrice: null },
    2_000,
  );
  expect(preview).toMatchObject({
    replacement: { qty: 8, limitPrice: 195 },
    original: { qty: 10, limitPrice: 200 },
  });
  expect(() =>
    buildReplacementPreview(
      order,
      { qty: 11, limitPrice: 195, stopPrice: null },
      2_000,
    ),
  ).toThrow("reduce or preserve");
  expect(() =>
    buildReplacementPreview(
      order,
      { qty: 8, limitPrice: 205, stopPrice: null },
      2_000,
    ),
  ).toThrow("may not worsen");
  expect(() =>
    buildReplacementPreview(
      { ...order, status: "accepted" },
      { qty: 8, limitPrice: 195, stopPrice: null },
      2_000,
    ),
  ).toThrow("not currently replaceable");
});

test("replacement previews are signed and expire", () => {
  const secret = "12345678901234567890123456789012";
  const preview = {
    orderId: "00000000-0000-4000-8000-000000000001",
    symbol: "AAPL",
    side: "buy" as const,
    expectedUpdatedAt: null,
    original: { qty: 10, limitPrice: 200, stopPrice: null },
    replacement: { qty: 8, limitPrice: 195, stopPrice: null },
    expiresAt: 2_000,
  };
  const token = signReplacementPreview(preview, secret);
  expect(verifyReplacementPreview(token, secret, 1_000)).toEqual(preview);
  expect(() => verifyReplacementPreview(token, secret, 3_000)).toThrow(
    "expired",
  );
});

test("cancel-all previews bind an exact order snapshot and expire", () => {
  const secret = "12345678901234567890123456789012";
  const preview = {
    orderIds: ["123e4567-e89b-12d3-a456-426614174000"],
    expiresAt: 2_000,
  };
  const token = signCancelAllPreview(preview, secret);
  expect(verifyCancelAllPreview(token, secret, 1_000)).toEqual(preview);
  expect(() => verifyCancelAllPreview(token, secret, 3_000)).toThrow(
    "Cancel-all preview expired",
  );
});

test("order tracker applies stream updates and reports recovery freshness", () => {
  const tracker = new OrderTracker();
  tracker.recover(
    [
      {
        id: "one",
        symbol: "AAPL",
        status: "new",
        type: "limit",
        timeInForce: "day",
        notional: null,
        submittedAt: new Date("2026-01-01"),
      },
      {
        id: "two",
        symbol: "MSFT",
        status: "filled",
        type: "market",
        timeInForce: "day",
        notional: null,
        submittedAt: new Date("2025-01-01"),
      },
    ] as any,
    new Date(1_000),
  );
  expect(tracker.list("open", 10)).toHaveLength(1);
  tracker.setStreamState("authenticated");
  tracker.update(
    {
      id: "one",
      symbol: "AAPL",
      status: "filled",
      type: "limit",
      timeInForce: "day",
      notional: null,
    } as any,
    new Date(2_000),
    new Date(1_500),
  );
  expect(tracker.list("open", 10)).toHaveLength(0);
  expect(tracker.metadata(100_000)).toMatchObject({
    streamState: "authenticated",
    lastEventAt: new Date(1_500).toISOString(),
    stale: false,
  });
  expect(tracker.retrievedAt("one")).toBe(new Date(2_000).toISOString());
  tracker.setStreamState("disconnected", "socket closed");
  expect(tracker.metadata(100_000)).toMatchObject({
    stale: true,
    lastError: "socket closed",
  });
});

test("recovery polling cannot overwrite a newer stream event", () => {
  const tracker = new OrderTracker();
  tracker.update({
    id: "one",
    symbol: "AAPL",
    status: "filled",
    type: "limit",
    timeInForce: "day",
    notional: null,
    updatedAt: new Date(2_000),
  } as any, new Date(3_000));
  tracker.recover([
    {
      id: "one",
      symbol: "AAPL",
      status: "new",
      type: "limit",
      timeInForce: "day",
      notional: null,
      updatedAt: new Date(1_000),
    },
  ] as any, new Date(4_000));
  expect(tracker.list("closed", 10)).toMatchObject([{ status: "filled" }]);
  expect(tracker.retrievedAt("one")).toBe(new Date(3_000).toISOString());
  expect(tracker.latestRetrievedAt()).toBe(new Date(4_000).toISOString());
});
