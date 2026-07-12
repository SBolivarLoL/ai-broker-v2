import { expect, test } from "bun:test";
import {
  normalizeOptimizerHistory,
  optimizerHistoryFreshness,
  optimizerHistoryUsable,
  portfolioOptimizerDto,
} from "../../backend/features/portfolio/optimizer-response";
import { buildPortfolioOptimizerReport } from "../../backend/features/portfolio/portfolio-optimizer";

test("optimizer history normalization rejects malformed and conflicting timestamp evidence", () => {
  const history = normalizeOptimizerHistory({
    symbol: "AAPL",
    marketValue: 1_000,
    retrievedAt: "2026-01-10T00:00:00Z",
    rawBars: [
      { timestamp: "2026-01-03T20:00:00Z", close: "103" },
      { timestamp: "2026-01-01T20:00:00Z", close: 100 },
      { timestamp: "2026-01-01T20:00:00Z", close: 100 },
      { timestamp: "2026-01-02T20:00:00Z", close: 101 },
      { timestamp: "2026-01-02T20:00:00Z", close: 102 },
      { timestamp: "invalid", close: 104 },
      { timestamp: "2026-01-04T20:00:00Z", close: -1 },
    ],
  });

  expect(history).toEqual({
    symbol: "AAPL",
    marketValue: 1_000,
    inputBars: 7,
    bars: [
      { observedAt: "2026-01-01T20:00:00.000Z", close: 100 },
      { observedAt: "2026-01-03T20:00:00.000Z", close: 103 },
    ],
    rejectedBars: 2,
    duplicateBars: 1,
    conflictingBars: 2,
    retrievedAt: "2026-01-10T00:00:00.000Z",
  });
  expect(() =>
    normalizeOptimizerHistory({
      symbol: "",
      marketValue: 1_000,
      retrievedAt: "2026-01-10T00:00:00Z",
      rawBars: [],
    }),
  ).toThrow("symbol is invalid");
  expect(() =>
    normalizeOptimizerHistory({
      symbol: "AAPL",
      marketValue: Number.NaN,
      retrievedAt: "2026-01-10T00:00:00Z",
      rawBars: [],
    }),
  ).toThrow("market value must be positive");
});

test("optimizer history requires enough fresh return observations", () => {
  const history = normalizeOptimizerHistory({
    symbol: "AAPL",
    marketValue: 1_000,
    retrievedAt: "2026-01-20T00:00:00Z",
    rawBars: Array.from({ length: 12 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, index + 1, 20)),
      close: 100 + index,
    })),
  });

  expect(
    optimizerHistoryFreshness(history, "2026-01-13T00:00:00Z"),
  ).toMatchObject({ status: "fresh", observedAt: "2026-01-12T20:00:00.000Z" });
  expect(
    optimizerHistoryUsable(history, 10, "2026-01-13T00:00:00Z"),
  ).toBeTrue();
  expect(
    optimizerHistoryUsable(history, 12, "2026-01-13T00:00:00Z"),
  ).toBeFalse();
  expect(
    optimizerHistoryFreshness(history, "2026-01-21T00:00:01Z"),
  ).toMatchObject({ status: "stale" });
  expect(
    optimizerHistoryUsable(history, 10, "2026-01-21T00:00:01Z"),
  ).toBeFalse();
  expect(
    optimizerHistoryFreshness(history, "2026-01-12T19:54:59Z"),
  ).toMatchObject({ status: "future" });
  expect(
    optimizerHistoryUsable(history, 10, "2026-01-12T19:54:59Z"),
  ).toBeFalse();
});

