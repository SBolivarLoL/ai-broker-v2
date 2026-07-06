import { canonicalHash } from "./strategy-provenance";
import {
  normalizeCryptoBar,
  parseCryptoSymbols,
  parseCryptoTimeframe,
  type NormalizedCryptoBar,
} from "./crypto-strategy-data";

export const CRYPTO_DATASET_SCHEMA_VERSION = "crypto-bars-v1";
export const CRYPTO_DATASET_MAX_RANGE_DAYS = 3_650;
export const CRYPTO_DATASET_MAX_BARS = 500_000;
export const CRYPTO_DATASET_CHUNK_DAYS = 90;

const timeframeMilliseconds: Record<string, number> = {
  "1Min": 60_000,
  "5Min": 5 * 60_000,
  "15Min": 15 * 60_000,
  "1Hour": 60 * 60_000,
  "4Hour": 4 * 60 * 60_000,
  "1Day": 24 * 60 * 60_000,
};

export type CryptoDatasetRequest = {
  symbols: string[];
  timeframe: string;
  start: Date;
  end: Date;
};

export type CryptoDatasetStats = {
  requestedBars: number;
  acceptedBars: number;
  rejectedBars: number;
  duplicateBars: number;
  conflictingDuplicates: number;
  gapCount: number;
  addedBars: number;
  correctedBars: number;
  removedBars: number;
  observedStart: string | null;
  observedEnd: string | null;
  perSymbol: Record<
    string,
    {
      bars: number;
      gaps: number;
      observedStart: string | null;
      observedEnd: string | null;
    }
  >;
};

export type VersionedCryptoDataset = {
  schemaVersion: typeof CRYPTO_DATASET_SCHEMA_VERSION;
  provider: "Alpaca Market Data API";
  source: "Alpaca crypto historical bars";
  feed: "us";
  timezone: "UTC";
  symbols: string[];
  timeframe: string;
  start: string;
  end: string;
  datasetHash: string;
  previousDatasetId: string | null;
  stats: CryptoDatasetStats;
  bars: NormalizedCryptoBar[];
};

export function parseCryptoDatasetRequest(
  input: Record<string, unknown>,
  now = new Date(),
): CryptoDatasetRequest {
  const symbols = parseCryptoSymbols(input.symbols);
  const timeframe = parseCryptoTimeframe(input.timeframe);
  const start = new Date(String(input.start ?? ""));
  const end = new Date(String(input.end ?? ""));
  const intervalMs = timeframeMilliseconds[timeframe]!;
  const rangeMs = end.getTime() - start.getTime();
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    rangeMs < intervalMs ||
    rangeMs > CRYPTO_DATASET_MAX_RANGE_DAYS * 86_400_000 ||
    end.getTime() > now.getTime() + 5 * 60_000
  )
    throw new Error(
      `Dataset range must be at least one bar, no more than ${CRYPTO_DATASET_MAX_RANGE_DAYS} days, and not in the future`,
    );
  const estimatedBars = Math.ceil(rangeMs / intervalMs) * symbols.length;
  if (estimatedBars > CRYPTO_DATASET_MAX_BARS)
    throw new Error(
      `Dataset request exceeds the ${CRYPTO_DATASET_MAX_BARS} bar safety limit`,
    );
  return { symbols, timeframe, start, end };
}

export function cryptoDatasetChunks(
  start: Date,
  end: Date,
  chunkDays = CRYPTO_DATASET_CHUNK_DAYS,
) {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end ||
    !Number.isFinite(chunkDays) ||
    chunkDays <= 0
  )
    throw new Error("Invalid crypto dataset chunk range");
  const chunks: { start: Date; end: Date }[] = [];
  const chunkMs = chunkDays * 86_400_000;
  for (let cursor = start.getTime(); cursor < end.getTime(); ) {
    const chunkEnd = Math.min(cursor + chunkMs, end.getTime());
    chunks.push({ start: new Date(cursor), end: new Date(chunkEnd) });
    cursor = chunkEnd;
  }
  return chunks;
}

function barContent(bar: NormalizedCryptoBar) {
  return {
    symbol: bar.symbol,
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    vwap: bar.vwap,
    tradeCount: bar.tradeCount,
  };
}

export function cryptoDatasetHash(input: {
  symbols: string[];
  timeframe: string;
  start: string;
  end: string;
  bars: NormalizedCryptoBar[];
}) {
  return canonicalHash({
    schemaVersion: CRYPTO_DATASET_SCHEMA_VERSION as typeof CRYPTO_DATASET_SCHEMA_VERSION,
    provider: "Alpaca Market Data API",
    source: "Alpaca crypto historical bars",
    feed: "us",
    timezone: "UTC",
    symbols: input.symbols,
    timeframe: input.timeframe,
    start: input.start,
    end: input.end,
    bars: input.bars.map(barContent),
  });
}

