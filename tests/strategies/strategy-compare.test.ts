import { expect, test } from "bun:test";
import { buildStrategyBacktestComparison } from "../../backend/features/strategies/strategy-compare";
import {
  canonicalHash,
  STRATEGY_FEATURE_SCHEMA_VERSION,
} from "../../backend/features/strategies/strategy-provenance";

const definitionHash = canonicalHash({
  symbols: ["BTC/USD"],
  strategyId: "moving-average-trend",
  params: { fast: 5, slow: 20, exposure: 1 },
  timeframe: "1Hour",
  days: 30,
});
const provenance = {
  gitCommit: "a".repeat(40),
  workingTreeDirty: false,
  pluginVersion: "strategy-plugin-v1",
  featureSchemaVersion: STRATEGY_FEATURE_SCHEMA_VERSION,
  policyVersion: "crypto-backtest-v1",
  definitionHash,
  provider: "Alpaca Market Data API",
  feed: "us",
  query: {
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-07-01T00:00:00.000Z",
    timeframe: "1Hour",
    symbols: ["BTC/USD"],
  },
  datasetHash: `sha256:${"b".repeat(64)}`,
};

function backtest(id: string, overrides: Record<string, any> = {}) {
  const request = {
    strategyId: "moving-average-trend",
    symbols: ["BTC/USD"],
    params: { fast: 5, slow: 20, exposure: 1 },
    timeframe: "1Hour",
    days: 30,
    initialCash: 10_000,
    feeBps: 0,
    slippageBps: 5,
    ...overrides.request,
  };
  const baselines = overrides.baselineSet ?? {
    cash: { totalReturnPercent: 0, maxDrawdownPercent: 0 },
    buyAndHold: { totalReturnPercent: 2, maxDrawdownPercent: 2 },
    ...overrides.baselines,
  };
  const result = {
    result: {
      strategyId: request.strategyId,
      totalReturnPercent: 4,
      maxDrawdownPercent: 1,
      exposureTimePercent: 75,
      turnover: 1.5,
      assumptions: {
        feeBps: request.feeBps,
        slippageBps: request.slippageBps,
        execution: "close",
      },
      tradeMetrics: {
        tradeCount: 3,
        profitFactor: 1.8,
        sortinoRatio: 1.2,
        calmarRatio: 2,
      },
      uncertainty: { status: "available" },
      ...overrides.innerResult,
    },
    baselines,
    start: provenance.query.start,
    end: provenance.query.end,
    timeframe: provenance.query.timeframe,
    symbols: provenance.query.symbols,
    ...overrides.result,
  };
  return {
    id,
    strategyId: request.strategyId,
    request,
    result,
    provenance: { ...provenance, ...overrides.provenance },
    comparable: overrides.comparable ?? true,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

test("strategy comparison marks a matched cohort as compatible", () => {
  const comparison = buildStrategyBacktestComparison({
    generatedAt: "2026-07-01T12:00:00.000Z",
    backtests: [
      backtest("bt-1"),
      backtest("bt-2", {
        request: {
          strategyId: "mean-reversion",
          params: { lookback: 20, entryZ: 2, exitZ: 0.5, exposure: 1 },
        },
        innerResult: { strategyId: "mean-reversion", totalReturnPercent: 5 },
      }),
    ],
  });

  expect(comparison).toMatchObject({
    comparisonVersion: "strategy-backtest-comparison-v1",
    compatible: true,
    compatibility: { allPassed: true },
    backtestIds: ["bt-1", "bt-2"],
    rows: [
      {
        backtestId: "bt-1",
        metrics: {
          totalReturnPercent: 4,
          sortino: 1.2,
          calmar: 2,
        },
        baselines: { cash: { totalReturnPercent: 0 } },
      },
      {
        backtestId: "bt-2",
        strategyId: "mean-reversion",
        metrics: { totalReturnPercent: 5 },
      },
    ],
    warnings: [],
  });
  expect(comparison.compatibility.checks.map((check) => check.status)).toEqual([
    "pass",
    "pass",
    "pass",
    "pass",
    "pass",
  ]);
});

test("strategy comparison warns on incompatible period dataset friction and baselines", () => {
  const comparison = buildStrategyBacktestComparison({
    backtests: [
      backtest("bt-1"),
      backtest("bt-2", {
        request: { slippageBps: 25 },
        baselineSet: { cash: { totalReturnPercent: 0, maxDrawdownPercent: 0 } },
        provenance: {
          datasetHash: `sha256:${"c".repeat(64)}`,
          query: { ...provenance.query, start: "2026-06-02T00:00:00.000Z" },
        },
        comparable: false,
      }),
    ],
  });

  expect(comparison.compatible).toBe(false);
  expect(comparison.compatibility.allPassed).toBe(false);
  expect(
    comparison.compatibility.checks
      .filter((check) => check.status === "warning")
      .map((check) => check.name),
  ).toEqual(["period", "dataset", "friction_model", "baselines"]);
  expect(comparison.warnings).toEqual(
    expect.arrayContaining([
      expect.stringContaining("different periods"),
      expect.stringContaining("different dataset hashes"),
      expect.stringContaining("different initial cash"),
      expect.stringContaining("same baseline set"),
      expect.stringContaining("dirty or legacy evidence"),
    ]),
  );
});
