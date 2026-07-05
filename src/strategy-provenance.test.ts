import { expect, test } from "bun:test";
import { canonicalHash, parseStrategyProvenance, resolveCodeIdentity, STRATEGY_FEATURE_SCHEMA_VERSION } from "./strategy-provenance";

const commit = "a".repeat(40);

test("builds deterministic strategy provenance from canonical content", () => {
  expect(canonicalHash({ symbols: ["BTC/USD"], params: { slow: 20, fast: 5 } }))
    .toBe(canonicalHash({ params: { fast: 5, slow: 20 }, symbols: ["BTC/USD"] }));

  expect(parseStrategyProvenance({
    gitCommit: commit,
    workingTreeDirty: false,
    pluginVersion: "strategy-plugin-v1",
    featureSchemaVersion: STRATEGY_FEATURE_SCHEMA_VERSION,
    policyVersion: "crypto-backtest-v1",
    definitionHash: canonicalHash({ strategyId: "moving-average-trend" }),
    provider: "Alpaca Market Data API",
    feed: "us",
    query: { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z", timeframe: "1Hour", symbols: ["BTC/USD"] },
    datasetHash: canonicalHash([{ timestamp: "2026-01-01T00:00:00Z", close: 100 }]),
  })).toMatchObject({
    gitCommit: commit,
    query: { start: "2026-01-01T00:00:00.000Z", symbols: ["BTC/USD"] },
  });
});

test("rejects unverifiable provenance and accepts configured build identity", () => {
  expect(resolveCodeIdentity({ APP_GIT_COMMIT: commit, APP_GIT_DIRTY: "1" })).toEqual({ gitCommit: commit, workingTreeDirty: true });
  expect(() => resolveCodeIdentity({ APP_GIT_COMMIT: "short" })).toThrow("full 40-character Git commit");
  expect(() => parseStrategyProvenance({
    gitCommit: commit,
    workingTreeDirty: false,
    pluginVersion: "strategy-plugin-v1",
    featureSchemaVersion: STRATEGY_FEATURE_SCHEMA_VERSION,
    policyVersion: "crypto-backtest-v1",
    definitionHash: "not-a-hash",
    provider: "Alpaca",
    feed: "us",
    query: { start: "2026-02-01T00:00:00Z", end: "2026-01-01T00:00:00Z", timeframe: "1Hour", symbols: ["BTC/USD"] },
    datasetHash: canonicalHash([]),
  })).toThrow("SHA-256");
});
