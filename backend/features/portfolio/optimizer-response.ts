import {
  normalizeIsoTime,
  providerTimeFields,
  unavailableProviderTimeFields,
  type EffectivePeriodInput,
} from "../../shared/time-provenance";
import type { buildPortfolioOptimizerReport } from "./portfolio-optimizer";

type DateInput = string | number | Date;
type OptimizerReport = ReturnType<typeof buildPortfolioOptimizerReport>;

export const OPTIMIZER_HISTORY_STALE_SECONDS = 7 * 86_400;
export const OPTIMIZER_HISTORY_FUTURE_TOLERANCE_SECONDS = 300;

export type OptimizerBar = {
  observedAt: string;
  close: number;
};

export type OptimizerHistoryEvidence = {
  symbol: string;
  marketValue: number;
  inputBars: number;
  bars: OptimizerBar[];
  rejectedBars: number;
  duplicateBars: number;
  conflictingBars: number;
  retrievedAt: string;
};

const tradingSource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  environment: "paper" as const,
};

const marketSource = {
  provider: "alpaca" as const,
  api: "market-data" as const,
  feed: "iex" as const,
  timeframe: "1Day" as const,
};

const optimizerSource = {
  provider: "local" as const,
  component: "portfolio-optimizer" as const,
  methodology: "shrunk-long-only-allocation" as const,
};

const marketFeedLimitation =
  "Optimizer return histories use Alpaca IEX single-exchange bars, not consolidated SIP market data.";

function isoTime(value: DateInput | null | undefined) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function orderedTimes(values: (DateInput | null | undefined)[]) {
  return values
    .map(isoTime)
    .filter((value): value is string => value !== null)
    .sort((left, right) => left.localeCompare(right));
}

function latestTime(values: (DateInput | null | undefined)[]) {
  return orderedTimes(values).at(-1) ?? null;
}

function observationWindow(
  values: (DateInput | null | undefined)[],
  label: string,
): EffectivePeriodInput | null {
  const times = orderedTimes(values);
  return times.length ? { start: times[0], end: times.at(-1), label } : null;
}

function historyTime(
  evidence: OptimizerHistoryEvidence,
  serverRespondedAt: DateInput,
) {
  const observedAt = evidence.bars.at(-1)?.observedAt ?? null;
  return providerTimeFields({
    observationTime: observedAt,
    publicationTime: null,
    effectivePeriod: observationWindow(
      evidence.bars.map((bar) => bar.observedAt),
      `${evidence.symbol} optimizer history window`,
    ),
    retrievalTime: evidence.retrievedAt,
    serverResponseTime: serverRespondedAt,
  });
}

/** Normalizes one provider history without retaining malformed or conflicting bars. */
export function normalizeOptimizerHistory(input: {
  symbol: string;
  marketValue: number;
  rawBars: readonly { timestamp?: unknown; close?: unknown }[];
  retrievedAt: DateInput;
}): OptimizerHistoryEvidence {
  const symbol = input.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9./-]{1,15}$/.test(symbol))
    throw new Error("Optimizer history symbol is invalid");
  if (!Number.isFinite(input.marketValue) || input.marketValue <= 0)
    throw new Error("Optimizer history market value must be positive");
  const grouped = new Map<string, number[]>();
  let rejectedBars = 0;
  for (const rawBar of input.rawBars) {
    const observedAt = isoTime(
      rawBar.timestamp as DateInput | null | undefined,
    );
    const close = Number(rawBar.close);
    if (!observedAt || !Number.isFinite(close) || close <= 0) {
      rejectedBars++;
      continue;
    }
    const values = grouped.get(observedAt) ?? [];
    values.push(close);
    grouped.set(observedAt, values);
  }

  const bars: OptimizerBar[] = [];
  let duplicateBars = 0;
  let conflictingBars = 0;
  for (const [observedAt, closes] of [...grouped].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const uniqueCloses = [...new Set(closes)];
    if (uniqueCloses.length > 1) {
      conflictingBars += closes.length;
      continue;
    }
    duplicateBars += closes.length - 1;
    bars.push({ observedAt, close: uniqueCloses[0]! });
  }

  return {
    symbol,
    marketValue: input.marketValue,
    inputBars: input.rawBars.length,
    bars,
    rejectedBars,
    duplicateBars,
    conflictingBars,
    retrievedAt: normalizeIsoTime(
      input.retrievedAt,
      "Optimizer history retrieval time",
    ),
  };
}

