import { expect, test } from "bun:test";
import {
  parseWalkForwardRequest,
  runWalkForwardEvaluation,
} from "../../backend/features/strategies/strategy-walk-forward";

const bars = (closes: number[]) =>
  closes.map((close, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    close,
  }));

test("validates canonical bounded walk-forward candidate sets", () => {
  const request = parseWalkForwardRequest("moving-average-trend", {
    trainSize: 20,
    testSize: 5,
    candidates: [
      { fast: 2, slow: 5 },
      { fast: 5, slow: 10, exposure: 0.5 },
    ],
  });
  expect(request).toMatchObject({
    mode: "rolling",
    trainSize: 20,
    testSize: 5,
    holdoutSize: 0,
    regimes: [],
    candidates: [
      { params: { fast: 2, slow: 5, exposure: 1 } },
      { params: { fast: 5, slow: 10, exposure: 0.5 } },
    ],
  });
  expect(() =>
    parseWalkForwardRequest("time-sliced-accumulation", {
      trainSize: 4,
      testSize: 2,
      candidates: [{}, { slices: 10, maxExposure: 1 }],
    }),
  ).toThrow("unique after defaults");
  expect(() =>
    parseWalkForwardRequest("moving-average-trend", {
      trainSize: "20",
      testSize: 5,
      candidates: [{}],
    }),
  ).toThrow("trainSize");
});

test("validates walk-forward modes, holdouts, and regime slices", () => {
  const request = parseWalkForwardRequest("buy-and-hold", {
    mode: "anchored",
    trainSize: 3,
    testSize: 1,
    holdoutSize: 2,
    regimes: [
      {
        id: "bull-2026",
        start: "2026-01-03T00:00:00.000Z",
        end: "2026-01-05T00:00:00.000Z",
      },
    ],
    candidates: [{}],
  });
  expect(request).toMatchObject({
    mode: "anchored",
    trainSize: 3,
    testSize: 1,
    holdoutSize: 2,
    regimes: [{
      id: "bull-2026",
      start: "2026-01-03T00:00:00.000Z",
      end: "2026-01-05T00:00:00.000Z",
    }],
  });
  expect(() =>
    parseWalkForwardRequest("buy-and-hold", {
      mode: "expanding",
      trainSize: 3,
      testSize: 1,
      candidates: [{}],
    }),
  ).toThrow("mode");
  expect(() =>
    parseWalkForwardRequest("buy-and-hold", {
      trainSize: 3,
      testSize: 1,
      holdoutSize: -1,
      candidates: [{}],
    }),
  ).toThrow("holdoutSize");
  expect(() =>
    parseWalkForwardRequest("buy-and-hold", {
      trainSize: 3,
      testSize: 1,
      regimes: [
        { id: "one", start: "2026-01-01T00:00:00.000Z", end: "2026-01-03T00:00:00.000Z" },
        { id: "two", start: "2026-01-02T00:00:00.000Z", end: "2026-01-04T00:00:00.000Z" },
      ],
      candidates: [{}],
    }),
  ).toThrow("must not overlap");
});

test("selects on train bars only and freezes parameters across untouched test bars", () => {
  const request = parseWalkForwardRequest("time-sliced-accumulation", {
    trainSize: 4,
    testSize: 2,
    candidates: [
      { slices: 2, maxExposure: 1 },
      { slices: 100, maxExposure: 1 },
    ],
  })!;
  const evaluate = (values: number[]) => {
    const history = bars(values);
    return runWalkForwardEvaluation({
      strategyId: "time-sliced-accumulation",
      symbol: "BTC/USD",
      bars: history,
      barsBySymbol: { "BTC/USD": history },
      request,
      initialCash: 1_000,
      feeBps: 0,
      slippageBps: 0,
    });
  };
  const fallingTest = evaluate([100, 110, 120, 130, 90, 80]);
  const risingTest = evaluate([100, 110, 120, 130, 140, 150]);
  expect(fallingTest.folds).toHaveLength(1);
  expect(fallingTest.folds[0]).toMatchObject({
    train: { bars: 4, end: "2026-01-04T00:00:00.000Z" },
    test: { bars: 2, start: "2026-01-05T00:00:00.000Z" },
    selectedParams: { slices: 2, maxExposure: 1 },
    leakageChecks: {
      selectionUsesTrainOnly: true,
      testBarsExcludedFromSelection: true,
      parametersFrozenDuringTest: true,
      trainEndsBeforeTestStarts: true,
    },
    testResult: { points: [{ timestamp: "2026-01-05T00:00:00.000Z" }, { timestamp: "2026-01-06T00:00:00.000Z" }] },
  });
  expect(fallingTest.aggregate.uncertainty).toMatchObject({
    status: "insufficient_data",
    method: "moving_block_bootstrap",
    sampleSize: 2,
    rankingUse: "not_rankable",
  });
  expect(risingTest.folds[0]?.selectedCandidateHash).toBe(
    fallingTest.folds[0]?.selectedCandidateHash,
  );
  expect(risingTest.folds[0]?.testResult.totalReturnPercent).not.toBe(
    fallingTest.folds[0]?.testResult.totalReturnPercent,
  );
  expect(fallingTest.leakageChecks.allPassed).toBe(true);
});

