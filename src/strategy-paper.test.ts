import { expect, test } from "bun:test";
import { draftStrategyPaperOrder, evaluateStrategyPaperRiskPolicy, parseStrategyPaperApproval, strategyPaperApprovalActive, strategyPaperState } from "./strategy-paper";

test("validates run-level paper strategy approval limits", () => {
  const approval = parseStrategyPaperApproval({
    budget: 500,
    maxPositionNotional: 300,
    maxOrderNotional: 100,
    minOrderNotional: 10,
    maxSpreadBps: 75,
    expiresHours: 12,
    timeInForce: "ioc",
  }, "tester", new Date("2026-06-24T10:00:00.000Z"));

  expect(approval).toMatchObject({
    approvedBy: "tester",
    expiresAt: "2026-06-24T22:00:00.000Z",
    budget: 500,
    maxPositionNotional: 300,
    maxOrderNotional: 100,
    minOrderNotional: 10,
    maxSpreadBps: 75,
    timeInForce: "ioc",
    riskPolicy: {
      session: "crypto_24_7",
      requireCashAndBuyingPower: true,
      maxDailyLossPercent: 5,
      maxDrawdownPercent: 10,
      maxDailyTurnoverPercent: 50,
      errorCooldownMinutes: 30,
    },
  });
  expect(() => parseStrategyPaperApproval({ budget: 500, maxPositionNotional: 600 }, "tester")).toThrow("Max position notional");
  expect(() => parseStrategyPaperApproval({ budget: 500, maxOrderNotional: 600 }, "tester")).toThrow("Max order notional");
  expect(() => parseStrategyPaperApproval({ budget: 500, maxDailyLossPercent: 0 }, "tester")).toThrow("Max daily loss percent");
});

test("drafts bounded paper crypto orders from target exposure", () => {
  const approval = parseStrategyPaperApproval({ budget: 1_000, maxPositionNotional: 500, maxOrderNotional: 125, minOrderNotional: 5, maxSpreadBps: 100 }, "tester", new Date("2026-06-24T10:00:00.000Z"));
  const draft = draftStrategyPaperOrder({ approval, symbol: "BTC/USD", targetExposure: 0.8, currentNotional: 0, referencePrice: 50_000, spreadBps: 20, now: new Date("2026-06-24T10:01:00.000Z") });
  expect(draft).toMatchObject({ allowed: true, order: { side: "buy", notional: 125, qty: 0.0025, timeInForce: "gtc" } });

  const repeat = draftStrategyPaperOrder({ approval, symbol: "BTC/USD", targetExposure: 0.5, currentNotional: 500, referencePrice: 50_000, spreadBps: 20, now: new Date("2026-06-24T10:01:00.000Z") });
  expect(repeat).toEqual({ allowed: true, reasons: ["target_within_band"], order: null });

  const reduce = draftStrategyPaperOrder({ approval, symbol: "BTC/USD", targetExposure: 0, currentNotional: 250, referencePrice: 50_000, spreadBps: 20, now: new Date("2026-06-24T10:01:00.000Z") });
  expect(reduce).toMatchObject({ allowed: true, order: { side: "sell", notional: 125, qty: 0.0025 } });
});

test("blocks paper strategy orders on stale approval, kill switch and wide spreads", () => {
  const approval = parseStrategyPaperApproval({ budget: 1_000, maxSpreadBps: 50 }, "tester", new Date("2026-06-24T10:00:00.000Z"));
  expect(strategyPaperApprovalActive(approval, new Date("2026-06-24T10:01:00.000Z"))).toBe(true);
  expect(strategyPaperApprovalActive(approval, new Date("2026-06-25T10:01:00.000Z"))).toBe(false);
  expect(draftStrategyPaperOrder({ approval, symbol: "BTC/USD", targetExposure: 1, currentNotional: 0, referencePrice: 50_000, spreadBps: 60, now: new Date("2026-06-24T10:01:00.000Z") })).toMatchObject({ allowed: false, reasons: ["spread_limit"], order: null });
  expect(draftStrategyPaperOrder({ approval: { ...approval, killSwitch: { activatedAt: "2026-06-24T10:01:00.000Z", reason: "manual kill" } }, symbol: "BTC/USD", targetExposure: 1, currentNotional: 0, referencePrice: 50_000, spreadBps: 20, now: new Date("2026-06-24T10:02:00.000Z") })).toMatchObject({ allowed: false, reasons: ["kill_switch"], order: null });
});

test("calculates strategy paper state from linked order payloads", () => {
  expect(strategyPaperState([
    { status: "accepted", payload: { side: "buy", notional: 100 } },
    { status: "filled", payload: { side: "sell", qty: 0.001, referencePrice: 50_000 } },
    { status: "rejected", payload: { side: "buy", notional: 500 } },
  ])).toEqual({ netNotional: 50 });
});

