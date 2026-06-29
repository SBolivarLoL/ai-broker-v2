import { expect, test } from "bun:test";
import { OptionOrderTicket, optionOrderRisk, signOptionOrderPreview, signOptionPositionAction, verifyOptionOrderPreview, verifyOptionPositionAction } from "./option-order";

const contracts = [
  { symbol: "AAPL260717C00300000", underlyingSymbol: "AAPL", expirationDate: new Date("2026-07-17"), type: "call", strikePrice: "300", multiplier: "100", tradable: true },
  { symbol: "AAPL260717C00310000", underlyingSymbol: "AAPL", expirationDate: new Date("2026-07-17"), type: "call", strikePrice: "310", multiplier: "100", tradable: true },
];
const snapshots = { AAPL260717C00300000: { latestQuote: { bp: 4, ap: 4.2 } }, AAPL260717C00310000: { latestQuote: { bp: 1.9, ap: 2.1 } } };

test("supports long single legs and defined-risk debit verticals", () => {
  const single = OptionOrderTicket.parse({ kind: "single", legs: [{ symbol: contracts[0]!.symbol, side: "buy", positionIntent: "buy_to_open" }], qty: 1, type: "market" });
  expect(optionOrderRisk(single, contracts, snapshots)).toMatchObject({ maxLoss: 420, maxProfit: null, exerciseCost: 30_000, assignmentNotional: 0 });
  const vertical = OptionOrderTicket.parse({ kind: "vertical", legs: [{ symbol: contracts[0]!.symbol, side: "buy", positionIntent: "buy_to_open" }, { symbol: contracts[1]!.symbol, side: "sell", positionIntent: "sell_to_open" }], qty: 2, type: "limit", limitPrice: 2.5 });
  const verticalRisk = optionOrderRisk(vertical, contracts, snapshots);
  expect(verticalRisk).toMatchObject({ maxLoss: 500, maxProfit: 1500, exerciseCost: 60_000, assignmentNotional: 62_000 });
  expect(verticalRisk.referenceDebit).toBeCloseTo(2.3);
});

test("rejects naked, malformed and credit option strategies", () => {
  expect(OptionOrderTicket.safeParse({ kind: "single", legs: [{ symbol: contracts[0]!.symbol, side: "sell", positionIntent: "sell_to_open" }], qty: 1, type: "market" }).success).toBeFalse();
  const reversed = OptionOrderTicket.parse({ kind: "vertical", legs: [{ symbol: contracts[1]!.symbol, side: "buy", positionIntent: "buy_to_open" }, { symbol: contracts[0]!.symbol, side: "sell", positionIntent: "sell_to_open" }], qty: 1, type: "limit", limitPrice: 2 });
  expect(() => optionOrderRisk(reversed, contracts, snapshots)).toThrow("orientation");
});

test("option previews are signed and expire", () => {
  const secret = "z".repeat(32), risk = optionOrderRisk(OptionOrderTicket.parse({ kind: "single", legs: [{ symbol: contracts[0]!.symbol, side: "buy", positionIntent: "buy_to_open" }], qty: 1, type: "limit", limitPrice: 4 }), contracts, snapshots), expiresAt = Date.now() + 1000;
  const token = signOptionOrderPreview({ kind: "single", legs: risk.legs, qty: 1, type: "limit", limitPrice: 4, maxLoss: 400, maxProfit: null, exerciseCost: risk.exerciseCost, assignmentNotional: risk.assignmentNotional, expiresAt }, secret);
  expect(verifyOptionOrderPreview(token, secret).maxLoss).toBe(400);
  expect(() => verifyOptionOrderPreview(token, secret, expiresAt + 1)).toThrow("expired");
});

test("exercise and do-not-exercise actions bind exact positions", () => {
  const secret = "q".repeat(32), expiresAt = Date.now() + 1000;
  const token = signOptionPositionAction({ symbol: contracts[0]!.symbol, action: "exercise", qty: 1, strike: 300, multiplier: 100, optionType: "call", expiration: "2026-07-17", exerciseCost: 30_000, expiresAt }, secret);
  expect(verifyOptionPositionAction(token, secret)).toMatchObject({ action: "exercise", qty: 1, exerciseCost: 30_000 });
  expect(() => verifyOptionPositionAction(token, secret, expiresAt + 1)).toThrow("expired");
});
