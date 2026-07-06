import { expect, test } from "bun:test";
import {
  buildVersionedCryptoDataset,
  cryptoDatasetChunks,
  parseCryptoDatasetRequest,
} from "../../backend/features/strategies/strategy-datasets";
import type { NormalizedCryptoBar } from "../../backend/features/strategies/crypto-strategy-data";

const bar = (timestamp: string, close: number): NormalizedCryptoBar => ({
  symbol: "BTC/USD",
  timestamp,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 10,
  vwap: close,
  tradeCount: 2,
});

test("validates bounded long-history dataset requests and chunks beyond 90 days", () => {
  const query = parseCryptoDatasetRequest(
    {
      symbols: ["BTC/USD"],
      timeframe: "1Day",
      start: "2025-01-01T00:00:00.000Z",
      end: "2025-07-20T00:00:00.000Z",
    },
    new Date("2026-01-01T00:00:00.000Z"),
  );
  const chunks = cryptoDatasetChunks(query.start, query.end);
  expect(chunks).toHaveLength(3);
  expect(chunks[0]).toEqual({
    start: new Date("2025-01-01T00:00:00.000Z"),
    end: new Date("2025-04-01T00:00:00.000Z"),
  });
  expect(chunks.at(-1)?.end).toEqual(query.end);
  expect(() =>
    parseCryptoDatasetRequest(
      {
        symbols: ["BTC/USD", "ETH/USD", "SOL/USD"],
        timeframe: "1Min",
        start: "2025-01-01T00:00:00.000Z",
        end: "2025-06-01T00:00:00.000Z",
      },
      new Date("2026-01-01T00:00:00.000Z"),
    ),
  ).toThrow("bar safety limit");
  expect(() =>
    parseCryptoDatasetRequest(
      {
        symbols: ["BTC/USD"],
        timeframe: "1Hour",
        start: "2026-01-02T00:00:00.000Z",
        end: "2026-01-01T00:00:00.000Z",
      },
      new Date("2026-01-03T00:00:00.000Z"),
    ),
  ).toThrow("Dataset range");
});

test("records gaps duplicates corrections and an immutable normalized hash", () => {
  const request = parseCryptoDatasetRequest(
    {
      symbols: ["BTC/USD"],
      timeframe: "1Hour",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T04:00:00.000Z",
    },
    new Date("2026-01-02T00:00:00.000Z"),
  );
  const previousBars = [
    bar("2026-01-01T00:00:00.000Z", 100),
    bar("2026-01-01T01:00:00.000Z", 101),
    bar("2026-01-01T02:00:00.000Z", 102),
  ];
  const corrected = bar("2026-01-01T01:00:00.000Z", 105);
  const version = buildVersionedCryptoDataset({
    request,
    previous: { id: "dataset-v1", bars: previousBars },
    rawBars: {
      "BTC/USD": [
        bar("2026-01-01T00:00:00.000Z", 100),
        corrected,
        corrected,
        bar("2026-01-01T03:00:00.000Z", 103),
        { t: "invalid", o: 1, h: 1, l: 1, c: 1, v: 1 },
      ],
    },
  });
  const datasetHash = version.datasetHash;
  expect(version).toMatchObject({
    timezone: "UTC",
    previousDatasetId: "dataset-v1",
    datasetHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    stats: {
      requestedBars: 5,
      acceptedBars: 3,
      rejectedBars: 1,
      duplicateBars: 1,
      conflictingDuplicates: 0,
      gapCount: 1,
      addedBars: 1,
      correctedBars: 1,
      removedBars: 1,
    },
  });
  expect(version.bars.map((item) => item.timestamp)).toEqual([
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T03:00:00.000Z",
  ]);
  const repeated = buildVersionedCryptoDataset({
    request,
    rawBars: { "BTC/USD": [...version.bars].reverse() },
  });
  expect(repeated.datasetHash).toBe(datasetHash);
});

test("rejects out-of-range bars and resolves conflicting duplicates deterministically", () => {
  const request = parseCryptoDatasetRequest(
    {
      symbols: ["BTC/USD"],
      timeframe: "1Hour",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T02:00:00.000Z",
    },
    new Date("2026-01-02T00:00:00.000Z"),
  );
  const first = bar("2026-01-01T01:00:00.000Z", 100);
  const conflict = bar("2026-01-01T01:00:00.000Z", 101);
  const outside = bar("2026-01-01T03:00:00.000Z", 102);
  const forward = buildVersionedCryptoDataset({
    request,
    rawBars: { "BTC/USD": [first, conflict, outside] },
  });
  const reverse = buildVersionedCryptoDataset({
    request,
    rawBars: { "BTC/USD": [outside, conflict, first] },
  });
  expect(forward.stats).toMatchObject({
    requestedBars: 3,
    acceptedBars: 1,
    rejectedBars: 1,
    duplicateBars: 1,
    conflictingDuplicates: 1,
  });
  expect(reverse.datasetHash).toBe(forward.datasetHash);
  expect(reverse.bars).toEqual(forward.bars);
});
