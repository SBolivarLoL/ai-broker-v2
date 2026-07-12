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
      uncertainty: {
        status: "available",
        sampleSize: 40,
        totalReturnPercent: {
          lowerPercentile: -2,
          median: 4,
          upperPercentile: 9,
        },
      },
      initialCash: 10_000,
      points: [
        {
          timestamp: "2026-06-01T00:00:00.000Z",
          equity: 10_000,
          tradeNotional: 5_000,
        },
        {
          timestamp: "2026-06-02T00:00:00.000Z",
          equity: 10_500,
          tradeNotional: 0,
        },
        {
          timestamp: "2026-06-03T00:00:00.000Z",
          equity: 10_200,
          tradeNotional: -2_000,
        },
      ],
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
    comparisonVersion: "strategy-backtest-comparison-v2",
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
        decisionCounts: {
          evaluatedBars: 3,
          exposureIncreases: 1,
          exposureReductions: 1,
          unchanged: 1,
        },
        evaluation: {
          fullSampleUncertainty: {
            status: "available",
            lowerPercent: -2,
            medianPercent: 4,
            upperPercent: 9,
          },
        },
      },
      {
        backtestId: "bt-2",
        strategyId: "mean-reversion",
        metrics: { totalReturnPercent: 5 },
      },
    ],
    warnings: [],
    charts: { aligned: true },
  });
  expect(comparison.charts.series[0]?.backtestId).toBe("bt-1");
  expect(comparison.charts.series[0]?.points).toHaveLength(3);
  expect(comparison.charts.series[0]!.points[0]).toMatchObject({
    equityReturnPercent: 0,
    drawdownPercent: 0,
  });
  expect(
    comparison.charts.series[0]!.points[1]!.equityReturnPercent,
  ).toBeCloseTo(5, 8);
  expect(comparison.charts.series[0]!.points[2]!.timestamp).toBe(
    "2026-06-03T00:00:00.000Z",
  );
  expect(
    comparison.charts.series[0]!.points[2]!.drawdownPercent,
  ).toBeCloseTo(2.8571, 4);
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

test("strategy comparison rejects malformed uncertainty ranges", () => {
  const comparison = buildStrategyBacktestComparison({
    backtests: [
      backtest("bt-1", {
        innerResult: {
          uncertainty: {
            status: "available",
            sampleSize: 40,
            totalReturnPercent: {
              lowerPercentile: null,
              median: 4,
              upperPercentile: 2,
            },
          },
        },
      }),
      backtest("bt-2"),
    ],
  });

  expect(comparison.rows[0]!.evaluation.fullSampleUncertainty).toMatchObject({
    status: "unavailable",
    lowerPercent: null,
    medianPercent: null,
    upperPercent: null,
    reason: "Uncertainty range is malformed.",
  });
  expect(
    comparison.rows[0]!.promotionReadiness.blockers.map(
      (blocker) => blocker.code,
    ),
  ).toContain("uncertainty_insufficient");
});

test("strategy comparison bounds aligned charts and exposes OOS promotion evidence", () => {
  const points = Array.from({ length: 240 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    equity: 10_000 + index * 5 - (index % 17) * 8,
    tradeNotional: index % 3 === 0 ? 100 : index % 3 === 1 ? -50 : 0,
  }));
  const walkForwardEvaluation = {
    mode: "anchored",
    aggregate: {
      foldCount: 4,
      testBars: 80,
      compoundedOutOfSampleReturnPercent: 3.5,
      worstOutOfSampleDrawdownPercent: 2.1,
      uncertainty: {
        status: "available",
        sampleSize: 80,
        reason: "Available",
        totalReturnPercent: {
          lowerPercentile: -1,
          median: 3.2,
          upperPercentile: 7,
        },
      },
    },
    finalHoldout: {
      test: {
        bars: 20,
        start: "2026-06-01T00:00:00Z",
        end: "2026-06-02T00:00:00Z",
      },
      testResult: {
        totalReturnPercent: 1.2,
        maxDrawdownPercent: 0.8,
        uncertainty: {
          status: "available",
          sampleSize: 20,
          reason: "Available",
          totalReturnPercent: {
            lowerPercentile: -0.5,
            median: 1.1,
            upperPercentile: 2.6,
          },
        },
      },
    },
    leakageChecks: { allPassed: true },
  };
  const comparison = buildStrategyBacktestComparison({
    backtests: [
      backtest("bt-1", {
        innerResult: { points },
        result: { walkForwardEvaluation },
      }),
      backtest("bt-2", {
        innerResult: { points },
        result: { walkForwardEvaluation },
      }),
    ],
  });

  expect(comparison.charts).toMatchObject({
    aligned: true,
    maxPointsPerSeries: 160,
  });
  expect(comparison.charts.series[0]?.points).toHaveLength(160);
  expect(comparison.charts.series[0]?.points[0]?.timestamp).toBe(
    points[0]!.timestamp,
  );
  expect(comparison.charts.series[0]?.points.at(-1)?.timestamp).toBe(
    points.at(-1)!.timestamp,
  );
  expect(comparison.rows[0]).toMatchObject({
    decisionCounts: {
      evaluatedBars: 240,
      exposureIncreases: 80,
      exposureReductions: 80,
      unchanged: 80,
      materialTrades: 160,
    },
    evaluation: {
      outOfSample: {
        status: "available",
        mode: "anchored",
        foldCount: 4,
        testBars: 80,
        totalReturnPercent: 3.5,
        uncertainty: {
          status: "available",
          lowerPercent: -1,
          medianPercent: 3.2,
          upperPercent: 7,
        },
        holdout: { bars: 20, totalReturnPercent: 1.2 },
        leakageChecksPassed: true,
      },
    },
    promotionReadiness: {
      status: "blocked",
      blockers: [{ code: "paper_evidence_required" }],
    },
  });
});