test("applies crypto-specific paper policy for cash buying power and 24/7 sessions", () => {
  const approval = parseStrategyPaperApproval({
    budget: 1_000,
    maxOrderNotional: 300,
    maxDailyTurnoverPercent: 100,
    maxDailyLossPercent: 10,
    maxDrawdownPercent: 10,
    expiresHours: 24 * 7,
  }, "tester", new Date("2026-06-24T10:00:00.000Z"));
  const draft = draftStrategyPaperOrder({ approval, symbol: "BTC/USD", targetExposure: 0.5, currentNotional: 0, referencePrice: 50_000, spreadBps: 20, now: new Date("2026-06-28T10:00:00.000Z") });
  expect(draft.order).toBeTruthy();

  expect(evaluateStrategyPaperRiskPolicy({
    approval,
    draftOrder: draft.order,
    account: { cash: 250, buyingPower: 1_000 },
    now: new Date("2026-06-28T10:00:00.000Z"),
  })).toMatchObject({
    allowed: false,
    reasons: ["cash_limit"],
    evidence: { session: { venue: "crypto_24_7", allowed: true } },
  });

  expect(evaluateStrategyPaperRiskPolicy({
    approval,
    draftOrder: draft.order,
    account: { cash: 1_000, buyingPower: 1_000 },
    now: new Date("2026-06-28T10:00:00.000Z"),
  })).toMatchObject({ allowed: true, reasons: [] });
});

test("blocks crypto paper buys on turnover loss drawdown and error cooldown", () => {
  const approval = parseStrategyPaperApproval({
    budget: 1_000,
    maxOrderNotional: 200,
    maxDailyTurnoverPercent: 30,
    maxDailyLossPercent: 3,
    maxDrawdownPercent: 4,
    errorCooldownMinutes: 45,
  }, "tester", new Date("2026-06-24T10:00:00.000Z"));
  const now = new Date("2026-06-24T12:00:00.000Z");
  const draft = draftStrategyPaperOrder({ approval, symbol: "BTC/USD", targetExposure: 0.5, currentNotional: 0, referencePrice: 50_000, spreadBps: 20, now });
  expect(draft.order).toBeTruthy();

  const result = evaluateStrategyPaperRiskPolicy({
    approval,
    draftOrder: draft.order,
    account: { cash: 1_000, buyingPower: 1_000 },
    orders: [
      { status: "filled", createdAt: "2026-06-24T11:30:00.000Z", payload: { side: "buy", notional: 150 } },
      { status: "rejected", updatedAt: "2026-06-24T11:45:00.000Z", payload: { side: "buy", notional: 20 } },
    ],
    decisions: [{ createdAt: "2026-06-24T11:50:00.000Z", riskChecks: { reasons: ["broker_order_rejected"] }, reason: "broker rejected order" }],
    performance: {
      summary: { totalPnl: -40, maxDrawdownPercent: 5 },
      points: [
        { timestamp: "2026-06-24T11:00:00.000Z", equity: 1_000 },
        { timestamp: "2026-06-24T12:00:00.000Z", equity: 960 },
      ],
    },
    now,
  });

  expect(result.allowed).toBe(false);
  expect(result.reasons).toEqual(["daily_turnover_limit", "daily_loss_limit", "drawdown_limit", "error_cooldown"]);
});

test("regression: reduction orders remain allowed during loss and drawdown", () => {
  const approval = parseStrategyPaperApproval({
    budget: 1_000,
    maxOrderNotional: 200,
    maxDailyTurnoverPercent: 50,
    maxDailyLossPercent: 3,
    maxDrawdownPercent: 4,
  }, "tester", new Date("2026-06-24T10:00:00.000Z"));
  const now = new Date("2026-06-24T12:00:00.000Z");
  const draft = draftStrategyPaperOrder({ approval, symbol: "BTC/USD", targetExposure: 0, currentNotional: 200, referencePrice: 50_000, spreadBps: 20, now });

  expect(draft.order).toMatchObject({ side: "sell", notional: 200 });
  const result = evaluateStrategyPaperRiskPolicy({
    approval,
    draftOrder: draft.order,
    account: { cash: 0, buyingPower: 0 },
    performance: {
      summary: { totalPnl: -50, maxDrawdownPercent: 8 },
      points: [
        { timestamp: "2026-06-24T11:00:00.000Z", equity: 1_000 },
        { timestamp: "2026-06-24T12:00:00.000Z", equity: 950 },
      ],
    },
    now,
  });

  expect(result).toMatchObject({
    allowed: true,
    reasons: [],
    evidence: {
      dailyLoss: { lossNotional: 50, lossPercent: 5 },
      drawdown: { drawdownPercent: 8 },
    },
  });
});
