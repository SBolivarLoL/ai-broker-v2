import { expect, test } from "bun:test";
import {
  normalizeRebalanceMarketEvidence,
  portfolioRebalanceDto,
  rebalanceMarketEvidenceUsable,
  rebalancePriceFreshness,
} from "../../backend/features/portfolio/rebalance-response";
import {
  buildConstrainedRebalancePlan,
  ConstrainedRebalancePlanRequest,
} from "../../backend/features/portfolio/rebalance-planner";

const responseTime = "2026-01-10T20:00:02.000Z";
const request = ConstrainedRebalancePlanRequest.parse({
  targets: [
    { symbol: "AAPL", targetWeightPercent: 20 },
    { symbol: "MSFT", targetWeightPercent: 60 },
  ],
  maxTurnoverPercent: 10,
});
const currentPositions = [
  { symbol: "AAPL", marketValue: 40_000 },
  { symbol: "MSFT", marketValue: 40_000 },
];
const openLots = [
  {
    symbol: "AAPL",
    quantity: 400,
    price: 80,
    acquiredAt: "2025-01-01T15:30:00.000Z",
  },
];

function marketEvidence(
  symbol: string,
  observedAt = "2026-01-09T20:00:00.000Z",
) {
  return normalizeRebalanceMarketEvidence({
    symbol,
    price: 100,
    fractionable: true,
    observedAt,
    tradeRetrievedAt: "2026-01-10T20:00:00.000Z",
    assetRetrievedAt: "2026-01-10T19:59:59.000Z",
  });
}

function plan(
  input: { taxLotsComplete?: boolean; lots?: typeof openLots } = {},
) {
  return buildConstrainedRebalancePlan({
    asOf: "2026-01-10T20:00:01.000Z",
    account: { equity: 100_000, cash: 20_000 },
    positions: [
      {
        symbol: "AAPL",
        qty: 400,
        marketValue: 40_000,
        price: 100,
        fractionable: true,
      },
      {
        symbol: "MSFT",
        qty: 400,
        marketValue: 40_000,
        price: 100,
        fractionable: true,
      },
    ],
    market: [
      { symbol: "AAPL", price: 100, fractionable: true },
      { symbol: "MSFT", price: 100, fractionable: true },
    ],
    openLots: input.lots ?? openLots,
    taxLotsComplete: input.taxLotsComplete ?? true,
    request,
    currentTurnoverNotional: 0,
    policyMaxTurnoverPercent: 10,
  });
}

function dtoInput(
  overrides: Partial<Parameters<typeof portfolioRebalanceDto>[0]> = {},
) {
  return {
    plan: plan(),
    request,
    currentPositions,
    marketEvidence: [marketEvidence("AAPL"), marketEvidence("MSFT")],
    recentOrders: [
      {
        filledAt: "2026-01-10T15:00:00.000Z",
        filledQty: "2",
        filledAvgPrice: "100",
      },
      { filledAt: null, filledQty: "0", filledAvgPrice: null },
    ],
    openLots,
    accountRetrievedAt: "2026-01-10T19:59:58.000Z",
    positionsRetrievedAt: "2026-01-10T19:59:58.000Z",
    ordersRetrievedAt: "2026-01-10T19:59:59.000Z",
    activitiesRetrievedAt: "2026-01-10T19:59:57.000Z",
    activitiesCacheHit: false,
    activitiesTruncated: false,
    policy: {
      schemaVersion: "operations-policy-v1",
      maxDailyTurnoverPercent: 10,
      updatedAt: "2026-01-05T12:00:00.000Z",
    },
    policyRetrievedAt: "2026-01-10T20:00:01.000Z",
    serverRespondedAt: responseTime,
    ...overrides,
  };
}

test("normalizes fresh IEX trade evidence and rejects malformed prices", () => {
  const evidence = marketEvidence("aapl");
  expect(evidence).toEqual({
    symbol: "AAPL",
    price: 100,
    fractionable: true,
    observedAt: "2026-01-09T20:00:00.000Z",
    rejectedObservationTime: false,
    tradeRetrievedAt: "2026-01-10T20:00:00.000Z",
    assetRetrievedAt: "2026-01-10T19:59:59.000Z",
  });
  expect(rebalanceMarketEvidenceUsable(evidence, responseTime)).toBeTrue();
  expect(() =>
    normalizeRebalanceMarketEvidence({
      symbol: "AAPL",
      price: 0,
      fractionable: true,
      observedAt: "2026-01-09T20:00:00.000Z",
      tradeRetrievedAt: responseTime,
      assetRetrievedAt: responseTime,
    }),
  ).toThrow("latest IEX trade price is invalid");
  expect(() =>
    normalizeRebalanceMarketEvidence({
      symbol: "",
      price: 100,
      fractionable: true,
      observedAt: null,
      tradeRetrievedAt: responseTime,
      assetRetrievedAt: responseTime,
    }),
  ).toThrow("symbol is invalid");
});

