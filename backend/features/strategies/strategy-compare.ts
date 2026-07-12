/** Builds an apples-to-apples comparison view for immutable strategy backtests. */

type StrategyBacktestRecord = {
  id: string;
  strategyId: string;
  request: any;
  result: any;
  provenance: any;
  comparable?: boolean;
  createdAt?: string;
};

const MAX_CHART_POINTS = 160;
type ComparisonChartPoint = {
  timestamp: string;
  equityReturnPercent: number;
  drawdownPercent: number;
};

const unique = (values: string[]) => [...new Set(values)].sort();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function compactDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function baselineSet(backtest: StrategyBacktestRecord) {
  return Object.keys(backtest.result?.baselines ?? {}).sort();
}

function frictionModel(backtest: StrategyBacktestRecord) {
  const assumptions = backtest.result?.result?.assumptions ?? {};
  return {
    initialCash: Number(backtest.request?.initialCash),
    feeBps: Number(assumptions.feeBps ?? backtest.request?.feeBps),
    slippageBps: Number(
      assumptions.slippageBps ?? backtest.request?.slippageBps,
    ),
    execution: assumptions.execution ?? null,
  };
}

function compatibilityCheck(name: string, values: string[], warning: string) {
  const distinct = unique(values);
  return {
    name,
    status: distinct.length <= 1 ? ("pass" as const) : ("warning" as const),
    distinctValues: distinct,
    warning: distinct.length <= 1 ? null : warning,
  };
}

