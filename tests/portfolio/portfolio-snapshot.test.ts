import { expect, test } from "bun:test";
import { buildPortfolioSnapshot } from "../../backend/features/portfolio/portfolio-snapshot";
import { riskSnapshot } from "../../backend/shared/risk";
import { createStore } from "../../backend/persistence/store";

const positions = [
  {
    symbol: "AAPL",
    qty: "5",
    marketValue: "1000",
    currentPrice: "200",
    avgEntryPrice: "180",
  },
];

test("portfolio snapshot reconciles broker equity and reports healthy data", () => {
  const risk = riskSnapshot(10_000, 9_000, positions);
  const snapshot = buildPortfolioSnapshot(
    { equity: "10000", cash: "9000", buyingPower: "9000", status: "ACTIVE" },
    positions,
    risk,
    { streamState: "authenticated", stale: false },
    new Date("2026-06-21T12:00:00Z"),
  );
  expect(snapshot).toMatchObject({
    snapshotDate: "2026-06-21",
    positionValue: 1000,
    reconciliationGap: 0,
    quality: { status: "healthy", flags: [] },
  });
});

test("portfolio snapshot exposes reconciliation and stream-quality warnings", () => {
  const risk = riskSnapshot(10_000, 8_500, positions);
  const snapshot = buildPortfolioSnapshot(
    { equity: 10_000, cash: 8_500, buyingPower: 8_500, status: "ACTIVE" },
    positions,
    risk,
    { streamState: "disconnected", stale: true, lastError: "socket closed" },
  );
  expect(snapshot.quality.status).toBe("warning");
  expect(snapshot.quality.flags.map((flag) => flag.code)).toEqual([
    "equity_reconciliation_gap",
    "order_state_stale",
    "order_stream_error",
  ]);
});

test("daily portfolio snapshots upsert and retain history", () => {
  const store = createStore(":memory:");
  const risk = riskSnapshot(10_000, 9_000, positions);
  const first = buildPortfolioSnapshot(
    { equity: 10_000, cash: 9_000, buyingPower: 9_000, status: "ACTIVE" },
    positions,
    risk,
    {},
    new Date("2026-06-20T12:00:00Z"),
  );
  const latest = buildPortfolioSnapshot(
    { equity: 10_100, cash: 9_100, buyingPower: 9_100, status: "ACTIVE" },
    positions,
    risk,
    {},
    new Date("2026-06-21T12:00:00Z"),
  );
  store.portfolioSnapshot(first);
  store.portfolioSnapshot(latest);
  store.portfolioSnapshot({
    ...latest,
    equity: 10_200,
    capturedAt: "2026-06-21T13:00:00.000Z",
  });
  expect(store.portfolioSnapshots()).toMatchObject([
    { snapshotDate: "2026-06-21", equity: 10_200 },
    { snapshotDate: "2026-06-20", equity: 10_000 },
  ]);
  store.close();
});
