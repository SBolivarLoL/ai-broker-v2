import { describe, expect, test } from "bun:test";
import { activityCategory, ledgerSummary, normalizeActivity, type LedgerActivity } from "./ledger";
import { createStore } from "./store";

const fill = (id: string, occurredAt: string, side: "buy" | "sell", quantity: number, price: number): LedgerActivity => ({ id, type: "FILL", subType: null, category: "trade", status: "executed", occurredAt, symbol: "AAPL", side, quantity, price, amount: quantity * price * (side === "buy" ? -1 : 1), orderId: null });

describe("account activity ledger", () => {
  test("normalizes fills and non-trade cash activity", () => {
    expect(normalizeActivity({ id: "1", activityType: "FILL", transactionTime: new Date("2026-01-01T12:00:00Z"), symbol: "AAPL", side: "buy", qty: "2", price: "100" })).toMatchObject({ category: "trade", amount: -200, quantity: 2 });
    expect(normalizeActivity({ id: "2", activityType: "DIV", date: new Date("2026-01-02"), symbol: "AAPL", netAmount: "3.50" })).toMatchObject({ category: "dividend", amount: 3.5 });
  });

  test("maps broker activity categories without guessing unknown types", () => {
    expect(activityCategory("OPTRD")).toBe("option");
    expect(activityCategory("NOT_A_REAL_ACTIVITY")).toBe("other");
  });

  test("regression: rejects incomplete and non-finite broker activity data", () => {
    expect(() => normalizeActivity({ id: "bad-fill", activityType: "FILL", transactionTime: new Date("2026-01-01T12:00:00Z"), side: "buy", qty: "2", price: "100" })).toThrow("Fill activity is incomplete");
    expect(() => normalizeActivity({ id: "bad-number", activityType: "DIV", date: new Date("2026-01-02"), netAmount: "NaN" })).toThrow("non-finite number");
    expect(() => normalizeActivity({ id: "bad-basis", activityType: "SPIN", date: new Date("2026-01-02"), basis_allocations: [{ symbol: "CHILD", quantity: "1" }] })).toThrow("basis allocation 1 is incomplete");
  });

  test("calculates FIFO realized profit across partial lots", () => {
    const summary = ledgerSummary([
      fill("1", "2026-01-01T00:00:00.000Z", "buy", 2, 100),
      fill("2", "2026-01-02T00:00:00.000Z", "buy", 2, 120),
      fill("3", "2026-01-03T00:00:00.000Z", "sell", 3, 130),
    ]);
    expect(summary).toMatchObject({ realizedProceeds: 390, realizedCostBasis: 320, realizedProfitLoss: 70, tradeCount: 3 });
    expect(summary.openLots).toEqual([{ symbol: "AAPL", quantity: 1, price: 120, acquiredAt: "2026-01-02T00:00:00.000Z" }]);
  });

  test("preserves total FIFO basis across an explicit forward split", () => {
    const split = normalizeActivity({ id: "split", activityType: "SPLIT", activitySubType: "FSPLIT", date: new Date("2026-01-02"), symbol: "AAPL", old_rate: "1", new_rate: "2" });
    const summary = ledgerSummary([
      fill("buy", "2026-01-01T00:00:00.000Z", "buy", 10, 100),
      split,
      fill("sell", "2026-01-03T00:00:00.000Z", "sell", 10, 60),
    ]);
    expect(summary).toMatchObject({ realizedProceeds: 600, realizedCostBasis: 500, realizedProfitLoss: 100, corporateActionsApplied: 1, unresolvedCorporateActions: [] });
  });

  test("moves FIFO lots across an explicit symbol change", () => {
    const change = normalizeActivity({ id: "rename", activityType: "NC", activitySubType: "SNC", date: new Date("2026-01-02"), symbol: "META", old_symbol: "FB", new_symbol: "META" });
    const buy = { ...fill("buy", "2026-01-01T00:00:00.000Z", "buy", 2, 200), symbol: "FB" };
    const sell = { ...fill("sell", "2026-01-03T00:00:00.000Z", "sell", 2, 250), symbol: "META" };
    expect(ledgerSummary([buy, change, sell])).toMatchObject({ realizedCostBasis: 400, realizedProfitLoss: 100, corporateActionsApplied: 1 });
  });

  test("applies broker-provided basis allocation for a spin-off", () => {
    const spin = normalizeActivity({
      id: "spin",
      activityType: "SPIN",
      activitySubType: "SSPIN",
      date: new Date("2026-01-02"),
      symbol: "PARENT",
      old_symbol: "PARENT",
      basis_allocations: [
        { symbol: "PARENT", quantity: "10", total_cost_basis: "800", acquired_at: "2026-01-01T00:00:00.000Z" },
        { symbol: "CHILD", quantity: "2", total_cost_basis: "200", acquired_at: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const buy = { ...fill("buy", "2026-01-01T00:00:00.000Z", "buy", 10, 100), symbol: "PARENT" };
    const sellChild = { ...fill("sell-child", "2026-01-03T00:00:00.000Z", "sell", 1, 150), symbol: "CHILD" };

    const summary = ledgerSummary([buy, spin, sellChild]);

    expect(summary).toMatchObject({ corporateActionsApplied: 1, unresolvedCorporateActions: [], realizedCostBasis: 100, realizedProfitLoss: 50 });
    expect(summary.openLots).toEqual([
      { symbol: "CHILD", quantity: 1, price: 100, acquiredAt: "2026-01-01T00:00:00.000Z" },
      { symbol: "PARENT", quantity: 10, price: 80, acquiredAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  test("regression: broker basis allocations do not create lots without source history", () => {
    const spin = normalizeActivity({
      id: "spin-missing-source",
      activityType: "SPIN",
      activitySubType: "SSPIN",
      date: new Date("2026-01-02"),
      symbol: "PARENT",
      old_symbol: "PARENT",
      basisAllocations: [
        { symbol: "PARENT", quantity: 10, totalCostBasis: 800 },
        { symbol: "CHILD", quantity: 2, totalCostBasis: 200 },
      ],
    });

    const summary = ledgerSummary([spin]);

    expect(summary).toMatchObject({ corporateActionsApplied: 0, openLots: [] });
    expect(summary.unresolvedCorporateActions).toEqual([{
      id: "spin-missing-source",
      type: "SPIN",
      subType: "SSPIN",
      symbol: "PARENT",
      reason: "Broker basis allocation has no imported source FIFO lots to replace.",
    }]);
    expect(summary.warnings).toContain("1 corporate action requires manual cost-basis review before relying on realized P&L.");
  });

  test("flags unsupported or incomplete corporate actions without guessing basis", () => {
    const split = normalizeActivity({ id: "split", activityType: "SPLIT", activitySubType: "RSPLIT", date: new Date("2026-01-02"), symbol: "AAPL" });
    const merger = normalizeActivity({ id: "merger", activityType: "MA", activitySubType: "SMA", date: new Date("2026-01-03"), symbol: "AAPL" });
    const summary = ledgerSummary([split, merger]);
    expect(summary).toMatchObject({ corporateActionsApplied: 0 });
    expect(summary.unresolvedCorporateActions).toHaveLength(2);
  });

  test("separates income, fees and transfers and reports incomplete cost basis", () => {
    const base = { subType: null, status: "executed", symbol: null, side: null, quantity: null, price: null, orderId: null } as const;
    const summary = ledgerSummary([
      { ...base, id: "d", type: "DIV", category: "dividend", occurredAt: "2026-01-01T00:00:00Z", amount: 10 },
      { ...base, id: "f", type: "FEE", category: "fee", occurredAt: "2026-01-01T00:00:01Z", amount: -2 },
      { ...base, id: "t", type: "CSD", category: "transfer", occurredAt: "2026-01-01T00:00:02Z", amount: 100 },
      fill("s", "2026-01-02T00:00:00Z", "sell", 1, 50),
    ], true);
    expect(summary).toMatchObject({ dividends: 10, feesPaid: 2, netTransfers: 100, totalCashImpact: 158 });
    expect(summary.warnings).toHaveLength(2);
  });

  test("persists broker activities idempotently", () => {
    const store = createStore(":memory:");
    const activity = fill("fill-1", "2026-01-01T00:00:00Z", "buy", 1, 100);
    store.syncActivities([activity]);
    store.syncActivities([{ ...activity, price: 101, amount: -101 }]);
    expect(store.activities()).toEqual([{ ...activity, price: 101, amount: -101, corporateAction: null }]);
    store.close();
  });

  test("persists corporate-action evidence", () => {
    const store = createStore(":memory:");
    const activity = normalizeActivity({ id: "split", activityType: "SPLIT", activitySubType: "FSPLIT", date: new Date("2026-01-02"), symbol: "AAPL", group_id: "group", old_qty: "10", new_qty: "20" });
    store.syncActivities([activity]);
    expect(store.activities()[0]).toEqual({ ...activity, corporateAction: activity.corporateAction ?? null });
    store.close();
  });
});
