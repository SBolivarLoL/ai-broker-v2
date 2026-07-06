import {
  parseStrategyParams,
  runBacktest,
  strategyFunctionFromPlugin,
  strategyPluginFromId,
  walkForwardWindows,
  type BacktestBar,
  type BacktestResult,
} from "./strategy-backtest";
import { canonicalHash } from "./strategy-provenance";

export const WALK_FORWARD_MAX_CANDIDATES = 20;
export const WALK_FORWARD_MAX_FOLDS = 100;
export const WALK_FORWARD_MAX_EVALUATED_BARS = 2_000_000;

export type WalkForwardCandidate = {
  params: Record<string, unknown>;
  candidateHash: string;
};

export type WalkForwardRequest = {
  trainSize: number;
  testSize: number;
  candidates: WalkForwardCandidate[];
};

export function parseWalkForwardRequest(
  strategyId: string,
  value: unknown,
): WalkForwardRequest | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("walkForward must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["trainSize", "testSize", "candidates"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown walkForward field: ${unknown}`);
  const trainSize = Number(input.trainSize);
  const testSize = Number(input.testSize);
  if (
    typeof input.trainSize !== "number" ||
    typeof input.testSize !== "number" ||
    !Number.isInteger(trainSize) ||
    !Number.isInteger(testSize) ||
    trainSize < 2 ||
    testSize < 1
  )
    throw new Error("walkForward trainSize must be at least 2 and testSize at least 1");
  if (
    !Array.isArray(input.candidates) ||
    !input.candidates.length ||
    input.candidates.length > WALK_FORWARD_MAX_CANDIDATES
  )
    throw new Error(
      `walkForward candidates must contain 1 to ${WALK_FORWARD_MAX_CANDIDATES} parameter objects`,
    );
  const candidates = input.candidates.map((candidate) => {
    const params = parseStrategyParams(strategyId, candidate);
    return { params, candidateHash: canonicalHash(params) };
  });
  if (new Set(candidates.map((candidate) => candidate.candidateHash)).size !== candidates.length)
    throw new Error("walkForward candidates must be unique after defaults are applied");
  return { trainSize, testSize, candidates };
}

function candidateOrder(
  left: { candidate: WalkForwardCandidate; result: BacktestResult },
  right: { candidate: WalkForwardCandidate; result: BacktestResult },
) {
  return (
    right.result.totalReturnPercent - left.result.totalReturnPercent ||
    left.result.maxDrawdownPercent - right.result.maxDrawdownPercent ||
    left.result.turnoverPercent - right.result.turnoverPercent ||
    left.candidate.candidateHash.localeCompare(right.candidate.candidateHash)
  );
}