export function optimizerHistoryFreshness(
  evidence: OptimizerHistoryEvidence,
  asOf: DateInput,
) {
  const observedAt = evidence.bars.at(-1)?.observedAt ?? null;
  if (!observedAt) {
    return {
      status: "unavailable" as const,
      observedAt: null,
      ageSeconds: null,
      staleAfterSeconds: OPTIMIZER_HISTORY_STALE_SECONDS,
    };
  }
  const responseTime = normalizeIsoTime(asOf, "Optimizer freshness time");
  const rawAgeSeconds =
    (new Date(responseTime).getTime() - new Date(observedAt).getTime()) / 1_000;
  if (rawAgeSeconds < -OPTIMIZER_HISTORY_FUTURE_TOLERANCE_SECONDS) {
    return {
      status: "future" as const,
      observedAt,
      ageSeconds: rawAgeSeconds,
      staleAfterSeconds: OPTIMIZER_HISTORY_STALE_SECONDS,
    };
  }
  const ageSeconds = Math.max(0, rawAgeSeconds);
  return {
    status:
      ageSeconds > OPTIMIZER_HISTORY_STALE_SECONDS
        ? ("stale" as const)
        : ("fresh" as const),
    observedAt,
    ageSeconds,
    staleAfterSeconds: OPTIMIZER_HISTORY_STALE_SECONDS,
  };
}

export function optimizerHistoryUsable(
  evidence: OptimizerHistoryEvidence,
  minObservations: number,
  asOf: DateInput,
) {
  return (
    evidence.bars.length - 1 >= minObservations &&
    optimizerHistoryFreshness(evidence, asOf).status === "fresh"
  );
}

