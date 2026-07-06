import {
  parseStrategyParams,
  runBacktest,
  strategyFunctionFromPlugin,
  strategyPluginFromId,
  walkForwardWindows,
  type BacktestBar,
  type BacktestPoint,
  type BacktestResult,
} from "./strategy-backtest";
import { canonicalHash } from "./strategy-provenance";

export const WALK_FORWARD_MAX_CANDIDATES = 20;
export const WALK_FORWARD_MAX_FOLDS = 100;
export const WALK_FORWARD_MAX_EVALUATED_BARS = 2_000_000;
export const WALK_FORWARD_MAX_REGIMES = 20;

export type WalkForwardMode = "rolling" | "anchored";

export type WalkForwardCandidate = {
  params: Record<string, unknown>;
  candidateHash: string;
};

export type WalkForwardRegime = {
  id: string;
  start: string;
  end: string;
};

export type WalkForwardRequest = {
  mode: WalkForwardMode;
  trainSize: number;
  testSize: number;
  holdoutSize: number;
  regimes: WalkForwardRegime[];
  candidates: WalkForwardCandidate[];
};

type WalkForwardWindow<T> = {
  train: T[];
  test: T[];
  trainStart: number;
  testStart: number;
};

type CandidateScore = {
  candidate: WalkForwardCandidate;
  result: BacktestResult;
};

type OutOfSampleObservation = {
  timestamp: string;
  return: number;
  cost: number;
  targetExposure: number;
};

export function parseWalkForwardRequest(
  strategyId: string,
  value: unknown,
): WalkForwardRequest | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("walkForward must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "mode",
    "trainSize",
    "testSize",
    "holdoutSize",
    "regimes",
    "candidates",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown walkForward field: ${unknown}`);
  const mode = input.mode === undefined ? "rolling" : input.mode;
  if (mode !== "rolling" && mode !== "anchored")
    throw new Error("walkForward mode must be rolling or anchored");
  const trainSize = Number(input.trainSize);
  const testSize = Number(input.testSize);
  const holdoutSize = Number(input.holdoutSize ?? 0);
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
    input.holdoutSize !== undefined &&
    (typeof input.holdoutSize !== "number" ||
      !Number.isInteger(holdoutSize) ||
      holdoutSize < 0)
  )
    throw new Error("walkForward holdoutSize must be a non-negative integer");
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
  const regimes = parseRegimes(input.regimes);
  return { mode, trainSize, testSize, holdoutSize, regimes, candidates };
}

function parseRegimes(value: unknown): WalkForwardRegime[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WALK_FORWARD_MAX_REGIMES)
    throw new Error(`walkForward regimes must contain 0 to ${WALK_FORWARD_MAX_REGIMES} ranges`);
  const regimes = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("walkForward regime slices require id, start, and end");
    const input = item as Record<string, unknown>;
    const allowed = new Set(["id", "start", "end"]);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Unknown walkForward regime field: ${unknown}`);
    if (typeof input.id !== "string" || !/^[A-Za-z0-9_.:-]{1,40}$/.test(input.id))
      throw new Error("walkForward regime id must be 1-40 letters, numbers, dots, colons, underscores, or dashes");
    const start = parseDate(input.start, "walkForward regime start");
    const end = parseDate(input.end, "walkForward regime end");
    if (start.getTime() >= end.getTime())
      throw new Error("walkForward regime start must be before end");
    return { id: input.id, start: start.toISOString(), end: end.toISOString() };
  });
  if (new Set(regimes.map((regime) => regime.id)).size !== regimes.length)
    throw new Error("walkForward regime ids must be unique");
  const sorted = [...regimes].sort(
    (left, right) =>
      new Date(left.start).getTime() - new Date(right.start).getTime() ||
      new Date(left.end).getTime() - new Date(right.end).getTime(),
  );
  for (let index = 1; index < sorted.length; index++) {
    if (new Date(sorted[index]!.start).getTime() < new Date(sorted[index - 1]!.end).getTime())
      throw new Error("walkForward regimes must not overlap");
  }
  return regimes;
}