test("supports anchored folds with expanding train history", () => {
  const request = parseWalkForwardRequest("buy-and-hold", {
    mode: "anchored",
    trainSize: 3,
    testSize: 1,
    candidates: [{}],
  })!;
  const history = bars([100, 101, 102, 103, 104, 105]);
  const result = runWalkForwardEvaluation({
    strategyId: "buy-and-hold",
    symbol: "BTC/USD",
    bars: history,
    barsBySymbol: { "BTC/USD": history },
    request,
    initialCash: 1_000,
    feeBps: 0,
    slippageBps: 0,
  });
  expect(result.mode).toBe("anchored");
  expect(result.folds.map((fold) => fold.train.bars)).toEqual([3, 4, 5]);
  expect(result.folds.map((fold) => fold.test.start)).toEqual([
    "2026-01-04T00:00:00.000Z",
    "2026-01-05T00:00:00.000Z",
    "2026-01-06T00:00:00.000Z",
  ]);
  expect(result.finalHoldout).toBeNull();
  expect(result.leakageChecks.allPassed).toBe(true);
});

test("keeps final holdout out of selection and reports regime slices separately", () => {
  const request = parseWalkForwardRequest("time-sliced-accumulation", {
    mode: "anchored",
    trainSize: 3,
    testSize: 1,
    holdoutSize: 2,
    regimes: [
      {
        id: "validation-boundary",
        start: "2026-01-05T00:00:00.000Z",
        end: "2026-01-06T00:00:00.000Z",
      },
      {
        id: "final-holdout",
        start: "2026-01-06T00:00:00.000Z",
        end: "2026-01-08T00:00:00.000Z",
      },
    ],
    candidates: [
      { slices: 1, maxExposure: 1 },
      { slices: 100, maxExposure: 1 },
    ],
  })!;
  const evaluate = (values: number[]) => {
    const history = bars(values);
    return runWalkForwardEvaluation({
      strategyId: "time-sliced-accumulation",
      symbol: "BTC/USD",
      bars: history,
      barsBySymbol: { "BTC/USD": history },
      request,
      initialCash: 1_000,
      feeBps: 0,
      slippageBps: 0,
    });
  };
  const fallingHoldout = evaluate([100, 110, 120, 130, 140, 10, 9]);
  const risingHoldout = evaluate([100, 110, 120, 130, 140, 150, 160]);

  expect(fallingHoldout.folds.map((fold) => fold.test.start)).toEqual([
    "2026-01-04T00:00:00.000Z",
    "2026-01-05T00:00:00.000Z",
  ]);
  expect(fallingHoldout.finalHoldout).toMatchObject({
    train: { bars: 5, end: "2026-01-05T00:00:00.000Z" },
    test: { bars: 2, start: "2026-01-06T00:00:00.000Z" },
    selectedParams: { slices: 1, maxExposure: 1 },
    leakageChecks: {
      holdoutExcludedFromSelection: true,
      parametersFrozenDuringHoldout: true,
      trainEndsBeforeHoldoutStarts: true,
    },
  });
  expect(risingHoldout.finalHoldout?.selectedCandidateHash).toBe(
    fallingHoldout.finalHoldout?.selectedCandidateHash,
  );
  expect(risingHoldout.finalHoldout?.testResult.totalReturnPercent).not.toBe(
    fallingHoldout.finalHoldout?.testResult.totalReturnPercent,
  );
  expect(fallingHoldout.regimeSlices).toMatchObject([
    {
      id: "validation-boundary",
      validation: {
        status: "covered",
        bars: 1,
        observedStart: "2026-01-05T00:00:00.000Z",
        observedEnd: "2026-01-05T00:00:00.000Z",
      },
      holdout: { status: "no_data", bars: 0 },
    },
    {
      id: "final-holdout",
      validation: { status: "no_data", bars: 0 },
      holdout: {
        status: "covered",
        bars: 2,
        observedStart: "2026-01-06T00:00:00.000Z",
        observedEnd: "2026-01-07T00:00:00.000Z",
      },
    },
  ]);
  expect(fallingHoldout.leakageChecks).toMatchObject({
    allPassed: true,
    holdoutExcludedFromAllCandidateScoring: true,
    regimeSlicesDoNotAffectSelection: true,
  });
  expect(fallingHoldout.aggregate.uncertainty).toMatchObject({
    status: "insufficient_data",
    sampleSize: 2,
  });
});

test("fails closed on excessive folds and timestamp-misaligned histories", () => {
  const request = parseWalkForwardRequest("buy-and-hold", {
    trainSize: 2,
    testSize: 1,
    candidates: [{}],
  })!;
  const excessive = bars(Array.from({ length: 103 }, (_, index) => 100 + index));
  expect(() =>
    runWalkForwardEvaluation({
      strategyId: "buy-and-hold",
      symbol: "BTC/USD",
      bars: excessive,
      barsBySymbol: { "BTC/USD": excessive },
      request,
      initialCash: 1_000,
      feeBps: 0,
      slippageBps: 0,
    }),
  ).toThrow("fold safety limit");

  const primary = bars([100, 101, 102]);
  const peer = bars([200, 201, 202]);
  peer[1] = { ...peer[1]!, timestamp: "2026-01-02T01:00:00.000Z" };
  expect(() =>
    runWalkForwardEvaluation({
      strategyId: "buy-and-hold",
      symbol: "BTC/USD",
      bars: primary,
      barsBySymbol: { "BTC/USD": primary, "ETH/USD": peer },
      request,
      initialCash: 1_000,
      feeBps: 0,
      slippageBps: 0,
    }),
  ).toThrow("timestamp-synchronized");
});
