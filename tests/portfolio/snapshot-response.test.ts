import { describe, expect, test } from "bun:test";
import {
  portfolioSnapshotDto,
  portfolioSnapshotsDto,
} from "../../backend/features/portfolio/snapshot-response";
import { buildPortfolioSnapshot } from "../../backend/features/portfolio/portfolio-snapshot";
import { riskSnapshot } from "../../backend/shared/risk";

const positions = [
  {
    symbol: "AAPL",
    qty: "5",
    marketValue: "1000",
    currentPrice: "200",
    avgEntryPrice: "180",
  },
];

function modernSnapshot(capturedAt = "2026-06-21T12:00:00Z") {
  return buildPortfolioSnapshot(
    {
      equity: "10000",
      cash: "9000",
      buyingPower: "9000",
      status: "ACTIVE",
    },
    positions,
    riskSnapshot(10_000, 9_000, positions),
    {
      streamState: "authenticated",
      lastEventAt: "2026-06-21T11:59:30Z",
      lastRecoveryAt: "2026-06-21T11:59:00Z",
      stale: false,
    },
    new Date(capturedAt),
  );
}

describe("portfolio snapshot response", () => {
  test("separates broker-state capture, order observation, and response time", () => {
    const response = portfolioSnapshotDto(
      modernSnapshot(),
      "2026-06-21T12:00:01Z",
    );

    expect(response).toMatchObject({
      schemaVersion: "portfolio-snapshot-v2",
      snapshotDate: "2026-06-21",
      capturedAt: "2026-06-21T12:00:00.000Z",
      observedAt: null,
      publishedAt: null,
      retrievedAt: "2026-06-21T12:00:00.000Z",
      serverRespondedAt: "2026-06-21T12:00:01.000Z",
      asOf: "2026-06-21T12:00:01.000Z",
      effectivePeriod: {
        start: "2026-06-21T00:00:00.000Z",
        end: "2026-06-21T23:59:59.999Z",
      },
      provenanceStatus: "available",
      positions: [
        {
          symbol: "AAPL",
          observedAt: null,
          retrievedAt: "2026-06-21T12:00:00.000Z",
        },
      ],
      risk: {
        observedAt: null,
        retrievedAt: "2026-06-21T12:00:00.000Z",
        weights: [
          {
            symbol: "AAPL",
            observedAt: null,
            retrievedAt: "2026-06-21T12:00:00.000Z",
          },
        ],
      },
      orderSync: {
        observedAt: "2026-06-21T11:59:30.000Z",
        retrievedAt: "2026-06-21T12:00:00.000Z",
        stream: {
          observedAt: "2026-06-21T11:59:30.000Z",
          retrievedAt: null,
          time: { retrievalTime: null },
        },
        recovery: {
          observedAt: null,
          retrievedAt: "2026-06-21T11:59:00.000Z",
        },
      },
      quality: {
        status: "healthy",
        coverageStatus: "complete",
        provenanceStatus: "available",
        missing: [],
      },
      inputs: {
        account: {
          available: true,
          observedAt: null,
          retrievedAt: "2026-06-21T12:00:00.000Z",
        },
        positions: { count: 1 },
        orderSync: {
          available: true,
          observedAt: "2026-06-21T11:59:30.000Z",
        },
      },
    });
  });

  test("keeps legacy persisted provenance explicitly unavailable", () => {
    const response = portfolioSnapshotDto(
      { snapshotDate: "2026-01-02", equity: 10_000 },
      "2026-06-21T12:00:01Z",
    );

    expect(response).toMatchObject({
      schemaVersion: "portfolio-snapshot-v2",
      snapshotDate: "2026-01-02",
      capturedAt: null,
      retrievedAt: null,
      serverRespondedAt: "2026-06-21T12:00:01.000Z",
      provenanceStatus: "unavailable",
      positions: [],
      quality: {
        status: "unknown",
        coverageStatus: "partial",
        provenanceStatus: "unavailable",
        missing: ["capture_time", "quality", "positions", "order_sync"],
        flags: [
          {
            code: "legacy_snapshot_provenance",
            severity: "warning",
          },
        ],
      },
      inputs: {
        account: { available: false, retrievedAt: null },
        orderSync: { available: false, retrievedAt: null },
      },
      time: { retrievalTime: null },
    });
  });

  test("rejects malformed persisted order timestamps without losing the snapshot", () => {
    const snapshot = modernSnapshot();
    const response = portfolioSnapshotDto(
      {
        ...snapshot,
        orderSync: {
          ...snapshot.orderSync,
          lastEventAt: "not-a-date",
          lastRecoveryAt: "also-not-a-date",
        },
      },
      "2026-06-21T12:00:01Z",
    );

    expect(response).toMatchObject({
      retrievedAt: "2026-06-21T12:00:00.000Z",
      orderSync: {
        observedAt: null,
        stream: { available: false, retrievedAt: null },
        recovery: { available: false, retrievedAt: null },
      },
      quality: {
        coverageStatus: "partial",
        missing: [
          "order_event_observation_time",
          "order_recovery_retrieval_time",
        ],
      },
    });
  });

  test("normalizes current and historical rows with one fresh response time", () => {
    const response = portfolioSnapshotsDto({
      current: modernSnapshot(),
      history: [
        modernSnapshot("2026-06-20T12:00:00Z"),
        { snapshotDate: "2026-01-02", equity: 9_000 },
      ],
      serverRespondedAt: "2026-06-21T12:00:02Z",
    });

    expect(response).toMatchObject({
      schemaVersion: "portfolio-snapshots-v2",
      observedAt: null,
      retrievedAt: "2026-06-21T12:00:00.000Z",
      serverRespondedAt: "2026-06-21T12:00:02.000Z",
      effectivePeriod: {
        start: "2026-01-02T00:00:00.000Z",
        end: "2026-06-21T23:59:59.999Z",
      },
      current: {
        retrievedAt: "2026-06-21T12:00:00.000Z",
        serverRespondedAt: "2026-06-21T12:00:02.000Z",
      },
      history: [
        {
          retrievedAt: "2026-06-20T12:00:00.000Z",
          serverRespondedAt: "2026-06-21T12:00:02.000Z",
        },
        { retrievedAt: null },
      ],
      quality: {
        status: "partial",
        expected: { current: 1, history: 2 },
        received: { current: 1, history: 1 },
        missing: [
          "history:2026-01-02:capture_time",
          "history:2026-01-02:quality",
          "history:2026-01-02:positions",
          "history:2026-01-02:order_sync",
        ],
      },
    });
  });
});