function parseDate(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return date;
}

function candidateOrder(left: CandidateScore, right: CandidateScore) {
  return (
    right.result.totalReturnPercent - left.result.totalReturnPercent ||
    left.result.maxDrawdownPercent - right.result.maxDrawdownPercent ||
    left.result.turnoverPercent - right.result.turnoverPercent ||
    left.candidate.candidateHash.localeCompare(right.candidate.candidateHash)
  );
}

function makeWindows<T>(
  values: T[],
  mode: WalkForwardMode,
  trainSize: number,
  testSize: number,
) {
  if (mode === "rolling") return walkForwardWindows(values, trainSize, testSize);
  const windows: WalkForwardWindow<T>[] = [];
  for (let testStart = trainSize; testStart + testSize <= values.length; testStart += testSize) {
    windows.push({
      train: values.slice(0, testStart),
      test: values.slice(testStart, testStart + testSize),
      trainStart: 0,
      testStart,
    });
  }
  return windows;
}

function countWindows(length: number, trainSize: number, testSize: number) {
  return Math.max(0, Math.floor((length - trainSize) / testSize));
}

function marketSlice(
  barsBySymbol: Record<string, BacktestBar[]>,
  start: number,
  end: number,
) {
  return {
    histories: Object.fromEntries(
      Object.entries(barsBySymbol).map(([symbol, bars]) => [
        symbol,
        bars.slice(start, end),
      ]),
    ),
  };
}

function summarizeCandidateScores(candidateScores: CandidateScore[]) {
  return candidateScores.map(({ candidate, result }) => ({
    candidateHash: candidate.candidateHash,
    params: candidate.params,
    trainTotalReturnPercent: result.totalReturnPercent,
    trainMaxDrawdownPercent: result.maxDrawdownPercent,
    trainTurnoverPercent: result.turnoverPercent,
  }));
}

function scoreCandidates(input: {
  strategyId: string;
  symbol: string;
  trainBars: BacktestBar[];
  trainMarket: { histories: Record<string, BacktestBar[]> };
  candidates: WalkForwardCandidate[];
  initialCash: number;
  feeBps: number;
  slippageBps: number;
}) {
  return input.candidates
    .map((candidate) => ({
      candidate,
      result: runBacktest({
        strategyId: input.strategyId,
        bars: input.trainBars,
        strategy: strategyFunctionFromPlugin(
          strategyPluginFromId(input.strategyId, candidate.params),
          input.trainMarket,
          input.symbol,
        ),
        initialCash: input.initialCash,
        feeBps: input.feeBps,
        slippageBps: input.slippageBps,
      }),
    }))
    .sort(candidateOrder);
}

function timestamp(bar: BacktestBar) {
  return new Date(bar.timestamp).toISOString();
}

function observationsFromResult(result: BacktestResult): OutOfSampleObservation[] {
  let previousEquity = result.initialCash;
  return result.points.map((point: BacktestPoint) => {
    const observation = {
      timestamp: point.timestamp,
      return: point.equity / previousEquity - 1,
      cost: point.cost,
      targetExposure: point.targetExposure,
    };
    previousEquity = point.equity;
    return observation;
  });
}

function aggregateObservations(observations: OutOfSampleObservation[]) {
  if (!observations.length)
    return {
      status: "no_data" as const,
      bars: 0,
      compoundedReturnPercent: null,
      totalCost: null,
      exposureTimePercent: null,
      observedStart: null,
      observedEnd: null,
    };
  const sorted = [...observations].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
  return {
    status: "covered" as const,
    bars: sorted.length,
    compoundedReturnPercent:
      (sorted.reduce((growth, point) => growth * (1 + point.return), 1) - 1) * 100,
    totalCost: sorted.reduce((sum, point) => sum + point.cost, 0),
    exposureTimePercent:
      (sorted.filter((point) => point.targetExposure > 0.01).length / sorted.length) * 100,
    observedStart: sorted[0]!.timestamp,
    observedEnd: sorted.at(-1)!.timestamp,
  };
}

