import {
  normalizeIsoTime,
  providerTimeFields,
} from "../../shared/time-provenance";
import type { FilledOrder } from "../../shared/risk";
import type { FifoLot } from "./ledger";
import type {
  buildConstrainedRebalancePlan,
  ConstrainedRebalancePlanRequest,
} from "./rebalance-planner";

type DateInput = string | number | Date;
type RebalancePlan = ReturnType<typeof buildConstrainedRebalancePlan>;

export const REBALANCE_PRICE_STALE_SECONDS = 7 * 86_400;
export const REBALANCE_PRICE_FUTURE_TOLERANCE_SECONDS = 300;

export type RebalanceMarketEvidence = {
  symbol: string;
  price: number;
  fractionable: boolean;
  observedAt: string | null;
  rejectedObservationTime: boolean;
  tradeRetrievedAt: string;
  assetRetrievedAt: string;
};

const tradingSource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  environment: "paper" as const,
};

const marketSource = {
  provider: "alpaca" as const,
  api: "market-data" as const,
  endpoint: "latest-trade" as const,
  feed: "iex" as const,
};

const assetSource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  environment: "paper" as const,
  endpoint: "assets" as const,
};

const activitySource = {
  provider: "alpaca" as const,
  api: "trading" as const,
  environment: "paper" as const,
  endpoint: "account-activities" as const,
};

const calculationSource = {
  provider: "local" as const,
  component: "constrained-rebalance-planner" as const,
  methodology: "turnover-tax-cash-fifo-constraints" as const,
};

const policySource = {
  provider: "local" as const,
  component: "operations-policy" as const,
};

const userInputSource = {
  provider: "user" as const,
  component: "rebalance-plan-request" as const,
};

function optionalIsoTime(value: unknown) {
  if (
    !(
      typeof value === "string" ||
      typeof value === "number" ||
      value instanceof Date
    )
  )
    return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function latestTime(values: (DateInput | null | undefined)[]) {
  return (
    values
      .map(optionalIsoTime)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null
  );
}

function observationPeriod(
  values: (DateInput | null | undefined)[],
  label: string,
) {
  const times = values
    .map(optionalIsoTime)
    .filter((value): value is string => value !== null)
    .sort();
  return times.length ? { start: times[0], end: times.at(-1), label } : null;
}

export function rebalancePriceFreshness(
  observedAt: DateInput | null | undefined,
  evaluatedAt: DateInput,
) {
  const evaluation = normalizeIsoTime(
    evaluatedAt,
    "Rebalance price freshness evaluation time",
  );
  const observation = optionalIsoTime(observedAt);
  if (!observation) {
    return {
      status: "unavailable" as const,
      observedAt: null,
      ageSeconds: null,
      staleAfterSeconds: REBALANCE_PRICE_STALE_SECONDS,
    };
  }
  const rawAgeSeconds =
    (new Date(evaluation).getTime() - new Date(observation).getTime()) / 1_000;
  if (rawAgeSeconds < -REBALANCE_PRICE_FUTURE_TOLERANCE_SECONDS) {
    return {
      status: "future" as const,
      observedAt: observation,
      ageSeconds: rawAgeSeconds,
      staleAfterSeconds: REBALANCE_PRICE_STALE_SECONDS,
    };
  }
  const ageSeconds = Math.max(0, rawAgeSeconds);
  return {
    status:
      ageSeconds > REBALANCE_PRICE_STALE_SECONDS
        ? ("stale" as const)
        : ("fresh" as const),
    observedAt: observation,
    ageSeconds,
    staleAfterSeconds: REBALANCE_PRICE_STALE_SECONDS,
  };
}

export function normalizeRebalanceMarketEvidence(input: {
  symbol: string;
  price: unknown;
  fractionable: boolean;
  observedAt: unknown;
  tradeRetrievedAt: DateInput;
  assetRetrievedAt: DateInput;
}): RebalanceMarketEvidence {
  const symbol = input.symbol.trim().toUpperCase();
  if (!/^[A-Z.]{1,10}$/.test(symbol))
    throw new Error("Rebalance market symbol is invalid");
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0)
    throw new Error(`${symbol} latest IEX trade price is invalid`);
  const observedAt = optionalIsoTime(input.observedAt);
  return {
    symbol,
    price,
    fractionable: input.fractionable,
    observedAt,
    rejectedObservationTime:
      input.observedAt !== null &&
      input.observedAt !== undefined &&
      observedAt === null,
    tradeRetrievedAt: normalizeIsoTime(
      input.tradeRetrievedAt,
      `${symbol} trade retrieval time`,
    ),
    assetRetrievedAt: normalizeIsoTime(
      input.assetRetrievedAt,
      `${symbol} asset retrieval time`,
    ),
  };
}

