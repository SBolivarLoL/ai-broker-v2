import type { createStore } from "../../persistence/store";
import { parseCryptoSymbols } from "./crypto-strategy-data";
import {
  canonicalHash,
  STRATEGY_FEATURE_SCHEMA_VERSION,
  type CodeIdentity,
  type StrategyProvenance,
} from "./strategy-provenance";

type Store = ReturnType<typeof createStore>;
type StrategyRunRecord = NonNullable<ReturnType<Store["getStrategyRun"]>>;

export function normalizeStrategySymbols(
  strategyId: string,
  rawSymbols: unknown,
) {
  const maximum = strategyId === "btc-eth-relative-strength" ? 2 : 1;
  const symbols = parseCryptoSymbols(rawSymbols, maximum);
  if (strategyId !== "btc-eth-relative-strength") return symbols;
  const primary = symbols[0]!;
  if (!["BTC/USD", "ETH/USD"].includes(primary))
    throw new Error(
      "BTC/ETH relative strength must start with BTC/USD or ETH/USD",
    );
  const peer = primary === "BTC/USD" ? "ETH/USD" : "BTC/USD";
  return [...new Set([primary, peer])];
}

export async function strategyConfigHash(config: unknown) {
  return canonicalHash(config);
}

export function strategyDefinition(
  symbols: string[],
  strategyId: string,
  params: Record<string, unknown>,
  timeframe: string,
  days: number,
) {
  return { symbols, strategyId, params, timeframe, days };
}

export function withoutAsOf<T extends { asOf: string }>(
  value: T,
): Omit<T, "asOf"> {
  // Retrieval time is operational metadata, not dataset content. Excluding it
  // lets identical market observations produce the same provenance hash.
  const { asOf: _, ...content } = value;
  return content;
}

export function strategyProvenance(
  codeIdentity: CodeIdentity,
  input: {
    pluginVersion: string;
    policyVersion: string;
    definitionHash: string;
    start: Date;
    end: Date;
    timeframe: string;
    symbols: string[];
    datasetHash: string;
  },
): StrategyProvenance {
  return {
    ...codeIdentity,
    pluginVersion: input.pluginVersion,
    featureSchemaVersion: STRATEGY_FEATURE_SCHEMA_VERSION,
    policyVersion: input.policyVersion,
    definitionHash: input.definitionHash,
    provider: "Alpaca Market Data API",
    feed: "us",
    query: {
      start: input.start.toISOString(),
      end: input.end.toISOString(),
      timeframe: input.timeframe,
      symbols: input.symbols,
    },
    datasetHash: input.datasetHash,
  };
}

export function strategyAuditSnapshot(
  run: StrategyRunRecord | null | undefined,
) {
  return run
    ? {
        id: run.id,
        strategyId: run.strategyId,
        strategyVersion: run.strategyVersion,
        status: run.status,
        configHash: run.configHash,
        policyVersion: run.policyVersion,
        symbols: run.symbols,
        budget: run.budget,
        config: run.config,
        notes: run.notes ?? null,
        updatedAt: run.updatedAt,
      }
    : null;
}