function metric(backtest: StrategyBacktestRecord) {
  const result = backtest.result?.result ?? {};
  return {
    totalReturnPercent: result.totalReturnPercent ?? null,
    maxDrawdownPercent: result.maxDrawdownPercent ?? null,
    exposureTimePercent: result.exposureTimePercent ?? null,
    turnover: result.turnover ?? null,
    tradeCount: result.tradeMetrics?.tradeCount ?? null,
    profitFactor: result.tradeMetrics?.profitFactor ?? null,
    sortino: result.tradeMetrics?.sortinoRatio ?? null,
    calmar: result.tradeMetrics?.calmarRatio ?? null,
    uncertaintyStatus: result.uncertainty?.status ?? null,
  };
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decisionCounts(backtest: StrategyBacktestRecord) {
  const points = Array.isArray(backtest.result?.result?.points)
    ? backtest.result.result.points
    : [];
  let increase = 0;
  let reduce = 0;
  let unchanged = 0;
  for (const point of points) {
    const tradeNotional = finite(point?.tradeNotional);
    if (tradeNotional === null || Math.abs(tradeNotional) <= 1e-9) unchanged++;
    else if (tradeNotional > 0) increase++;
    else reduce++;
  }
  return {
    evaluatedBars: points.length,
    exposureIncreases: increase,
    exposureReductions: reduce,
    unchanged,
    materialTrades: increase + reduce,
  };
}

function uncertaintyBand(uncertainty: any) {
  const range = uncertainty?.totalReturnPercent;
  const lowerPercent = finite(range?.lowerPercentile);
  const medianPercent = finite(range?.median);
  const upperPercent = finite(range?.upperPercentile);
  const validRange =
    lowerPercent !== null &&
    medianPercent !== null &&
    upperPercent !== null &&
    lowerPercent <= medianPercent &&
    medianPercent <= upperPercent;
  if (uncertainty?.status !== "available" || !validRange)
    return {
      status:
        uncertainty?.status === "available"
          ? "unavailable"
          : (uncertainty?.status ?? "unavailable"),
      sampleSize: finite(uncertainty?.sampleSize),
      lowerPercent: null,
      medianPercent: null,
      upperPercent: null,
      rankingUse: "not_rankable" as const,
      reason:
        uncertainty?.reason ??
        (uncertainty?.status === "available"
          ? "Uncertainty range is malformed."
          : "Uncertainty evidence is unavailable."),
    };
  return {
    status: "available" as const,
    sampleSize: finite(uncertainty.sampleSize),
    lowerPercent,
    medianPercent,
    upperPercent,
    rankingUse: "not_rankable" as const,
    reason: uncertainty.reason ?? null,
  };
}

function outOfSampleEvidence(backtest: StrategyBacktestRecord) {
  const evaluation = backtest.result?.walkForwardEvaluation;
  if (!evaluation)
    return {
      status: "not_run" as const,
      mode: null,
      foldCount: 0,
      testBars: 0,
      totalReturnPercent: null,
      maxDrawdownPercent: null,
      uncertainty: uncertaintyBand(null),
      holdout: null,
      leakageChecksPassed: false,
    };
  const aggregate = evaluation.aggregate ?? {};
  const holdout = evaluation.finalHoldout;
  return {
    status: "available" as const,
    mode: evaluation.mode ?? null,
    foldCount: finite(aggregate.foldCount) ?? 0,
    testBars: finite(aggregate.testBars) ?? 0,
    totalReturnPercent: finite(aggregate.compoundedOutOfSampleReturnPercent),
    maxDrawdownPercent: finite(aggregate.worstOutOfSampleDrawdownPercent),
    uncertainty: uncertaintyBand(aggregate.uncertainty),
    holdout: holdout
      ? {
          bars: finite(holdout.test?.bars) ?? 0,
          start: compactDate(holdout.test?.start),
          end: compactDate(holdout.test?.end),
          totalReturnPercent: finite(holdout.testResult?.totalReturnPercent),
          maxDrawdownPercent: finite(holdout.testResult?.maxDrawdownPercent),
          uncertainty: uncertaintyBand(holdout.testResult?.uncertainty),
        }
      : null,
    leakageChecksPassed: evaluation.leakageChecks?.allPassed === true,
  };
}

function chartPoints(
  backtest: StrategyBacktestRecord,
): ComparisonChartPoint[] {
  const result = backtest.result?.result ?? {};
  const initialCash = finite(result.initialCash ?? backtest.request?.initialCash);
  const points: any[] = Array.isArray(result.points) ? result.points : [];
  let peak = initialCash && initialCash > 0 ? initialCash : null;
  return points.flatMap((point: any): ComparisonChartPoint[] => {
    const timestamp = compactDate(point?.timestamp);
    const equity = finite(point?.equity);
    if (!timestamp || equity === null || equity <= 0 || !initialCash || initialCash <= 0)
      return [];
    peak = Math.max(peak ?? equity, equity);
    return [{
      timestamp,
      equityReturnPercent: (equity / initialCash - 1) * 100,
      drawdownPercent: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
    }];
  });
}

function sampleIndexes(length: number) {
  if (length <= MAX_CHART_POINTS)
    return Array.from({ length }, (_, index) => index);
  return Array.from({ length: MAX_CHART_POINTS }, (_, index) =>
    Math.round((index * (length - 1)) / (MAX_CHART_POINTS - 1)),
  );
}

function chartEvidence(backtests: StrategyBacktestRecord[]) {
  const allPoints = backtests.map(chartPoints);
  const referenceTimes = allPoints[0]?.map((point) => point.timestamp) ?? [];
  const aligned =
    referenceTimes.length > 1 &&
    allPoints.every(
      (points) =>
        points.length === referenceTimes.length &&
        points.every((point, index) => point.timestamp === referenceTimes[index]),
    );
  const sharedIndexes = aligned ? sampleIndexes(referenceTimes.length) : null;
  return {
    aligned,
    maxPointsPerSeries: MAX_CHART_POINTS,
    alignmentReason: aligned
      ? null
      : "Backtest equity observations do not share one exact timestamp sequence; chart lines must not be read as aligned comparisons.",
    series: backtests.map((backtest, index) => {
      const points = allPoints[index] ?? [];
      const indexes = sharedIndexes ?? sampleIndexes(points.length);
      return {
        backtestId: backtest.id,
        strategyId: backtest.strategyId,
        points: indexes.map((pointIndex) => points[pointIndex]!).filter(Boolean),
      };
    }),
  };
}

function promotionReadiness(
  backtest: StrategyBacktestRecord,
  compatible: boolean,
  outOfSample: ReturnType<typeof outOfSampleEvidence>,
) {
  const result = backtest.result?.result ?? {};
  const capacityWarnings = Array.isArray(result.tradeMetrics?.capacityWarnings)
    ? result.tradeMetrics.capacityWarnings.map(String)
    : [];
  const blockers = [
    !compatible
      ? {
          code: "cohort_incompatible",
          severity: "blocking" as const,
          message:
            "Cohort compatibility or artifact provenance is not clean enough for comparative ranking.",
        }
      : null,
    !backtest.comparable
      ? {
          code: "artifact_not_comparable",
          severity: "blocking" as const,
          message: "The backtest has dirty or legacy provenance.",
        }
      : null,
    outOfSample.status !== "available"
      ? {
          code: "walk_forward_missing",
          severity: "blocking" as const,
          message: "No walk-forward out-of-sample evaluation is attached.",
        }
      : null,
    outOfSample.status === "available" && !outOfSample.holdout
      ? {
          code: "final_holdout_missing",
          severity: "blocking" as const,
          message: "No final untouched holdout is attached.",
        }
      : null,
    outOfSample.status === "available" && !outOfSample.leakageChecksPassed
      ? {
          code: "leakage_checks_failed",
          severity: "blocking" as const,
          message: "Walk-forward leakage checks are incomplete or failed.",
        }
      : null,
    uncertaintyBand(result.uncertainty).status !== "available"
      ? {
          code: "uncertainty_insufficient",
          severity: "evidence" as const,
          message:
            "Full-period bootstrap uncertainty is unavailable or insufficient.",
        }
      : null,
    outOfSample.status === "available" &&
    outOfSample.uncertainty.status !== "available"
      ? {
          code: "out_of_sample_uncertainty_insufficient",
          severity: "evidence" as const,
          message:
            "Walk-forward out-of-sample uncertainty is unavailable or insufficient.",
        }
      : null,
    ...capacityWarnings.map((message: string) => ({
      code: "capacity_warning",
      severity: "evidence" as const,
      message,
    })),
    {
      code: "paper_evidence_required",
      severity: "blocking" as const,
      message:
        "Promotion still requires a pre-registered protocol, at least 30 paper days, enough decisions, and at least 20 filled paper orders.",
    },
  ].filter(Boolean) as {
    code: string;
    severity: "blocking" | "evidence";
    message: string;
  }[];
  return { status: "blocked" as const, blockers };
}

export function buildStrategyBacktestComparison(input: {
  backtests: StrategyBacktestRecord[];
  generatedAt?: string;
}) {
  if (input.backtests.length < 2 || input.backtests.length > 20)
    throw new Error("Compare between 2 and 20 strategy backtests");
  const backtests = input.backtests;
  const checks = [
    compatibilityCheck(
      "period",
      backtests.map((backtest) =>
        stable({
          start: compactDate(
            backtest.provenance?.query?.start ?? backtest.result?.start,
          ),
          end: compactDate(
            backtest.provenance?.query?.end ?? backtest.result?.end,
          ),
          timeframe:
            backtest.provenance?.query?.timeframe ?? backtest.result?.timeframe,
          symbols:
            backtest.provenance?.query?.symbols ?? backtest.result?.symbols,
        }),
      ),
      "Backtests use different periods, timeframes, or symbols; compare metrics are not directly compatible.",
    ),
    compatibilityCheck(
      "dataset",
      backtests.map((backtest) =>
        String(backtest.provenance?.datasetHash ?? ""),
      ),
      "Backtests use different dataset hashes; provider history, corrections, or query inputs differ.",
    ),
    compatibilityCheck(
      "friction_model",
      backtests.map((backtest) => stable(frictionModel(backtest))),
      "Backtests use different initial cash, fee, slippage, or execution assumptions.",
    ),
    compatibilityCheck(
      "baselines",
      backtests.map((backtest) => stable(baselineSet(backtest))),
      "Backtests do not expose the same baseline set.",
    ),
    compatibilityCheck(
      "code_and_provider",
      backtests.map((backtest) =>
        stable({
          gitCommit: backtest.provenance?.gitCommit,
          pluginVersion: backtest.provenance?.pluginVersion,
          featureSchemaVersion: backtest.provenance?.featureSchemaVersion,
          policyVersion: backtest.provenance?.policyVersion,
          provider: backtest.provenance?.provider,
          feed: backtest.provenance?.feed,
        }),
      ),
      "Backtests were produced under different code, policy, provider, or feed identities.",
    ),
  ];
  const incomparable = backtests.some((backtest) => !backtest.comparable);
  const warnings = [
    ...checks.map((check) => check.warning).filter(Boolean),
    incomparable
      ? "One or more backtests came from dirty or legacy evidence and cannot seed a comparable cohort."
      : null,
  ].filter(Boolean) as string[];
  const compatible = !warnings.length;
  const rows = backtests.map((backtest) => {
    const baselines = backtest.result?.baselines ?? {};
    const outOfSample = outOfSampleEvidence(backtest);
    return {
      backtestId: backtest.id,
      strategyId: backtest.strategyId,
      params: backtest.request?.params ?? {},
      createdAt: backtest.createdAt ?? null,
      comparable: Boolean(backtest.comparable),
      metrics: metric(backtest),
      decisionCounts: decisionCounts(backtest),
      evaluation: {
        fullSampleUncertainty: uncertaintyBand(
          backtest.result?.result?.uncertainty,
        ),
        outOfSample,
      },
      promotionReadiness: promotionReadiness(
        backtest,
        compatible,
        outOfSample,
      ),
      baselines: Object.fromEntries(
        baselineSet(backtest).map((name) => [
          name,
          {
            totalReturnPercent: baselines[name]?.totalReturnPercent ?? null,
            maxDrawdownPercent: baselines[name]?.maxDrawdownPercent ?? null,
          },
        ]),
      ),
      walkForward: backtest.result?.walkForwardEvaluation
        ? {
            foldCount:
              backtest.result.walkForwardEvaluation.aggregate?.foldCount ??
              null,
            testBars:
              backtest.result.walkForwardEvaluation.aggregate?.testBars ?? null,
            totalReturnPercent:
              backtest.result.walkForwardEvaluation.aggregate
                ?.totalReturnPercent ?? null,
          }
        : null,
    };
  });
  return {
    comparisonVersion: "strategy-backtest-comparison-v2",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    backtestIds: rows.map((row) => row.backtestId),
    compatible,
    compatibility: {
      allPassed: !warnings.length,
      checks,
    },
    cohortKey: {
      period:
        checks[0]!.distinctValues.length === 1
          ? checks[0]!.distinctValues[0]
          : null,
      datasetHash:
        checks[1]!.distinctValues.length === 1
          ? checks[1]!.distinctValues[0]
          : null,
      frictionModel:
        checks[2]!.distinctValues.length === 1
          ? checks[2]!.distinctValues[0]
          : null,
      baselines:
        checks[3]!.distinctValues.length === 1
          ? checks[3]!.distinctValues[0]
          : null,
    },
    rows,
    charts: chartEvidence(backtests),
    warnings,
  };
}