export function rebalanceMarketEvidenceUsable(
  evidence: RebalanceMarketEvidence,
  evaluatedAt: DateInput,
) {
  return (
    !evidence.rejectedObservationTime &&
    rebalancePriceFreshness(evidence.observedAt, evaluatedAt).status === "fresh"
  );
}

/** Adds source, time, freshness, and calculation coverage to a rebalance plan. */
export function portfolioRebalanceDto(input: {
  plan: RebalancePlan;
  request: ConstrainedRebalancePlanRequest;
  currentPositions: { symbol: string; marketValue: number }[];
  marketEvidence: RebalanceMarketEvidence[];
  recentOrders: FilledOrder[];
  openLots: FifoLot[];
  accountRetrievedAt: DateInput;
  positionsRetrievedAt: DateInput;
  ordersRetrievedAt: DateInput;
  activitiesRetrievedAt: DateInput;
  activitiesCacheHit: boolean;
  activitiesTruncated: boolean;
  policy: {
    schemaVersion: string;
    maxDailyTurnoverPercent: number;
    updatedAt: DateInput | null;
  };
  policyRetrievedAt: DateInput;
  serverRespondedAt: DateInput;
}) {
  const serverRespondedAt = normalizeIsoTime(
    input.serverRespondedAt,
    "Rebalance response time",
  );
  const accountRetrievedAt = normalizeIsoTime(
    input.accountRetrievedAt,
    "Rebalance account retrieval time",
  );
  const positionsRetrievedAt = normalizeIsoTime(
    input.positionsRetrievedAt,
    "Rebalance positions retrieval time",
  );
  const ordersRetrievedAt = normalizeIsoTime(
    input.ordersRetrievedAt,
    "Rebalance orders retrieval time",
  );
  const activitiesRetrievedAt = normalizeIsoTime(
    input.activitiesRetrievedAt,
    "Rebalance activities retrieval time",
  );
  const policyRetrievedAt = normalizeIsoTime(
    input.policyRetrievedAt,
    "Rebalance policy retrieval time",
  );
  const marketBySymbol = new Map(
    input.marketEvidence.map((evidence) => [evidence.symbol, evidence]),
  );
  const positionSymbols = new Set(
    input.currentPositions.map((position) => position.symbol),
  );
  const marketInputs = input.marketEvidence.map((evidence) => {
    const freshness = rebalancePriceFreshness(
      evidence.observedAt,
      serverRespondedAt,
    );
    return {
      symbol: evidence.symbol,
      price: evidence.price,
      fractionable: evidence.fractionable,
      freshness,
      source: marketSource,
      ...providerTimeFields({
        observationTime: evidence.observedAt,
        publicationTime: null,
        effectivePeriod: null,
        retrievalTime: evidence.tradeRetrievedAt,
        serverResponseTime: serverRespondedAt,
      }),
      asset: {
        source: assetSource,
        ...providerTimeFields({
          observationTime: null,
          publicationTime: null,
          effectivePeriod: null,
          retrievalTime: evidence.assetRetrievedAt,
          serverResponseTime: serverRespondedAt,
        }),
      },
    };
  });
  const potentialFills = input.recentOrders.filter((order) => {
    const filledQuantity = Number(order.filledQty);
    return Boolean(
      order.filledAt ||
        (Number.isFinite(filledQuantity) && filledQuantity > 0) ||
        (order.filledAvgPrice !== null && order.filledAvgPrice !== undefined),
    );
  });
  const validFills = potentialFills.filter(
    (order) =>
      optionalIsoTime(order.filledAt) !== null &&
      order.filledQty !== undefined &&
      Number.isFinite(Number(order.filledQty)) &&
      Number(order.filledQty) > 0 &&
      order.filledAvgPrice !== null &&
      order.filledAvgPrice !== undefined &&
      Number.isFinite(Number(order.filledAvgPrice)) &&
      Number(order.filledAvgPrice) > 0,
  );
  const malformedFills = potentialFills.length - validFills.length;
  const orderWindowStart = new Date(serverRespondedAt).getTime() - 86_400_000;
  const validFillTimes = validFills.map((order) =>
    optionalIsoTime(order.filledAt),
  );
  const windowFillTimes = validFillTimes.filter((time): time is string => {
    if (!time) return false;
    const milliseconds = new Date(time).getTime();
    return (
      milliseconds >= orderWindowStart &&
      milliseconds <= new Date(serverRespondedAt).getTime()
    );
  });
  const futureFills = validFillTimes.filter(
    (time) => time && time > serverRespondedAt,
  ).length;
  const lotTimes = input.openLots.map((lot) => optionalIsoTime(lot.acquiredAt));
  const malformedLots = lotTimes.filter((time) => time === null).length;
  const rootObservedAt = latestTime([
    ...input.marketEvidence.map((evidence) => evidence.observedAt),
    ...windowFillTimes,
    ...lotTimes,
    input.policy.updatedAt,
  ]);
  const rootRetrievedAt = latestTime([
    accountRetrievedAt,
    positionsRetrievedAt,
    ordersRetrievedAt,
    activitiesRetrievedAt,
    policyRetrievedAt,
    ...input.marketEvidence.flatMap((evidence) => [
      evidence.tradeRetrievedAt,
      evidence.assetRetrievedAt,
    ]),
  ])!;
  const rootTime = providerTimeFields({
    observationTime: rootObservedAt,
    publicationTime: null,
    effectivePeriod: null,
    retrievalTime: rootRetrievedAt,
    serverResponseTime: serverRespondedAt,
  });
  const accountTime = providerTimeFields({
    observationTime: null,
    publicationTime: null,
    effectivePeriod: null,
    retrievalTime: accountRetrievedAt,
    serverResponseTime: serverRespondedAt,
  });
  const positionsTime = providerTimeFields({
    observationTime: null,
    publicationTime: null,
    effectivePeriod: null,
    retrievalTime: positionsRetrievedAt,
    serverResponseTime: serverRespondedAt,
  });
  const ordersTime = providerTimeFields({
    observationTime: latestTime(windowFillTimes),
    publicationTime: null,
    effectivePeriod: {
      start: new Date(orderWindowStart),
      end: serverRespondedAt,
      label: "Rolling 24-hour filled-order turnover window",
    },
    retrievalTime: ordersRetrievedAt,
    serverResponseTime: serverRespondedAt,
  });
  const activityTime = providerTimeFields({
    observationTime: latestTime(lotTimes),
    publicationTime: null,
    effectivePeriod: observationPeriod(
      lotTimes,
      "Imported FIFO acquisition history",
    ),
    retrievalTime: activitiesRetrievedAt,
    serverResponseTime: serverRespondedAt,
  });
  const policyTime = providerTimeFields({
    observationTime: input.policy.updatedAt,
    publicationTime: null,
    effectivePeriod: null,
    retrievalTime: policyRetrievedAt,
    serverResponseTime: serverRespondedAt,
  });
  const stalePrices = marketInputs.filter(
    (market) => market.freshness.status === "stale",
  );
  const futurePrices = marketInputs.filter(
    (market) => market.freshness.status === "future",
  );
  const unavailablePrices = marketInputs.filter(
    (market) => market.freshness.status === "unavailable",
  );
  const taxIncomplete = input.plan.tax.evidenceStatus === "incomplete";
  const taxCoverageExpected =
    input.plan.tax.evidenceStatus === "not_needed" ? 0 : 1;
  const taxCoverageReceived =
    input.plan.tax.evidenceStatus === "complete" ? 1 : 0;
  const missing = [
    ...(input.activitiesTruncated
      ? ["Account activity history reached its configured import bound."]
      : []),
    ...(taxIncomplete
      ? ["FIFO lot coverage is incomplete for at least one planned sale."]
      : []),
    ...(malformedLots
      ? [`${malformedLots} FIFO lots have invalid acquisition timestamps.`]
      : []),
    ...(malformedFills
      ? [`${malformedFills} potential order fills are malformed.`]
      : []),
    ...(futureFills
      ? [`${futureFills} potential order fills are future-dated.`]
      : []),
    ...stalePrices.map(
      (market) => `${market.symbol} latest IEX trade is stale.`,
    ),
    ...futurePrices.map(
      (market) => `${market.symbol} latest IEX trade is future-dated.`,
    ),
    ...unavailablePrices.map(
      (market) => `${market.symbol} has no provider trade observation time.`,
    ),
  ];
  const impact = missing.length
    ? [
        "The draft may omit or understate turnover or tax effects and cannot create execution authority; review the missing evidence before loading a basket.",
      ]
    : [
        "All bounded planner inputs are present; the basket preview still reloads broker and market state before any paper order can be authorized.",
      ];
  const calculationTime = { source: calculationSource, ...rootTime };

  return {
    ...input.plan,
    schemaVersion: "portfolio-rebalance-plan-v2",
    calculatedAt: normalizeIsoTime(
      input.plan.asOf,
      "Rebalance calculation time",
    ),
    summary: { ...input.plan.summary, ...calculationTime },
    scales: { ...input.plan.scales, ...calculationTime },
    tax: { ...input.plan.tax, source: calculationSource, ...activityTime },
    legs: input.plan.legs.map((leg) => {
      const evidence = marketBySymbol.get(leg.symbol);
      if (!evidence)
        throw new Error(
          `Rebalance leg ${leg.symbol} is missing market evidence`,
        );
      return {
        ...leg,
        source: calculationSource,
        priceSource: marketSource,
        ...providerTimeFields({
          observationTime: evidence.observedAt,
          publicationTime: null,
          effectivePeriod: null,
          retrievalTime: evidence.tradeRetrievedAt,
          serverResponseTime: serverRespondedAt,
        }),
      };
    }),
    positions: input.plan.positions.map((position) => {
      const market = marketBySymbol.get(position.symbol);
      return {
        ...position,
        currentPosition: {
          held: positionSymbols.has(position.symbol),
          source: tradingSource,
          ...positionsTime,
        },
        targetPrice: market
          ? {
              price: market.price,
              source: marketSource,
              ...providerTimeFields({
                observationTime: market.observedAt,
                publicationTime: null,
                effectivePeriod: null,
                retrievalTime: market.tradeRetrievedAt,
                serverResponseTime: serverRespondedAt,
              }),
            }
          : null,
        ...calculationTime,
      };
    }),
    warnings: [
      ...new Set([
        ...input.plan.warnings,
        "Target prices use Alpaca IEX latest trades, not consolidated SIP market data.",
        ...missing,
        ...(missing.length ? impact : []),
      ]),
    ],
    inputs: {
      account: { available: true, source: tradingSource, ...accountTime },
      positions: {
        count: input.currentPositions.length,
        source: tradingSource,
        ...positionsTime,
      },
      targetMarket: {
        expected: input.request.targets.length,
        received: marketInputs.length,
        source: marketSource,
        records: marketInputs,
      },
      recentOrders: {
        count: input.recentOrders.length,
        validFills: validFills.length,
        fillsInWindow: windowFillTimes.length,
        malformedFills,
        futureFills,
        completeWindow: input.recentOrders.length < 500,
        source: tradingSource,
        ...ordersTime,
      },
      accountActivities: {
        cacheHit: input.activitiesCacheHit,
        truncated: input.activitiesTruncated,
        openLots: input.openLots.length,
        malformedLots,
        source: activitySource,
        ...activityTime,
      },
      operationsPolicy: {
        schemaVersion: input.policy.schemaVersion,
        maxDailyTurnoverPercent: input.policy.maxDailyTurnoverPercent,
        source: policySource,
        ...policyTime,
      },
      userRequest: {
        targets: input.request.targets.length,
        source: userInputSource,
        receivedAt: serverRespondedAt,
      },
    },
    quality: {
      status: missing.length ? ("partial" as const) : ("complete" as const),
      expected: {
        account: 1,
        currentPositions: input.currentPositions.length,
        targetAssets: input.request.targets.length,
        targetPrices: input.request.targets.length,
        recentOrderWindow: 1,
        accountActivityHistory: 1,
        taxLotCoverage: taxCoverageExpected,
      },
      received: {
        account: 1,
        currentPositions: input.currentPositions.length,
        targetAssets: marketInputs.length,
        targetPrices: marketInputs.length,
        targetPricesWithObservation: marketInputs.filter(
          (market) => market.observedAt !== null,
        ).length,
        recentOrderWindow: input.recentOrders.length < 500 ? 1 : 0,
        accountActivityHistory: input.activitiesTruncated ? 0 : 1,
        taxLotCoverage: taxCoverageReceived,
      },
      omitted: {
        targetAssets: input.request.targets.length - marketInputs.length,
        targetPrices: input.request.targets.length - marketInputs.length,
        recentOrderWindow: input.recentOrders.length < 500 ? 0 : 1,
        accountActivityHistory: input.activitiesTruncated ? 1 : 0,
        taxLotCoverage: taxCoverageExpected - taxCoverageReceived,
        uncoveredTaxLotQuantity: input.plan.tax.uncoveredQuantity,
      },
      rejected: {
        marketObservationTimes: input.marketEvidence.filter(
          (evidence) => evidence.rejectedObservationTime,
        ).length,
        orderFills: malformedFills + futureFills,
        taxLots: malformedLots,
      },
      freshness: {
        evaluatedAt: serverRespondedAt,
        marketPriceStaleAfterSeconds: REBALANCE_PRICE_STALE_SECONDS,
        marketPrices: {
          fresh: marketInputs.filter(
            (market) => market.freshness.status === "fresh",
          ).length,
          stale: stalePrices.length,
          future: futurePrices.length,
          unavailable: unavailablePrices.length,
        },
        accountAndPositions: "retrieval_time_only" as const,
        assetMetadata: "retrieval_time_only" as const,
      },
      missing,
      impact,
      source: "Calculated from the bounded constrained-rebalance evidence set",
      ...rootTime,
    },
    source: {
      account: tradingSource,
      positions: tradingSource,
      targetPrices: marketSource,
      targetAssets: assetSource,
      taxLots: activitySource,
      operationsPolicy: policySource,
      calculation: calculationSource,
      userRequest: userInputSource,
    },
    ...rootTime,
  };
}
