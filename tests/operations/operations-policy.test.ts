import { expect, test } from "bun:test";
import { DEFAULT_OPERATIONS_POLICY, evaluateOperationsPolicy, evaluatePortfolioPolicy, parseOperationsPolicy } from "../../backend/features/operations/operations-policy";

test("blocks all order intents when the global kill switch is active", () => {
  const result = evaluateOperationsPolicy({
    policy: { globalKillSwitch: { active: true, reason: "broker incident", activatedAt: "2026-06-25T10:00:00.000Z", activatedBy: "risk" } },
    order: { assetClass: "equity", symbol: "AAPL", side: "buy", qty: 1, price: 200 },
    account: { equity: 25_000 },
  });

  expect(result.allowed).toBe(false);
  expect(result.reasons).toEqual(["global_kill_switch"]);
  expect(result.runbook.join(" ")).toContain("review open orders");
  expect(result.evidence.killSwitch).toMatchObject({ active: true, reason: "broker incident" });
});

test("enforces order, symbol exposure and portfolio exposure caps", () => {
  const policy = parseOperationsPolicy({
    maxOrderNotional: 500,
    maxSymbolExposureNotional: 1_000,
    maxPortfolioExposurePercent: 10,
    maxDailyTurnoverPercent: 100,
  });

  expect(evaluateOperationsPolicy({
    policy,
    order: { assetClass: "equity", symbol: "NVDA", side: "buy", qty: 3, price: 300 },
    account: { equity: 8_000 },
    positions: [{ symbol: "NVDA", qty: 1, marketValue: 300 }],
  })).toMatchObject({
    allowed: false,
    reasons: ["max_order_notional", "max_symbol_exposure", "max_portfolio_exposure"],
    evidence: { estimatedNotional: 900, resultingSymbolExposure: 1_200, resultingPortfolioExposurePercent: 15 },
  });
});

test("includes pending orders in turnover and exposure evidence", () => {
  const result = evaluateOperationsPolicy({
    policy: { ...DEFAULT_OPERATIONS_POLICY, maxDailyTurnoverPercent: 10, maxPortfolioExposurePercent: 50 },
    order: { assetClass: "crypto", symbol: "BTC/USD", side: "buy", notional: 300 },
    account: { equity: 5_000 },
    positions: [{ symbol: "BTCUSD", qty: 0.01, marketValue: 500 }],
    dailyTurnover: 150,
    pendingOrders: [{ symbol: "BTC/USD", side: "buy", qty: 0.002, price: 50_000 }],
  });

  expect(result.allowed).toBe(false);
  expect(result.reasons).toEqual(["max_daily_turnover"]);
  expect(result.evidence).toMatchObject({
    currentSymbolExposure: 500,
    pendingSymbolExposure: 100,
    resultingSymbolExposure: 900,
    dailyTurnoverPercent: 11,
  });
});

test("allows sell orders that reduce existing exposure even when caps are tight", () => {
  const result = evaluateOperationsPolicy({
    policy: { maxOrderNotional: 100, maxSymbolExposureNotional: 200, maxPortfolioExposurePercent: 5, maxDailyTurnoverPercent: 1 },
    order: { assetClass: "equity", symbol: "TSLA", side: "sell", qty: 3, price: 100 },
    account: { equity: 10_000 },
    positions: [{ symbol: "TSLA", qty: 10, marketValue: 1_000 }],
    dailyTurnover: 5_000,
  });

  expect(result).toMatchObject({ allowed: true, reasons: [], evidence: { reducesExposure: true, resultingSymbolExposure: 700 } });
});

test("evaluates portfolio position sector drawdown and turnover caps", () => {
  expect(() => parseOperationsPolicy({ maxSectorExposurePercent: 101 })).toThrow();
  const policy = parseOperationsPolicy({
    maxPortfolioExposurePercent: 25,
    maxSectorExposurePercent: 50,
    maxDrawdownPercent: 8,
    maxDailyTurnoverPercent: 10,
  });
  const result = evaluatePortfolioPolicy({
    policy,
    equity: 100_000,
    positions: [
      { symbol: "AAPL", marketValue: 30_000, sector: "Manufacturing" },
      { symbol: "MSFT", marketValue: 25_000, sector: "Manufacturing" },
      { symbol: "JPM", marketValue: 15_000, sector: "Finance, insurance and real estate" },
    ],
    drawdownPercent: 9,
    dailyTurnover: 12_000,
  });

  expect(result.allowed).toBe(false);
  expect(result.reasons).toEqual(["max_position_limit", "max_sector_limit", "max_drawdown_limit", "max_daily_turnover"]);
  expect(result.runbook.join(" ")).toContain("Reduce the order size or exposure");
  expect(result.evidence).toMatchObject({
    largestPositionSymbol: "AAPL",
    largestPositionPercent: 30,
    largestSector: "Manufacturing",
    drawdownPercent: 9,
    dailyTurnoverPercent: 12,
  });
  expect(result.evidence.largestSectorPercent).toBeCloseTo(55);
});
