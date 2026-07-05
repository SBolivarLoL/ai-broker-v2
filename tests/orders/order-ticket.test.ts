import { expect, test } from "bun:test";
import {
  auctionSubmissionError,
  linkedOrderError,
  liquidityPreview,
  OrderTicket,
  ticketQuantity,
  ticketRiskPrice,
} from "../../backend/features/orders/order-ticket";

test("validates supported order ticket combinations", () => {
  expect(
    OrderTicket.parse({ symbol: "aapl", side: "buy", qty: "1" }),
  ).toMatchObject({
    symbol: "AAPL",
    type: "market",
    amountType: "quantity",
    qty: 1,
    timeInForce: "day",
  });
  expect(
    OrderTicket.parse({
      symbol: "SPY",
      side: "buy",
      amountType: "notional",
      notional: "25",
    }),
  ).toMatchObject({ notional: 25 });
  expect(() =>
    OrderTicket.parse({
      symbol: "SPY",
      side: "buy",
      amountType: "notional",
      notional: 25,
      type: "limit",
      limitPrice: 100,
    }),
  ).toThrow();
  expect(() =>
    OrderTicket.parse({ symbol: "SPY", side: "buy", qty: 1, type: "limit" }),
  ).toThrow();
  expect(() =>
    OrderTicket.parse({
      symbol: "SPY",
      side: "buy",
      qty: 1,
      type: "market",
      extendedHours: true,
    }),
  ).toThrow();
  expect(
    OrderTicket.parse({
      symbol: "SPY",
      side: "buy",
      qty: 1,
      type: "limit",
      limitPrice: 100,
      timeInForce: "opg",
    }),
  ).toMatchObject({ timeInForce: "opg" });
  expect(() =>
    OrderTicket.parse({
      symbol: "SPY",
      side: "buy",
      qty: 0.5,
      timeInForce: "cls",
    }),
  ).toThrow();
  expect(
    OrderTicket.parse({
      symbol: "SPY",
      side: "sell",
      qty: 1,
      allowShort: true,
    }),
  ).toMatchObject({ allowShort: true });
  expect(() =>
    OrderTicket.parse({ symbol: "SPY", side: "buy", qty: 1, allowShort: true }),
  ).toThrow();
  expect(() =>
    OrderTicket.parse({
      symbol: "SPY",
      side: "sell",
      qty: 1,
      allowShort: true,
      timeInForce: "gtc",
    }),
  ).toThrow();
});

test("validates linked-order sides, legs and price relationships", () => {
  const bracket = OrderTicket.parse({
    symbol: "SPY",
    side: "buy",
    qty: 1,
    orderClass: "bracket",
    takeProfitPrice: 110,
    stopLossPrice: 90,
  });
  expect(linkedOrderError(bracket, 100)).toBeNull();
  expect(() =>
    OrderTicket.parse({
      symbol: "SPY",
      side: "sell",
      qty: 1,
      orderClass: "bracket",
      takeProfitPrice: 110,
      stopLossPrice: 90,
    }),
  ).toThrow();
  expect(() =>
    OrderTicket.parse({
      symbol: "SPY",
      side: "buy",
      qty: 1,
      orderClass: "oto",
      takeProfitPrice: 110,
      stopLossPrice: 90,
    }),
  ).toThrow();
  expect(linkedOrderError({ ...bracket, takeProfitPrice: 95 }, 100)).toContain(
    "Take-profit",
  );
  expect(
    linkedOrderError({ ...bracket, stopLossLimitPrice: 95 }, 100),
  ).toContain("stop-loss limit");
});

test("calculates conservative risk quantity, price and liquidity warnings", () => {
  expect(ticketQuantity({ amountType: "notional", notional: 250 }, 100)).toBe(
    2.5,
  );
  expect(
    ticketRiskPrice(
      { type: "limit", side: "buy", limitPrice: 105, stopPrice: null },
      100,
    ),
  ).toBe(105);
  const liquidity = liquidityPreview(
    { latestQuote: { bp: 99, ap: 101 }, dailyBar: { v: 50 } },
    2,
    100,
    "market",
  );
  expect(liquidity).toMatchObject({
    midpoint: 100,
    spreadBps: 200,
    participationPercent: 4,
    estimatedSpreadCost: 2,
  });
  expect(liquidity.warnings).toHaveLength(2);
});

test("blocks Alpaca auction cutoff windows", () => {
  expect(
    auctionSubmissionError("opg", new Date("2026-06-22T13:27:00Z")),
  ).toBeNull();
  expect(
    auctionSubmissionError("opg", new Date("2026-06-22T13:28:00Z")),
  ).toContain("9:28 AM");
  expect(
    auctionSubmissionError("cls", new Date("2026-06-22T19:49:00Z")),
  ).toBeNull();
  expect(
    auctionSubmissionError("cls", new Date("2026-06-22T19:50:00Z")),
  ).toContain("3:50 PM");
  expect(
    auctionSubmissionError("opg", new Date("2026-06-22T23:00:00Z")),
  ).toBeNull();
});
