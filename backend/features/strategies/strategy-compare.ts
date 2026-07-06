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
    slippageBps: Number(assumptions.slippageBps ?? backtest.request?.slippageBps),
    execution: assumptions.execution ?? null,
  };
}

function compatibilityCheck(
  name: string,
  values: string[],
  warning: string,
) {
  const distinct = unique(values);
  return {
    name,
    status: distinct.length <= 1 ? "pass" as const : "warning" as const,
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
    sortino: result.tradeMetrics?.sortino ?? null,
    calmar: result.tradeMetrics?.calmar ?? null,
    uncertaintyStatus: result.uncertainty?.status ?? null,
  };
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
          start: compactDate(backtest.provenance?.query?.start ?? backtest.result?.start),
          end: compactDate(backtest.provenance?.query?.end ?? backtest.result?.end),
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
      backtests.map((backtest) => String(backtest.provenance?.datasetHash ?? "")),
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
  const rows = backtests.map((backtest) => {
    const baselines = backtest.result?.baselines ?? {};
    return {
      backtestId: backtest.id,
      strategyId: backtest.strategyId,
      params: backtest.request?.params ?? {},
      createdAt: backtest.createdAt ?? null,
      comparable: Boolean(backtest.comparable),
      metrics: metric(backtest),
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
              backtest.result.walkForwardEvaluation.aggregate?.foldCount ?? null,
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
    comparisonVersion: "strategy-backtest-comparison-v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    backtestIds: rows.map((row) => row.backtestId),
    compatible: !warnings.length,
    compatibility: {
      allPassed: !warnings.length,
      checks,
    },
    cohortKey: {
      period: checks[0]!.distinctValues.length === 1 ? checks[0]!.distinctValues[0] : null,
      datasetHash: checks[1]!.distinctValues.length === 1 ? checks[1]!.distinctValues[0] : null,
      frictionModel: checks[2]!.distinctValues.length === 1 ? checks[2]!.distinctValues[0] : null,
      baselines: checks[3]!.distinctValues.length === 1 ? checks[3]!.distinctValues[0] : null,
    },
    rows,
    warnings,
  };
}
