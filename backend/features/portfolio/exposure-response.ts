import {
  providerTimeFields,
  unavailableProviderTimeFields,
  type EffectivePeriodInput,
} from "../../shared/time-provenance";
import type {
  ExposureBar,
  buildPortfolioExposureReport,
} from "./portfolio-exposure";

type DateInput = string | number | Date;
type ExposureReport = ReturnType<typeof buildPortfolioExposureReport>;

export type ExposurePositionEvidence = {
  symbol: string;
  assetClass: string;
  bars: ExposureBar[];
  rejectedMarketBars: number;
  marketDataQueried: boolean;
  marketDataRetrievedAt: DateInput | null;
  classificationQueried: boolean;
  classificationAvailable: boolean;
  classificationRetrievedAt: DateInput | null;
  classificationSourceUrl: string | null;
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
};
const classificationSource = {
  provider: "sec" as const,
  dataset: "submissions" as const,
  taxonomy: "SIC" as const,
};

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
  return times.length
    ? { start: times[0], end: times.at(-1), label }
    : null;
}

function successfulTime(input: {
  observedAt?: DateInput | null;
  effectivePeriod?: EffectivePeriodInput | null;
  retrievedAt: DateInput;
  serverRespondedAt: DateInput;
}) {
  return providerTimeFields({
    observationTime: input.observedAt ?? null,
    publicationTime: null,
    effectivePeriod: input.effectivePeriod ?? null,
    retrievalTime: input.retrievedAt,
    serverResponseTime: input.serverRespondedAt,
  });
}

function providerTime(input: {
  observedAt?: DateInput | null;
  effectivePeriod?: EffectivePeriodInput | null;
  retrievedAt: DateInput | null;
  serverRespondedAt: DateInput;
}) {
  return input.retrievedAt === null
    ? unavailableProviderTimeFields(input.serverRespondedAt)
    : successfulTime({
        observedAt: input.observedAt,
        effectivePeriod: input.effectivePeriod,
        retrievedAt: input.retrievedAt,
        serverRespondedAt: input.serverRespondedAt,
      });
}