/** Adds source, coverage, freshness, and explicit timestamp semantics. */
export function portfolioOptimizerDto(input: {
  report: OptimizerReport;
  histories: OptimizerHistoryEvidence[];
  totalPositionCount: number;
  omittedPositionCount: number;
  minObservations: number;
  accountRetrievedAt: DateInput;
  evaluatedAt: DateInput;
  serverRespondedAt: DateInput;
}) {
  const historyBySymbol = new Map(
    input.histories.map((history) => [history.symbol, history]),
  );
  const optimizedSymbols: string[] = [
    ...input.report.coverage.optimizedSymbols,
  ];
  const usedHistories = optimizedSymbols.flatMap((symbol) => {
    const evidence = historyBySymbol.get(symbol);
    return evidence ? [evidence] : [];
  });
  const usedBarTimes = usedHistories.flatMap((history) =>
    history.bars.map((bar) => bar.observedAt),
  );
  const marketRetrievedAt = latestTime(
    input.histories.map((history) => history.retrievedAt),
  );
  const accountRetrievedAt = normalizeIsoTime(
    input.accountRetrievedAt,
    "Optimizer account retrieval time",
  );
  const evaluatedAt = normalizeIsoTime(
    input.evaluatedAt,
    "Optimizer evaluation time",
  );
  const rootRetrievedAt =
    latestTime([accountRetrievedAt, marketRetrievedAt]) ?? accountRetrievedAt;
  const rootTime = providerTimeFields({
    observationTime: latestTime(usedBarTimes),
    publicationTime: null,
    effectivePeriod: observationWindow(
      usedBarTimes,
      "Aligned optimizer market-history window",
    ),
    retrievalTime: rootRetrievedAt,
    serverResponseTime: input.serverRespondedAt,
  });
  const accountTime = providerTimeFields({
    observationTime: null,
    publicationTime: null,
    effectivePeriod: null,
    retrievalTime: accountRetrievedAt,
    serverResponseTime: input.serverRespondedAt,
  });
  const marketTime = marketRetrievedAt
    ? providerTimeFields({
        observationTime: latestTime(usedBarTimes),
        publicationTime: null,
        effectivePeriod: observationWindow(
          usedBarTimes,
          "Aligned optimizer market-history window",
        ),
        retrievalTime: marketRetrievedAt,
        serverResponseTime: input.serverRespondedAt,
      })
    : unavailableProviderTimeFields(input.serverRespondedAt);
  const historyInputs = input.histories.map((history) => {
    const freshness = optimizerHistoryFreshness(history, evaluatedAt);
    return {
      symbol: history.symbol,
      inputBars: history.inputBars,
      acceptedBars: history.bars.length,
      rejectedBars: history.rejectedBars,
      duplicateBars: history.duplicateBars,
      conflictingBars: history.conflictingBars,
      returnObservations: Math.max(0, history.bars.length - 1),
      used: optimizedSymbols.includes(history.symbol),
      freshness,
      source: marketSource,
      ...historyTime(history, input.serverRespondedAt),
    };
  });
  const staleHistories = historyInputs.filter(
    (history) => history.freshness.status === "stale",
  );
  const unavailableHistories = historyInputs.filter(
    (history) => history.freshness.status === "unavailable",
  );
  const futureHistories = historyInputs.filter(
    (history) => history.freshness.status === "future",
  );
  const insufficientHistories = historyInputs.filter(
    (history) => history.returnObservations < input.minObservations,
  );
  const rejectedBars = input.histories.reduce(
    (sum, history) => sum + history.rejectedBars,
    0,
  );
  const duplicateBars = input.histories.reduce(
    (sum, history) => sum + history.duplicateBars,
    0,
  );
  const conflictingBars = input.histories.reduce(
    (sum, history) => sum + history.conflictingBars,
    0,
  );
  const missing = [
    ...(input.omittedPositionCount
      ? [
          `${input.omittedPositionCount} current positions are outside the eligible long US-equity set.`,
        ]
      : []),
    ...insufficientHistories.map(
      (history) =>
        `${history.symbol} has fewer than ${input.minObservations} return observations.`,
    ),
    ...staleHistories.map(
      (history) => `${history.symbol} market history is stale.`,
    ),
    ...unavailableHistories.map(
      (history) => `${history.symbol} has no valid market observation time.`,
    ),
    ...futureHistories.map(
      (history) =>
        `${history.symbol} market history is timestamped in the future.`,
    ),
    ...(rejectedBars
      ? [`${rejectedBars} malformed market bars were rejected.`]
      : []),
    ...(conflictingBars
      ? [`${conflictingBars} conflicting duplicate market bars were excluded.`]
      : []),
    ...(duplicateBars
      ? [`${duplicateBars} exact duplicate market bars were collapsed.`]
      : []),
  ];
  const impact = missing.length
    ? [
        "Proposals use only fresh eligible histories with enough aligned return observations; omitted holdings remain outside optimized target weights.",
      ]
    : [
        "All eligible current holdings have fresh, sufficient histories for the displayed proposals.",
      ];
  const proposalTime = {
    source: optimizerSource,
    ...rootTime,
  };

  return {
    ...input.report,
    schemaVersion: "portfolio-optimizer-v2",
    proposals: input.report.proposals.map((proposal) => ({
      ...proposal,
      weights: proposal.weights.map((weight) => {
        const evidence = historyBySymbol.get(weight.symbol);
        if (!evidence)
          throw new Error(
            `Optimizer weight ${weight.symbol} is missing history evidence`,
          );
        return {
          ...weight,
          source: marketSource,
          ...historyTime(evidence, input.serverRespondedAt),
        };
      }),
      ...proposalTime,
    })),
    coverage: {
      ...input.report.coverage,
      source: optimizerSource,
      ...rootTime,
    },
    warnings: [
      ...new Set([
        ...input.report.warnings,
        marketFeedLimitation,
        ...missing,
        ...(missing.length ? impact : []),
      ]),
    ],
    inputs: {
      account: {
        available: true,
        source: tradingSource,
        ...accountTime,
      },
      positions: {
        total: input.totalPositionCount,
        eligibleLongUsEquity: input.histories.length,
        omitted: input.omittedPositionCount,
        source: tradingSource,
        ...accountTime,
      },
      marketHistory: {
        queried: input.histories.length > 0,
        count: input.histories.length,
        source: marketSource,
        ...marketTime,
      },
      marketHistories: historyInputs,
    },
    quality: {
      status:
        input.totalPositionCount === 0
          ? ("empty" as const)
          : missing.length
            ? ("partial" as const)
            : ("complete" as const),
      expected: {
        currentPositions: input.totalPositionCount,
        eligibleMarketHistories: input.histories.length,
      },
      received: {
        currentPositions: input.totalPositionCount,
        marketHistories: input.histories.length,
        usableMarketHistories: optimizedSymbols.length,
      },
      omitted: {
        currentPositions: input.omittedPositionCount,
        marketHistories: input.histories.length - optimizedSymbols.length,
      },
      rejected: {
        malformedBars: rejectedBars,
        duplicateBars,
        conflictingBars,
      },
      freshness: {
        evaluatedAt,
        staleAfterSeconds: OPTIMIZER_HISTORY_STALE_SECONDS,
        freshHistories: historyInputs.filter(
          (history) => history.freshness.status === "fresh",
        ).length,
        staleHistories: staleHistories.length,
        unavailableHistories: unavailableHistories.length,
        futureHistories: futureHistories.length,
      },
      missing,
      impact,
      source: "Calculated from the bounded portfolio-optimizer evidence set",
      ...rootTime,
    },
    source: {
      account: tradingSource,
      marketHistory: marketSource,
      calculation: optimizerSource,
    },
    ...rootTime,
  };
}
