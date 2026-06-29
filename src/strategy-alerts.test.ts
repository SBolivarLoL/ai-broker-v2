import { expect, test } from "bun:test";
import { buildStrategyAlerts } from "./strategy-alerts";

const run = {
  id: "run-1",
  strategyId: "moving-average-trend",
  status: "paper" as const,
  symbols: ["BTC/USD"],
  budget: 250,
  config: { paperApproval: { budget: 250 }, alerts: { drawdownPercent: 8, dailyTurnoverPercent: 40, slippageBps: 25, repeatedSlippageCount: 2, reconciliationAgeMs: 60_000 } },
};

test("builds strategy alerts from stale data, errors, rejected orders and drawdown", () => {
  const result = buildStrategyAlerts({
    run,
    generatedAt: "2026-06-24T12:00:00.000Z",
    decisions: [
      { traceId: "trace-stale", decision: "block", reason: "stale", riskChecks: { reasons: ["stale_data"] }, orderOutcome: "none", createdAt: "2026-06-24T11:59:00.000Z" },
      { traceId: "trace-reject", decision: "block", reason: "broker", riskChecks: { reasons: ["broker_order_rejected"] }, orderOutcome: "rejected", createdAt: "2026-06-24T11:58:00.000Z" },
    ],
    traces: [{ traceId: "trace-stale", snapshots: [{ stale: true }, { stale: false }] }],
    orders: [{ paperOrderId: "paper-rejected", status: "rejected", payload: {}, createdAt: "2026-06-24T11:58:00.000Z", updatedAt: "2026-06-24T11:58:00.000Z" }],
    metrics: [{ name: "strategy_error_count", value: 1, unit: "count", asOf: "2026-06-24T11:58:00.000Z" }],
    performance: { summary: { status: "available", maxDrawdownPercent: 12 } },
  });
  expect(result.alerts.map(alert => alert.code)).toEqual(["rejected_order", "stale_feed", "strategy_exception", "drawdown_breach"]);
  expect(result.alerts.filter(alert => alert.severity === "critical").map(alert => alert.code)).toContain("strategy_exception");
});

test("detects runaway turnover, repeated slippage and reconciliation drift", () => {
  const result = buildStrategyAlerts({
    run,
    generatedAt: "2026-06-24T12:00:00.000Z",
    orders: [
      { paperOrderId: "paper-1", status: "filled", payload: { side: "buy", notional: 80, referencePrice: 100, broker: { status: "filled", filledAvgPrice: 100.5 } }, createdAt: "2026-06-24T10:00:00.000Z", updatedAt: "2026-06-24T10:01:00.000Z" },
      { paperOrderId: "paper-2", status: "filled", payload: { side: "buy", notional: 70, referencePrice: 100, broker: { status: "filled", filledAvgPrice: 100.4 } }, createdAt: "2026-06-24T11:00:00.000Z", updatedAt: "2026-06-24T11:01:00.000Z" },
      { paperOrderId: "paper-drift", status: "accepted", payload: { broker: { status: "filled" } }, createdAt: "2026-06-24T11:30:00.000Z", updatedAt: "2026-06-24T11:30:00.000Z" },
    ],
  });
  expect(result.alerts.map(alert => alert.code)).toEqual(["reconciliation_drift", "repeated_slippage", "runaway_turnover"]);
  expect(result.alerts.find(alert => alert.code === "runaway_turnover")?.evidence).toMatchObject({ turnoverPercent: 60, orderCount: 3 });
});

test("returns no alerts when evidence is inside thresholds", () => {
  const result = buildStrategyAlerts({
    run: { ...run, config: { paperApproval: { budget: 250 } } },
    generatedAt: "2026-06-24T12:00:00.000Z",
    decisions: [{ traceId: "trace-ok", decision: "hold", reason: "ok", riskChecks: { reasons: [] }, orderOutcome: "none", createdAt: "2026-06-24T11:59:00.000Z" }],
    traces: [{ traceId: "trace-ok", snapshots: [{ stale: false }] }],
    orders: [],
    metrics: [],
    performance: { summary: { status: "available", maxDrawdownPercent: 2 } },
  });
  expect(result.alerts).toEqual([]);
});