test("optimizer response keeps an empty account and unqueried market history explicit", () => {
  const report = buildPortfolioOptimizerReport({
    equity: 100_000,
    positions: [],
    request: { minObservations: 10 },
    asOf: "2026-01-20T10:00:00Z",
  });
  const response = portfolioOptimizerDto({
    report,
    histories: [],
    totalPositionCount: 0,
    omittedPositionCount: 0,
    minObservations: 10,
    accountRetrievedAt: "2026-01-20T10:00:00Z",
    evaluatedAt: "2026-01-20T10:00:00Z",
    serverRespondedAt: "2026-01-20T10:00:01Z",
  });

  expect(response).toMatchObject({
    schemaVersion: "portfolio-optimizer-v2",
    observedAt: null,
    retrievedAt: "2026-01-20T10:00:00.000Z",
    serverRespondedAt: "2026-01-20T10:00:01.000Z",
    proposals: [],
    inputs: {
      account: { available: true, retrievedAt: "2026-01-20T10:00:00.000Z" },
      positions: { total: 0, eligibleLongUsEquity: 0, omitted: 0 },
      marketHistory: { queried: false, count: 0, retrievedAt: null },
      marketHistories: [],
    },
    quality: {
      status: "empty",
      expected: { currentPositions: 0, eligibleMarketHistories: 0 },
      received: { usableMarketHistories: 0 },
      missing: [],
    },
  });

  const inconsistentReport = buildPortfolioOptimizerReport({
    equity: 100_000,
    positions: [{
      symbol: "AAPL",
      marketValue: 1_000,
      closes: Array.from({ length: 12 }, (_, index) => 100 + index),
    }],
    request: {
      minObservations: 10,
      maxWeightPercent: 100,
      maxTurnoverPercent: 100,
      cashReservePercent: 0,
    },
  });
  expect(() => portfolioOptimizerDto({
    report: inconsistentReport,
    histories: [],
    totalPositionCount: 1,
    omittedPositionCount: 0,
    minObservations: 10,
    accountRetrievedAt: "2026-01-20T10:00:00Z",
    evaluatedAt: "2026-01-20T10:00:00Z",
    serverRespondedAt: "2026-01-20T10:00:01Z",
  })).toThrow("missing history evidence");
});

test("optimizer response explains stale and unavailable history impact", () => {
  const stale = normalizeOptimizerHistory({
    symbol: "OLD",
    marketValue: 1_000,
    retrievedAt: "2026-01-20T10:00:00Z",
    rawBars: Array.from({ length: 12 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2025, 11, index + 1, 20)),
      close: 100 + index,
    })),
  });
  const unavailable = normalizeOptimizerHistory({
    symbol: "NONE",
    marketValue: 1_000,
    retrievedAt: "2026-01-20T10:00:00Z",
    rawBars: [{ timestamp: "invalid", close: 100 }],
  });
  const report = buildPortfolioOptimizerReport({
    equity: 100_000,
    positions: [
      { symbol: "OLD", marketValue: 1_000, closes: [] },
      { symbol: "NONE", marketValue: 1_000, closes: [] },
    ],
    request: { minObservations: 10 },
  });
  const response = portfolioOptimizerDto({
    report,
    histories: [stale, unavailable],
    totalPositionCount: 2,
    omittedPositionCount: 0,
    minObservations: 10,
    accountRetrievedAt: "2026-01-20T09:59:59Z",
    evaluatedAt: "2026-01-20T10:00:00Z",
    serverRespondedAt: "2026-01-20T10:00:01Z",
  });

  expect(response.quality).toMatchObject({
    status: "partial",
    received: { marketHistories: 2, usableMarketHistories: 0 },
    omitted: { marketHistories: 2 },
    rejected: { malformedBars: 1 },
    freshness: {
      freshHistories: 0,
      staleHistories: 1,
      unavailableHistories: 1,
      futureHistories: 0,
    },
  });
  expect(response.quality.missing).toContain("OLD market history is stale.");
  expect(response.quality.missing).toContain(
    "NONE has no valid market observation time.",
  );
  expect(response.quality.impact[0]).toContain("fresh eligible histories");
  expect(response.warnings).toContain(response.quality.impact[0]);
});
