import { expect, test } from "bun:test";
import {
  assetSearchDto,
  searchAssets,
} from "../../backend/features/markets/search";

const assets = [
  { symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ" },
  { symbol: "NKE", name: "Nike, Inc.", exchange: "NYSE" },
  { symbol: "NEE", name: "NextEra Energy, Inc.", exchange: "NYSE" },
  { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ" },
  { symbol: "MSFT", name: "Microsoft Corporation", exchange: "NASDAQ" },
];

test("ranks ticker prefixes before company-name prefixes", () => {
  expect(searchAssets(assets, "n").map((asset) => asset.symbol)).toEqual([
    "NEE",
    "NKE",
    "NVDA",
  ]);
  expect(searchAssets(assets, "app")[0]?.symbol).toBe("AAPL");
});

test("supports case-insensitive fuzzy subsequence matches and limits results", () => {
  expect(searchAssets(assets, "APLE")[0]?.symbol).toBe("AAPL");
  expect(searchAssets(assets, "mcrsft")[0]?.symbol).toBe("MSFT");
  expect(searchAssets(assets, "n", 2)).toHaveLength(2);
});

test("returns no suggestions for empty or unrelated input", () => {
  expect(searchAssets(assets, "")).toEqual([]);
  expect(searchAssets(assets, "zzzzzz")).toEqual([]);
});

test("asset search keeps unavailable observation separate from retrieval", () => {
  const result = assetSearchDto({
    assets,
    query: "app",
    retrievedAt: new Date("2026-07-11T10:00:00Z"),
    serverRespondedAt: new Date("2026-07-11T10:00:01Z"),
  });

  expect(result).toMatchObject({
    query: "app",
    source: "Alpaca Trading API asset master",
    observedAt: null,
    retrievedAt: "2026-07-11T10:00:00.000Z",
    serverRespondedAt: "2026-07-11T10:00:01.000Z",
    asOf: "2026-07-11T10:00:01.000Z",
    results: [
      {
        symbol: "AAPL",
        observedAt: null,
        retrievedAt: "2026-07-11T10:00:00.000Z",
        serverRespondedAt: "2026-07-11T10:00:01.000Z",
      },
    ],
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: "2026-07-11T10:00:00.000Z",
      serverResponseTime: "2026-07-11T10:00:01.000Z",
    },
  });
});
