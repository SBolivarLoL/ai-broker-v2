import type { StockBarSource } from "../../integrations/alpaca/market-data";
import {
  providerTimeFields,
  type EffectivePeriodInput,
} from "../../shared/time-provenance";
import {
  historicalRisk,
  portfolioHistory,
  riskSnapshot,
  type Position,
} from "../../shared/risk";
import { advancedPortfolioRisk, positionLiquidity } from "./advanced-risk";
import { diversificationScopes, stressTests, valueAtRisk95 } from "./analytics";

type DateInput = string | number | Date;
type RiskBar = {
  timestamp?: DateInput;
  close: number;
  volume: number;
};
type RiskMarketSnapshot = {
  latestQuote?: {
    bp?: unknown;
    ap?: unknown;
    t?: DateInput;
  };
};

export type PortfolioRiskPositionData = {
  position: Position;
  bars: RiskBar[];
  barSource: StockBarSource;
  marketSnapshot: RiskMarketSnapshot;
};

const tradingSource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  environment: "paper" as const,
};
const quoteSource = {
  provider: "alpaca" as const,
  api: "market-data" as const,
  feed: "iex" as const,
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
  return times.length ? { start: times[0], end: times.at(-1), label } : null;
}

function timeFields(input: {
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

function quoteAvailable(snapshot: RiskMarketSnapshot) {
  const bid = Number(snapshot.latestQuote?.bp);
  const ask = Number(snapshot.latestQuote?.ap);
  return Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0;
}

/** Builds the browser-facing portfolio-risk DTO from one bounded evidence set. */
export function portfolioRiskDto(input: {
  account: { equity: string | number; cash: string | number };
  positions: Position[];
  positionData: PortfolioRiskPositionData[];
  benchmarkBars: RiskBar[];
  benchmarkSource: StockBarSource;
  accountRetrievedAt: DateInput;
  marketRetrievedAt: DateInput;
  serverRespondedAt: DateInput;
}) {
  const snapshot = riskSnapshot(
    input.account.equity,
    input.account.cash,
    input.positions,
  );
  const series = input.positionData.map((item) => ({
    marketValue: Number(item.position.marketValue),
    closes: item.bars.map((bar) => bar.close),
  }));
  const history = portfolioHistory(snapshot.equity, snapshot.cash, series);
  const advanced = advancedPortfolioRisk(
    snapshot.equity,
    input.positionData.map((item) => ({
      symbol: item.position.symbol,
      weight: Number(item.position.marketValue) / snapshot.equity,
      closes: item.bars.map((bar) => bar.close),
    })),
    input.benchmarkBars.map((bar) => bar.close),
  );
  const positionBarTimes = input.positionData.flatMap((item) =>
    item.bars.map((bar) => bar.timestamp),
  );
  const benchmarkBarTimes = input.benchmarkBars.map((bar) => bar.timestamp);
  const quoteTimes = input.positionData.map(
    (item) => item.marketSnapshot.latestQuote?.t,
  );
  const historicalPeriod = observationWindow(
    [...positionBarTimes, ...benchmarkBarTimes],
    "Trailing Alpaca daily-bar risk input window",
  );
  const historicalObservedAt = latestTime([
    ...positionBarTimes,
    ...benchmarkBarTimes,
  ]);
  const marketObservedAt = latestTime([
    ...positionBarTimes,
    ...benchmarkBarTimes,
    ...quoteTimes,
  ]);
  const accountTime = timeFields({
    observedAt: null,
    retrievedAt: input.accountRetrievedAt,
    serverRespondedAt: input.serverRespondedAt,
  });
  const historicalTime = timeFields({
    observedAt: historicalObservedAt,
    effectivePeriod: historicalPeriod,
    retrievedAt: input.marketRetrievedAt,
    serverRespondedAt: input.serverRespondedAt,
  });
  const rootTime = timeFields({
    observedAt: marketObservedAt,
    effectivePeriod: historicalPeriod,
    retrievedAt: input.marketRetrievedAt,
    serverRespondedAt: input.serverRespondedAt,
  });
  const benchmarkTime = timeFields({
    observedAt: latestTime(benchmarkBarTimes),
    effectivePeriod: observationWindow(
      benchmarkBarTimes,
      "SPY daily-bar benchmark window",
    ),
    retrievedAt: input.marketRetrievedAt,
    serverRespondedAt: input.serverRespondedAt,
  });

  const positionMarketData = input.positionData.map((item) => {
    const barTimes = item.bars.map((bar) => bar.timestamp);
    const quoteObservedAt = isoTime(item.marketSnapshot.latestQuote?.t);
    return {
      symbol: item.position.symbol,
      historicalBars: {
        count: item.bars.length,
        source: item.barSource,
        ...timeFields({
          observedAt: latestTime(barTimes),
          effectivePeriod: observationWindow(
            barTimes,
            `${item.position.symbol} daily-bar risk window`,
          ),
          retrievedAt: input.marketRetrievedAt,
          serverRespondedAt: input.serverRespondedAt,
        }),
      },
      quote: {
        available: quoteAvailable(item.marketSnapshot),
        source: quoteSource,
        ...timeFields({
          observedAt: quoteObservedAt,
          retrievedAt: input.marketRetrievedAt,
          serverRespondedAt: input.serverRespondedAt,
        }),
      },
    };
  });

  const missing: string[] = [];
  for (const item of positionMarketData) {
    if (item.historicalBars.count < 2)
      missing.push(`${item.symbol}:historical_bars`);
    if (item.historicalBars.observedAt === null)
      missing.push(`${item.symbol}:historical_bar_observation_time`);
    if (!item.quote.available) missing.push(`${item.symbol}:quote`);
    if (item.quote.observedAt === null)
      missing.push(`${item.symbol}:quote_observation_time`);
  }
  if (input.benchmarkBars.length < 2) missing.push("SPY:benchmark_bars");
  if (benchmarkTime.observedAt === null)
    missing.push("SPY:benchmark_observation_time");
  const warnings = [
    ...new Set(
      [
        ...input.positionData.map((item) => item.barSource.warning),
        input.benchmarkSource.warning,
        ...missing.map((item) => `Missing or insufficient ${item}.`),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  const currentPositionTime = (source: string) => ({
    source,
    ...accountTime,
  });
  const advancedSource =
    "Derived from Alpaca historical position and SPY daily bars";
  const expected = {
    account: 1,
    positions: input.positions.length,
    positionHistories: input.positions.length,
    positionQuotes: input.positions.length,
    benchmarkHistories: 1,
  };
  const received = {
    account: 1,
    positions: input.positions.length,
    positionHistories: positionMarketData.filter(
      (item) => item.historicalBars.count >= 2,
    ).length,
    positionQuotes: positionMarketData.filter((item) => item.quote.available)
      .length,
    benchmarkHistories: input.benchmarkBars.length >= 2 ? 1 : 0,
  };
  const observationExpected = input.positions.length * 2 + 1;
  const observationReceived =
    positionMarketData.filter((item) => item.historicalBars.observedAt !== null)
      .length +
    positionMarketData.filter((item) => item.quote.observedAt !== null).length +
    (benchmarkTime.observedAt === null ? 0 : 1);
  const impact = missing.length
    ? [
        "Risk, liquidity, benchmark, or diversification conclusions may be unavailable or based on a reduced evidence set; missing inputs are not imputed.",
      ]
    : [
        "The bounded risk evidence set is complete; provider timestamps remain visible because this calculation does not apply one universal age cutoff across daily bars and quotes.",
      ];

  return {
    schemaVersion: "portfolio-risk-v2",
    ...snapshot,
    weights: snapshot.weights.map((weight) => ({
      ...weight,
      ...currentPositionTime("Derived from current Alpaca positions"),
    })),
    ...historicalRisk(history),
    ...valueAtRisk95(snapshot.equity, history),
    advanced: {
      ...advanced,
      correlation: advanced.correlation.map((row) => ({
        ...row,
        source: advancedSource,
        ...historicalTime,
      })),
      riskContribution: advanced.riskContribution.map((item) => ({
        ...item,
        source: advancedSource,
        ...historicalTime,
      })),
      benchmark: {
        ...advanced.benchmark,
        symbol: "SPY",
        source: input.benchmarkSource,
        sourceIdentity: "Alpaca historical stock bars",
        ...benchmarkTime,
      },
      source: advancedSource,
      ...historicalTime,
    },
    liquidity: input.positionData.map((item) => {
      const barTimes = item.bars.map((bar) => bar.timestamp);
      return {
        ...positionLiquidity(item.position, item.marketSnapshot, item.bars),
        source: {
          position: tradingSource,
          quote: quoteSource,
          historicalVolume: item.barSource,
        },
        ...timeFields({
          observedAt: latestTime([
            ...barTimes,
            item.marketSnapshot.latestQuote?.t,
          ]),
          effectivePeriod: observationWindow(
            barTimes,
            `${item.position.symbol} ADV input window`,
          ),
          retrievedAt: input.marketRetrievedAt,
          serverRespondedAt: input.serverRespondedAt,
        }),
      };
    }),
    diversification: {
      ...diversificationScopes(
        snapshot.hhi,
        snapshot.largestPositionPercent,
        input.positions.map((position) => Number(position.marketValue)),
      ),
      ...currentPositionTime("Derived from current Alpaca positions"),
    },
    stressTests: stressTests(
      snapshot.equity,
      snapshot.cash,
      snapshot.weights,
    ).map((stressTest) => ({
      ...stressTest,
      ...currentPositionTime(
        "Derived from current Alpaca account and positions",
      ),
    })),
    inputs: {
      account: {
        available: true,
        source: tradingSource,
        ...accountTime,
      },
      positions: {
        count: input.positions.length,
        source: tradingSource,
        ...accountTime,
      },
      positionMarketData,
      benchmark: {
        symbol: "SPY",
        count: input.benchmarkBars.length,
        source: input.benchmarkSource,
        ...benchmarkTime,
      },
    },
    quality: {
      status:
        input.positions.length === 0
          ? ("empty" as const)
          : missing.length
            ? ("partial" as const)
            : ("complete" as const),
      expected,
      received,
      omitted: {
        account: expected.account - received.account,
        positions: expected.positions - received.positions,
        positionHistories:
          expected.positionHistories - received.positionHistories,
        positionQuotes: expected.positionQuotes - received.positionQuotes,
        benchmarkHistories:
          expected.benchmarkHistories - received.benchmarkHistories,
      },
      freshness: {
        status:
          observationReceived === observationExpected
            ? ("observed" as const)
            : ("partial" as const),
        expectedObservations: observationExpected,
        receivedObservations: observationReceived,
        latestObservedAt: rootTime.observedAt,
        evaluatedAt: rootTime.serverRespondedAt,
        agePolicy: "provider_timestamps_only" as const,
      },
      missing,
      warnings,
      impact,
      source: "Calculated from the bounded portfolio-risk evidence set",
      ...rootTime,
    },
    source: {
      account: tradingSource,
      positionMarketData: "Alpaca entitlement-aware stock bars and IEX quotes",
      benchmark: input.benchmarkSource,
    },
    ...rootTime,
  };
}