test("rebalance freshness distinguishes stale future and unavailable trades", () => {
  expect(
    rebalancePriceFreshness("2025-12-01T20:00:00Z", responseTime),
  ).toMatchObject({ status: "stale" });
  expect(
    rebalancePriceFreshness("2026-01-10T20:06:00Z", responseTime),
  ).toMatchObject({ status: "future" });
  expect(rebalancePriceFreshness(null, responseTime)).toMatchObject({
    status: "unavailable",
    observedAt: null,
  });
  const malformed = normalizeRebalanceMarketEvidence({
    symbol: "AAPL",
    price: 100,
    fractionable: true,
    observedAt: "invalid",
    tradeRetrievedAt: responseTime,
    assetRetrievedAt: responseTime,
  });
  expect(malformed).toMatchObject({
    observedAt: null,
    rejectedObservationTime: true,
  });
  expect(rebalanceMarketEvidenceUsable(malformed, responseTime)).toBeFalse();
});

test("rebalance response preserves staged evidence and complete coverage", () => {
  const response = portfolioRebalanceDto(dtoInput());

  expect(response).toMatchObject({
    schemaVersion: "portfolio-rebalance-plan-v2",
    observedAt: "2026-01-10T15:00:00.000Z",
    retrievedAt: "2026-01-10T20:00:01.000Z",
    serverRespondedAt: responseTime,
    asOf: responseTime,
    quality: {
      status: "complete",
      expected: {
        account: 1,
        currentPositions: 2,
        targetAssets: 2,
        targetPrices: 2,
        taxLotCoverage: 1,
      },
      received: {
        account: 1,
        currentPositions: 2,
        targetAssets: 2,
        targetPrices: 2,
        targetPricesWithObservation: 2,
        taxLotCoverage: 1,
      },
      freshness: {
        marketPrices: { fresh: 2, stale: 0, future: 0, unavailable: 0 },
        accountAndPositions: "retrieval_time_only",
      },
      missing: [],
    },
    inputs: {
      account: {
        observedAt: null,
        retrievedAt: "2026-01-10T19:59:58.000Z",
        serverRespondedAt: responseTime,
      },
      recentOrders: {
        count: 2,
        validFills: 1,
        malformedFills: 0,
        observedAt: "2026-01-10T15:00:00.000Z",
      },
      accountActivities: {
        cacheHit: false,
        openLots: 1,
        observedAt: "2025-01-01T15:30:00.000Z",
      },
      operationsPolicy: {
        observedAt: "2026-01-05T12:00:00.000Z",
      },
    },
  });
  expect(response.legs).toHaveLength(2);
  expect(response.legs[0]).toMatchObject({
    symbol: "AAPL",
    source: { provider: "local", component: "constrained-rebalance-planner" },
    priceSource: { provider: "alpaca", feed: "iex" },
    observedAt: "2026-01-09T20:00:00.000Z",
    retrievedAt: "2026-01-10T20:00:00.000Z",
    serverRespondedAt: responseTime,
  });
  expect(response.warnings).toContain(
    "Target prices use Alpaca IEX latest trades, not consolidated SIP market data.",
  );
});

test("rebalance response makes incomplete tax and stale inputs consequential", () => {
  const incompletePlan = plan({ taxLotsComplete: false, lots: [] });
  const response = portfolioRebalanceDto(
    dtoInput({
      plan: incompletePlan,
      marketEvidence: [
        marketEvidence("AAPL", "2025-12-01T20:00:00.000Z"),
        marketEvidence("MSFT"),
      ],
      recentOrders: [
        { filledAt: "invalid", filledQty: "2", filledAvgPrice: "100" },
      ],
      openLots: [],
      activitiesTruncated: true,
    }),
  );

  expect(response.quality).toMatchObject({
    status: "partial",
    received: { accountActivityHistory: 0, taxLotCoverage: 0 },
    omitted: { accountActivityHistory: 1, taxLotCoverage: 1 },
    rejected: { orderFills: 1, taxLots: 0 },
    freshness: {
      marketPrices: { fresh: 1, stale: 1, future: 0, unavailable: 0 },
    },
  });
  expect(response.quality.missing).toContain(
    "Account activity history reached its configured import bound.",
  );
  expect(response.quality.missing).toContain(
    "FIFO lot coverage is incomplete for at least one planned sale.",
  );
  expect(response.quality.missing).toContain("AAPL latest IEX trade is stale.");
  expect(response.warnings).toContain("AAPL latest IEX trade is stale.");
  expect(response.warnings).toContain(response.quality.impact[0]!);
});

test("rebalance response fails when a planned leg lacks price evidence", () => {
  expect(() => portfolioRebalanceDto(dtoInput({ marketEvidence: [] }))).toThrow(
    "missing market evidence",
  );
});