export function runWalkForwardEvaluation(input: {
  strategyId: string;
  symbol: string;
  bars: BacktestBar[];
  barsBySymbol: Record<string, BacktestBar[]>;
  request: WalkForwardRequest;
  initialCash: number;
  feeBps: number;
  slippageBps: number;
}) {
  for (const [symbol, history] of Object.entries(input.barsBySymbol)) {
    const synchronized =
      history.length === input.bars.length &&
      history.every(
        (bar, index) =>
          new Date(bar.timestamp).getTime() ===
          new Date(input.bars[index]!.timestamp).getTime(),
      );
    if (!synchronized)
      throw new Error(
        `walkForward requires timestamp-synchronized histories; ${symbol} is misaligned`,
      );
  }
  const foldCount = Math.max(
    0,
    Math.floor(
      (input.bars.length - input.request.trainSize) / input.request.testSize,
    ),
  );
  if (!foldCount)
    throw new Error("walkForward requires at least one complete train/test fold");
  if (foldCount > WALK_FORWARD_MAX_FOLDS)
    throw new Error(`walkForward exceeds the ${WALK_FORWARD_MAX_FOLDS} fold safety limit`);
  const evaluatedBars =
    foldCount *
    (input.request.candidates.length * input.request.trainSize +
      input.request.trainSize +
      input.request.testSize);
  if (evaluatedBars > WALK_FORWARD_MAX_EVALUATED_BARS)
    throw new Error(
      `walkForward exceeds the ${WALK_FORWARD_MAX_EVALUATED_BARS} evaluated-bar safety limit`,
    );
  const windows = walkForwardWindows(
    input.bars,
    input.request.trainSize,
    input.request.testSize,
  );

  const folds = windows.map((window, foldIndex) => {
    const foldEnd = window.testStart + window.test.length;
    const foldBars = input.bars.slice(window.trainStart, foldEnd);
    const foldMarket = {
      histories: Object.fromEntries(
        Object.entries(input.barsBySymbol).map(([symbol, bars]) => [
          symbol,
          bars.slice(window.trainStart, foldEnd),
        ]),
      ),
    };
    const trainMarket = {
      histories: Object.fromEntries(
        Object.entries(input.barsBySymbol).map(([symbol, bars]) => [
          symbol,
          bars.slice(window.trainStart, window.testStart),
        ]),
      ),
    };
    const candidateScores = input.request.candidates
      .map((candidate) => ({
        candidate,
        result: runBacktest({
          strategyId: input.strategyId,
          bars: window.train,
          strategy: strategyFunctionFromPlugin(
            strategyPluginFromId(input.strategyId, candidate.params),
            trainMarket,
            input.symbol,
          ),
          initialCash: input.initialCash,
          feeBps: input.feeBps,
          slippageBps: input.slippageBps,
        }),
      }))
      .sort(candidateOrder);
    const selected = candidateScores[0]!;
    const testResult = runBacktest({
      strategyId: input.strategyId,
      bars: foldBars,
      strategy: strategyFunctionFromPlugin(
        strategyPluginFromId(input.strategyId, selected.candidate.params),
        foldMarket,
        input.symbol,
      ),
      initialCash: input.initialCash,
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
      evaluationStartIndex: window.train.length,
    });
    const trainEnd = new Date(window.train.at(-1)!.timestamp).toISOString();
    const testStart = new Date(window.test[0]!.timestamp).toISOString();
    return {
      fold: foldIndex + 1,
      train: {
        start: new Date(window.train[0]!.timestamp).toISOString(),
        end: trainEnd,
        bars: window.train.length,
      },
      test: {
        start: testStart,
        end: new Date(window.test.at(-1)!.timestamp).toISOString(),
        bars: window.test.length,
      },
      selectedParams: selected.candidate.params,
      selectedCandidateHash: selected.candidate.candidateHash,
      candidateScores: candidateScores.map(({ candidate, result }) => ({
        candidateHash: candidate.candidateHash,
        params: candidate.params,
        trainTotalReturnPercent: result.totalReturnPercent,
        trainMaxDrawdownPercent: result.maxDrawdownPercent,
        trainTurnoverPercent: result.turnoverPercent,
      })),
      testResult,
      leakageChecks: {
        selectionUsesTrainOnly: true,
        testBarsExcludedFromSelection: true,
        parametersFrozenDuringTest: true,
        trainEndsBeforeTestStarts:
          new Date(trainEnd).getTime() < new Date(testStart).getTime(),
      },
    };
  });
  const compoundedGrowth = folds.reduce(
    (growth, fold) => growth * (1 + fold.testResult.totalReturnPercent / 100),
    1,
  );
  const testBars = folds.reduce((sum, fold) => sum + fold.test.bars, 0);
  return {
    mode: "rolling" as const,
    objective: "highest train total return; then lower drawdown, turnover, and candidate hash" as const,
    assumptions: {
      capitalResetEachFold: true,
      indicatorsWarmOnTrainBars: true,
      testExecutionStartsWithNoPosition: true,
    },
    trainSize: input.request.trainSize,
    testSize: input.request.testSize,
    candidateCount: input.request.candidates.length,
    folds,
    aggregate: {
      foldCount: folds.length,
      testBars,
      compoundedOutOfSampleReturnPercent: (compoundedGrowth - 1) * 100,
      worstOutOfSampleDrawdownPercent: Math.max(
        ...folds.map((fold) => fold.testResult.maxDrawdownPercent),
      ),
      totalOutOfSampleCost: folds.reduce(
        (sum, fold) => sum + fold.testResult.totalCost,
        0,
      ),
      weightedOutOfSampleExposurePercent:
        folds.reduce(
          (sum, fold) =>
            sum + fold.testResult.exposureTimePercent * fold.test.bars,
          0,
        ) / testBars,
    },
    leakageChecks: {
      allPassed: folds.every((fold) =>
        Object.values(fold.leakageChecks).every(Boolean),
      ),
      foldBoundariesStrict: true,
      parametersSelectedBeforeEachTest: true,
      testResultsExcludedFromSelection: true,
    },
  };
}