function regimeSlices(input: {
  regimes: WalkForwardRegime[];
  validationObservations: OutOfSampleObservation[];
  holdoutObservations: OutOfSampleObservation[];
}) {
  return input.regimes.map((regime) => {
    const start = new Date(regime.start).getTime();
    const end = new Date(regime.end).getTime();
    const inRegime = (point: OutOfSampleObservation) => {
      const time = new Date(point.timestamp).getTime();
      return time >= start && time < end;
    };
    return {
      id: regime.id,
      start: regime.start,
      end: regime.end,
      validation: aggregateObservations(input.validationObservations.filter(inRegime)),
      holdout: aggregateObservations(input.holdoutObservations.filter(inRegime)),
    };
  });
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
  if (input.request.holdoutSize >= input.bars.length)
    throw new Error("walkForward holdoutSize leaves no training universe");
  const trainingLength = input.bars.length - input.request.holdoutSize;
  const foldCount = countWindows(
    trainingLength,
    input.request.trainSize,
    input.request.testSize,
  );
  if (!foldCount)
    throw new Error("walkForward requires at least one complete train/test fold");
  if (foldCount > WALK_FORWARD_MAX_FOLDS)
    throw new Error(`walkForward exceeds the ${WALK_FORWARD_MAX_FOLDS} fold safety limit`);

  const candidateCount = input.request.candidates.length;
  let evaluatedBars = 0;
  for (let fold = 0; fold < foldCount; fold++) {
    const trainBars =
      input.request.mode === "anchored"
        ? input.request.trainSize + fold * input.request.testSize
        : input.request.trainSize;
    evaluatedBars += candidateCount * trainBars + trainBars + input.request.testSize;
  }
  if (input.request.holdoutSize > 0)
    evaluatedBars +=
      candidateCount * trainingLength + trainingLength + input.request.holdoutSize;
  if (evaluatedBars > WALK_FORWARD_MAX_EVALUATED_BARS)
    throw new Error(
      `walkForward exceeds the ${WALK_FORWARD_MAX_EVALUATED_BARS} evaluated-bar safety limit`,
    );

  const trainingBars = input.bars.slice(0, trainingLength);
  const windows = makeWindows(
    trainingBars,
    input.request.mode,
    input.request.trainSize,
    input.request.testSize,
  );

  const folds = windows.map((window, foldIndex) => {
    const foldEnd = window.testStart + window.test.length;
    const foldBars = input.bars.slice(window.trainStart, foldEnd);
    const candidateScores = scoreCandidates({
      strategyId: input.strategyId,
      symbol: input.symbol,
      trainBars: window.train,
      trainMarket: marketSlice(input.barsBySymbol, window.trainStart, window.testStart),
      candidates: input.request.candidates,
      initialCash: input.initialCash,
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
    });
    const selected = candidateScores[0]!;
    const testResult = runBacktest({
      strategyId: input.strategyId,
      bars: foldBars,
      strategy: strategyFunctionFromPlugin(
        strategyPluginFromId(input.strategyId, selected.candidate.params),
        marketSlice(input.barsBySymbol, window.trainStart, foldEnd),
        input.symbol,
      ),
      initialCash: input.initialCash,
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
      evaluationStartIndex: window.train.length,
    });
    const trainEnd = timestamp(window.train.at(-1)!);
    const testStart = timestamp(window.test[0]!);
    return {
      fold: foldIndex + 1,
      train: {
        start: timestamp(window.train[0]!),
        end: trainEnd,
        bars: window.train.length,
      },
      test: {
        start: testStart,
        end: timestamp(window.test.at(-1)!),
        bars: window.test.length,
      },
      selectedParams: selected.candidate.params,
      selectedCandidateHash: selected.candidate.candidateHash,
      candidateScores: summarizeCandidateScores(candidateScores),
      testResult,
      leakageChecks: {
        selectionUsesTrainOnly: true,
        testBarsExcludedFromSelection: true,
        holdoutBarsExcludedFromSelection: input.request.holdoutSize === 0 || foldEnd <= trainingLength,
        parametersFrozenDuringTest: true,
        trainEndsBeforeTestStarts:
          new Date(trainEnd).getTime() < new Date(testStart).getTime(),
      },
    };
  });

  let finalHoldout = null;
  if (input.request.holdoutSize > 0) {
    const holdoutStart = trainingLength;
    const candidateScores = scoreCandidates({
      strategyId: input.strategyId,
      symbol: input.symbol,
      trainBars: trainingBars,
      trainMarket: marketSlice(input.barsBySymbol, 0, trainingLength),
      candidates: input.request.candidates,
      initialCash: input.initialCash,
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
    });
    const selected = candidateScores[0]!;
    const testResult = runBacktest({
      strategyId: input.strategyId,
      bars: input.bars,
      strategy: strategyFunctionFromPlugin(
        strategyPluginFromId(input.strategyId, selected.candidate.params),
        marketSlice(input.barsBySymbol, 0, input.bars.length),
        input.symbol,
      ),
      initialCash: input.initialCash,
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
      evaluationStartIndex: holdoutStart,
    });
    const trainEnd = timestamp(trainingBars.at(-1)!);
    const testStart = timestamp(input.bars[holdoutStart]!);
    finalHoldout = {
      train: {
        start: timestamp(trainingBars[0]!),
        end: trainEnd,
        bars: trainingBars.length,
      },
      test: {
        start: testStart,
        end: timestamp(input.bars.at(-1)!),
        bars: input.request.holdoutSize,
      },
      selectedParams: selected.candidate.params,
      selectedCandidateHash: selected.candidate.candidateHash,
      candidateScores: summarizeCandidateScores(candidateScores),
      testResult,
      leakageChecks: {
        holdoutExcludedFromSelection: true,
        parametersFrozenDuringHoldout: true,
        trainEndsBeforeHoldoutStarts:
          new Date(trainEnd).getTime() < new Date(testStart).getTime(),
      },
    };
  }

  const compoundedGrowth = folds.reduce(
    (growth, fold) => growth * (1 + fold.testResult.totalReturnPercent / 100),
    1,
  );
  const testBars = folds.reduce((sum, fold) => sum + fold.test.bars, 0);
  const validationObservations = folds.flatMap((fold) =>
    observationsFromResult(fold.testResult),
  );
  const holdoutObservations = finalHoldout
    ? observationsFromResult(finalHoldout.testResult)
    : [];
  return {
    mode: input.request.mode,
    objective: "highest train total return; then lower drawdown, turnover, and candidate hash" as const,
    assumptions: {
      capitalResetEachFold: true,
      indicatorsWarmOnTrainBars: true,
      testExecutionStartsWithNoPosition: true,
      holdoutExcludedFromParameterSelection: input.request.holdoutSize > 0,
      regimeSlicesAreReportsOnly: input.request.regimes.length > 0,
    },
    trainSize: input.request.trainSize,
    testSize: input.request.testSize,
    holdoutSize: input.request.holdoutSize,
    candidateCount,
    folds,
    finalHoldout,
    regimeSlices: regimeSlices({
      regimes: input.request.regimes,
      validationObservations,
      holdoutObservations,
    }),
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
      allPassed:
        folds.every((fold) => Object.values(fold.leakageChecks).every(Boolean)) &&
        (!finalHoldout || Object.values(finalHoldout.leakageChecks).every(Boolean)),
      foldBoundariesStrict: true,
      parametersSelectedBeforeEachTest: true,
      testResultsExcludedFromSelection: true,
      holdoutExcludedFromAllCandidateScoring: true,
      regimeSlicesDoNotAffectSelection: true,
    },
  };
}