/** Adds source, coverage, cache, and timestamp semantics to exposure analytics. */
export function portfolioExposureDto(input: {
  report: ExposureReport;
  positionEvidence: ExposurePositionEvidence[];
  accountRetrievedAt: DateInput;
  benchmarkBars: ExposureBar[];
  benchmarkQueried: boolean;
  benchmarkRejectedBars: number;
  benchmarkRetrievedAt: DateInput | null;
  omittedPositionCount: number;
  cacheHit: boolean;
  cacheExpiresAt: DateInput;
  serverRespondedAt: DateInput;
}) {
  const evidenceBySymbol = new Map(
    input.positionEvidence.map((position) => [position.symbol, position]),
  );
  const positionBarTimes = input.positionEvidence.flatMap((position) =>
    position.bars.map((bar) => bar.observedAt),
  );
  const benchmarkBarTimes = input.benchmarkBars.map((bar) => bar.observedAt);
  const allBarTimes = [...positionBarTimes, ...benchmarkBarTimes];
  const marketRetrievals = [
    input.benchmarkRetrievedAt,
    ...input.positionEvidence.map(
      (position) => position.marketDataRetrievedAt,
    ),
  ];
  const classificationRetrievals = input.positionEvidence.map(
    (position) => position.classificationRetrievedAt,
  );
  const historicalPeriod = observationWindow(
    allBarTimes,
    "Trailing IEX exposure-factor input window",
  );
  const accountTime = successfulTime({
    observedAt: null,
    retrievedAt: input.accountRetrievedAt,
    serverRespondedAt: input.serverRespondedAt,
  });
  const rootRetrievedAt = latestTime([
    input.accountRetrievedAt,
    ...marketRetrievals,
    ...classificationRetrievals,
  ])!;
  const rootTime = successfulTime({
    observedAt: latestTime(allBarTimes),
    effectivePeriod: historicalPeriod,
    retrievedAt: rootRetrievedAt,
    serverRespondedAt: input.serverRespondedAt,
  });
  const historicalTime = providerTime({
    observedAt: latestTime(allBarTimes),
    effectivePeriod: historicalPeriod,
    retrievedAt: latestTime(marketRetrievals),
    serverRespondedAt: input.serverRespondedAt,
  });
  const classificationTime = successfulTime({
    observedAt: null,
    retrievedAt: latestTime([
      input.accountRetrievedAt,
      ...classificationRetrievals,
    ])!,
    serverRespondedAt: input.serverRespondedAt,
  });
  const benchmarkTime = providerTime({
    observedAt: latestTime(benchmarkBarTimes),
    effectivePeriod: observationWindow(
      benchmarkBarTimes,
      "SPY IEX benchmark window",
    ),
    retrievedAt: input.benchmarkRetrievedAt,
    serverRespondedAt: input.serverRespondedAt,
  });

  const positionInputs = input.positionEvidence.map((position) => {
    const barTimes = position.bars.map((bar) => bar.observedAt);
    const marketHistoryTime = providerTime({
      observedAt: latestTime(barTimes),
      effectivePeriod: observationWindow(
        barTimes,
        `${position.symbol} IEX exposure-factor window`,
      ),
      retrievedAt: position.marketDataRetrievedAt,
      serverRespondedAt: input.serverRespondedAt,
    });
    const secTime = providerTime({
      observedAt: null,
      retrievedAt: position.classificationRetrievedAt,
      serverRespondedAt: input.serverRespondedAt,
    });
    return {
      symbol: position.symbol,
      currentPosition: {
        source: tradingSource,
        ...accountTime,
      },
      marketHistory: {
        queried: position.marketDataQueried,
        available: position.bars.length >= 2,
        count: position.bars.length,
        rejected: position.rejectedMarketBars,
        source: marketSource,
        ...marketHistoryTime,
      },
      classification: {
        queried: position.classificationQueried,
        available: position.classificationAvailable,
        source: {
          ...classificationSource,
          url: position.classificationSourceUrl,
        },
        ...secTime,
      },
    };
  });

  const expectedEquityEvidence = input.positionEvidence.filter(
    (position) => position.assetClass === "us_equity",
  );
  const missing = input.positionEvidence.flatMap((position) => {
    const gaps: string[] = [];
    if (position.bars.length < 2)
      gaps.push(
        position.marketDataQueried
          ? `${position.symbol}:market_history`
          : `${position.symbol}:market_history_not_supported`,
      );
    if (
      position.marketDataQueried &&
      !latestTime(position.bars.map((bar) => bar.observedAt))
    )
      gaps.push(`${position.symbol}:market_observation_time`);
    if (
      position.assetClass === "us_equity" &&
      !position.classificationAvailable
    )
      gaps.push(`${position.symbol}:sec_sic_classification`);
    if (position.rejectedMarketBars > 0)
      gaps.push(
        `${position.symbol}:malformed_market_bars:${position.rejectedMarketBars}`,
      );
    return gaps;
  });
  const benchmarkExpected = expectedEquityEvidence.length > 0;
  if (benchmarkExpected && input.benchmarkBars.length < 2)
    missing.push("SPY:benchmark_history");
  if (benchmarkExpected && !latestTime(benchmarkBarTimes))
    missing.push("SPY:benchmark_observation_time");
  if (benchmarkExpected && input.benchmarkRejectedBars > 0)
    missing.push(`SPY:malformed_bars:${input.benchmarkRejectedBars}`);
  if (input.omittedPositionCount > 0)
    missing.push(`portfolio:omitted_positions:${input.omittedPositionCount}`);

  return {
    ...input.report,
    schemaVersion: "portfolio-exposure-v2",
    assetClasses: input.report.assetClasses.map((item) => ({
      ...item,
      source: "Derived from current Alpaca account and positions",
      ...accountTime,
    })),
    sectors: input.report.sectors.map((item) => ({
      ...item,
      source: "Derived from current Alpaca positions and SEC SIC",
      ...classificationTime,
    })),
    industries: input.report.industries.map((item) => ({
      ...item,
      source: "Derived from current Alpaca positions and SEC SIC",
      ...classificationTime,
    })),
    factors: input.report.factors.map((factor) => ({
      ...factor,
      source: "Derived from date-aligned Alpaca IEX daily bars",
      ...historicalTime,
    })),
    positions: input.report.positions.map((position) => {
      const evidence = evidenceBySymbol.get(position.symbol);
      const barTimes = evidence?.bars.map((bar) => bar.observedAt) ?? [];
      const retrievedAt = latestTime([
        input.accountRetrievedAt,
        evidence?.marketDataRetrievedAt,
        evidence?.classificationRetrievedAt,
      ])!;
      return {
        ...position,
        source: {
          currentPosition: tradingSource,
          marketHistory: evidence?.marketDataQueried ? marketSource : null,
          classification: evidence?.classificationQueried
            ? classificationSource
            : null,
        },
        ...successfulTime({
          observedAt: latestTime(barTimes),
          effectivePeriod: observationWindow(
            barTimes,
            `${position.symbol} exposure evidence window`,
          ),
          retrievedAt,
          serverRespondedAt: input.serverRespondedAt,
        }),
      };
    }),
    quality: {
      ...input.report.quality,
      status:
        input.report.positions.length === 0
          ? ("empty" as const)
          : missing.length
            ? ("partial" as const)
            : ("complete" as const),
      expected: {
        account: 1,
        positions: input.positionEvidence.length,
        positionHistories: input.positionEvidence.length,
        classifications: expectedEquityEvidence.length,
        benchmarkHistories: benchmarkExpected ? 1 : 0,
      },
      received: {
        account: 1,
        positions: input.positionEvidence.length,
        positionHistories: input.positionEvidence.filter(
          (position) => position.bars.length >= 2,
        ).length,
        classifications: expectedEquityEvidence.filter(
          (position) => position.classificationAvailable,
        ).length,
        benchmarkHistories:
          benchmarkExpected && input.benchmarkBars.length >= 2 ? 1 : 0,
      },
      omittedPositions: input.omittedPositionCount,
      rejected: {
        positionBars: input.positionEvidence.reduce(
          (sum, position) => sum + position.rejectedMarketBars,
          0,
        ),
        benchmarkBars: input.benchmarkRejectedBars,
      },
      missing,
      cache: {
        hit: input.cacheHit,
        externalEvidenceExpiresAt: isoTime(input.cacheExpiresAt),
      },
      source: "Calculated from the bounded portfolio-exposure evidence set",
      ...rootTime,
    },
    sources: input.report.sources.map((source) => {
      const evidence = evidenceBySymbol.get(source.symbol);
      return {
        ...source,
        ...providerTime({
          observedAt: null,
          retrievedAt: evidence?.classificationRetrievedAt ?? null,
          serverRespondedAt: input.serverRespondedAt,
        }),
      };
    }),
    inputs: {
      account: {
        available: true,
        source: tradingSource,
        ...accountTime,
      },
      positions: {
        count: input.positionEvidence.length,
        omitted: input.omittedPositionCount,
        source: tradingSource,
        ...accountTime,
      },
      benchmark: {
        symbol: "SPY",
        queried: input.benchmarkQueried,
        available: input.benchmarkBars.length >= 2,
        count: input.benchmarkBars.length,
        rejected: input.benchmarkRejectedBars,
        source: marketSource,
        ...benchmarkTime,
      },
      positionEvidence: positionInputs,
    },
    source: {
      account: tradingSource,
      marketHistory: marketSource,
      classifications: classificationSource,
    },
    ...rootTime,
  };
}