export function buildVersionedCryptoDataset(input: {
  request: CryptoDatasetRequest;
  rawBars: Record<string, unknown[]>;
  previous?: { id: string; bars: NormalizedCryptoBar[] } | null;
}): VersionedCryptoDataset {
  const { symbols, timeframe, start, end } = input.request;
  const intervalMs = timeframeMilliseconds[timeframe];
  if (!intervalMs) throw new Error("Unsupported crypto dataset timeframe");
  let requestedBars = 0,
    rejectedBars = 0,
    duplicateBars = 0,
    conflictingDuplicates = 0;
  const unique = new Map<string, NormalizedCryptoBar>();
  for (const symbol of symbols) {
    const raw = input.rawBars[symbol] ?? [];
    requestedBars += raw.length;
    for (const item of raw) {
      const bar = normalizeCryptoBar(symbol, item as Record<string, unknown>);
      if (
        !bar ||
        new Date(bar.timestamp).getTime() < start.getTime() ||
        new Date(bar.timestamp).getTime() > end.getTime()
      ) {
        rejectedBars += 1;
        continue;
      }
      const key = `${symbol}:${bar.timestamp}`;
      const existing = unique.get(key);
      const barHash = canonicalHash(barContent(bar));
      if (existing) {
        duplicateBars += 1;
        const existingHash = canonicalHash(barContent(existing));
        if (existingHash !== barHash) {
          conflictingDuplicates += 1;
          if (barHash > existingHash) unique.set(key, bar);
        }
      } else {
        unique.set(key, bar);
      }
    }
  }
  const bars = [...unique.values()].sort(
    (left, right) =>
      left.symbol.localeCompare(right.symbol) ||
      left.timestamp.localeCompare(right.timestamp),
  );
  if (!bars.length) throw new Error("Dataset contains no valid crypto bars");
  if (bars.length > CRYPTO_DATASET_MAX_BARS)
    throw new Error(`Dataset exceeds the ${CRYPTO_DATASET_MAX_BARS} bar safety limit`);

  let gapCount = 0;
  const perSymbol: CryptoDatasetStats["perSymbol"] = {};
  for (const symbol of symbols) {
    const symbolBars = bars.filter((bar) => bar.symbol === symbol);
    let gaps = 0;
    for (let index = 1; index < symbolBars.length; index += 1) {
      const previous = new Date(symbolBars[index - 1]!.timestamp).getTime();
      const current = new Date(symbolBars[index]!.timestamp).getTime();
      if (current - previous > intervalMs)
        gaps += Math.max(0, Math.floor((current - previous) / intervalMs) - 1);
    }
    gapCount += gaps;
    perSymbol[symbol] = {
      bars: symbolBars.length,
      gaps,
      observedStart: symbolBars[0]?.timestamp ?? null,
      observedEnd: symbolBars.at(-1)?.timestamp ?? null,
    };
  }

  const previousBars = new Map(
    (input.previous?.bars ?? []).map((bar) => [
      `${bar.symbol}:${bar.timestamp}`,
      canonicalHash(barContent(bar)),
    ]),
  );
  const currentBars = new Map(
    bars.map((bar) => [
      `${bar.symbol}:${bar.timestamp}`,
      canonicalHash(barContent(bar)),
    ]),
  );
  let addedBars = 0,
    correctedBars = 0,
    removedBars = 0;
  for (const [key, hash] of currentBars) {
    const previousHash = previousBars.get(key);
    if (!previousHash) addedBars += 1;
    else if (previousHash !== hash) correctedBars += 1;
  }
  for (const key of previousBars.keys()) if (!currentBars.has(key)) removedBars += 1;

  const content = {
    schemaVersion: CRYPTO_DATASET_SCHEMA_VERSION as typeof CRYPTO_DATASET_SCHEMA_VERSION,
    provider: "Alpaca Market Data API" as const,
    source: "Alpaca crypto historical bars" as const,
    feed: "us" as const,
    timezone: "UTC" as const,
    symbols,
    timeframe,
    start: start.toISOString(),
    end: end.toISOString(),
    bars: bars.map(barContent),
  };
  const observed = bars.map((bar) => bar.timestamp).sort();
  return {
    ...content,
    datasetHash: cryptoDatasetHash(content),
    previousDatasetId: input.previous?.id ?? null,
    stats: {
      requestedBars,
      acceptedBars: bars.length,
      rejectedBars,
      duplicateBars,
      conflictingDuplicates,
      gapCount,
      addedBars,
      correctedBars,
      removedBars,
      observedStart: observed[0] ?? null,
      observedEnd: observed.at(-1) ?? null,
      perSymbol,
    },
    bars,
  };
}
