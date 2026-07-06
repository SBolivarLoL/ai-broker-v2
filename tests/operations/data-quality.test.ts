import { expect, test } from "bun:test";
import { buildDataQualityReport } from "../../backend/features/operations/data-quality";
import { DATA_GOVERNANCE_SOURCES } from "../../backend/features/operations/data-governance";

test("builds provider health from local success issue and throttle events", () => {
  const report = buildDataQualityReport({
    sources: DATA_GOVERNANCE_SOURCES,
    generatedAt: "2026-07-07T12:00:00.000Z",
    events: [
      {
        type: "strategy.dataset.ingested",
        createdAt: "2026-07-07T11:00:00.000Z",
        payload: { datasetId: "dataset-1" },
      },
      {
        type: "research.completed",
        createdAt: "2026-07-07T10:00:00.000Z",
        payload: { runId: "research-1" },
      },
      {
        type: "strategy.crypto.order.preview",
        createdAt: "2026-07-07T09:00:00.000Z",
        payload: { warning: "rate limit 429 from provider" },
      },
    ],
  });

  expect(report).toMatchObject({
    reportVersion: "data-quality-v1",
    summary: {
      providerCount: DATA_GOVERNANCE_SOURCES.length,
      degradedProviders: expect.any(Number),
      unobservedProviders: expect.any(Number),
    },
  });
  expect(report.providers.find((provider) => provider.sourceId === "alpaca_crypto_data")).toMatchObject({
    status: "throttled",
    eventCount: 2,
    throttlingEvents: 1,
    lastEventAt: "2026-07-07T11:00:00.000Z",
  });
  expect(report.providers.find((provider) => provider.sourceId === "gdelt_doc_2")).toMatchObject({
    status: "healthy",
    lastSuccessAt: "2026-07-07T10:00:00.000Z",
  });
  expect(report.providers.find((provider) => provider.sourceId === "alpaca_stock_sip")).toMatchObject({
    status: "unobserved",
    eventCount: 0,
  });
});

test("marks stale and degraded provider health from local evidence", () => {
  const sources = DATA_GOVERNANCE_SOURCES.filter((source) =>
    ["alpaca_equity_iex", "gdelt_doc_2"].includes(source.id),
  );
  const report = buildDataQualityReport({
    sources,
    generatedAt: "2026-07-07T12:00:00.000Z",
    events: [
      {
        type: "research.completed",
        createdAt: "2026-07-05T10:00:00.000Z",
        payload: { runId: "research-older-than-24h" },
      },
      {
        type: "order.preview",
        createdAt: "2026-07-07T11:30:00.000Z",
        payload: { error: "provider failed before preview" },
      },
    ],
  });

  expect(report.providers.find((provider) => provider.sourceId === "gdelt_doc_2")).toMatchObject({
    status: "stale",
    lastSuccessAt: "2026-07-05T10:00:00.000Z",
  });
  expect(report.providers.find((provider) => provider.sourceId === "alpaca_equity_iex")).toMatchObject({
    status: "degraded",
    issueCount: 1,
    lastSuccessAt: null,
  });
});

test("summarizes immutable strategy dataset quality stats", () => {
  const report = buildDataQualityReport({
    sources: DATA_GOVERNANCE_SOURCES,
    generatedAt: "2026-07-07T12:00:00.000Z",
    datasets: [
      {
        id: "dataset-1",
        provider: "Alpaca Market Data API",
        feed: "us",
        timeframe: "1Hour",
        symbols: ["BTC/USD"],
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-07-02T00:00:00.000Z",
        datasetHash: `sha256:${"a".repeat(64)}`,
        previousDatasetId: null,
        createdAt: "2026-07-02T00:05:00.000Z",
        stats: {
          requestedBars: 25,
          acceptedBars: 24,
          rejectedBars: 1,
          duplicateBars: 2,
          conflictingDuplicates: 1,
          gapCount: 3,
          addedBars: 1,
          correctedBars: 1,
          removedBars: 0,
          observedStart: "2026-07-01T00:00:00.000Z",
          observedEnd: "2026-07-02T00:00:00.000Z",
        },
      },
    ],
  });

  expect(report.datasets).toEqual([
    expect.objectContaining({
      id: "dataset-1",
      status: "warning",
      freshness: expect.objectContaining({
        observedEnd: "2026-07-02T00:00:00.000Z",
        freshnessAgeHours: 132,
      }),
      completeness: {
        requestedBars: 25,
        acceptedBars: 24,
        acceptedRatio: 0.96,
        gapCount: 3,
      },
      integrity: {
        rejectedBars: 1,
        schemaFailureRate: 0.04,
        duplicateBars: 2,
        duplicateRate: 0.08,
        conflictingDuplicates: 1,
      },
      revisions: {
        addedBars: 1,
        correctedBars: 1,
        removedBars: 0,
        revisionCount: 2,
      },
    }),
  ]);
  expect(report.summary).toMatchObject({ datasetCount: 1, warningDatasets: 1 });
});
