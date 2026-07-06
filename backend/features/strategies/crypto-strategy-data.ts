/** Normalizes crypto bars and snapshots into reproducible strategy datasets. */
import { normalizeTimeProvenance } from "../../shared/time-provenance";

const CRYPTO_SYMBOLS = new Set(["BTC/USD", "ETH/USD", "SOL/USD"]);
const TIMEFRAMES = new Set(["1Min", "5Min", "15Min", "1Hour", "4Hour", "1Day"]);
export const CRYPTO_LOOKBACK_DAYS = { minimum: 1, maximum: 90, defaultValue: 7 } as const;

const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export type NormalizedCryptoBar = {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
  tradeCount: number | null;
};

export function normalizeCryptoBar(
  symbol: string,
  raw: Record<string, unknown>,
): NormalizedCryptoBar | null {
  const timestamp = new Date(String(raw.timestamp ?? raw.t ?? ""));
  const open = finite(raw.open ?? raw.o);
  const high = finite(raw.high ?? raw.h);
  const low = finite(raw.low ?? raw.l);
  const close = finite(raw.close ?? raw.c);
  const volume = finite(raw.volume ?? raw.v);
  const vwap = finite(raw.vwap ?? raw.vw);
  const tradeCount = finite(raw.tradeCount ?? raw.n);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    volume < 0 ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    (vwap !== null && vwap <= 0) ||
    (tradeCount !== null && (tradeCount < 0 || !Number.isInteger(tradeCount)))
  )
    return null;
  return {
    symbol,
    timestamp: timestamp.toISOString(),
    open,
    high,
    low,
    close,
    volume,
    vwap,
    tradeCount,
  };
}

export function parseCryptoSymbols(value: unknown, maximum = 3) {
  const raw = String(value ?? "BTC/USD,ETH/USD,SOL/USD").split(",").map(symbol => symbol.trim().toUpperCase()).filter(Boolean);
  const symbols = [...new Set(raw)];
  if (!symbols.length || symbols.length > maximum || symbols.some(symbol => !CRYPTO_SYMBOLS.has(symbol))) throw new Error(`Crypto symbols must be ${[...CRYPTO_SYMBOLS].join(", ")}`);
  return symbols;
}

export function parseCryptoTimeframe(value: unknown) {
  const timeframe = String(value ?? "1Hour");
  if (!TIMEFRAMES.has(timeframe)) throw new Error(`Timeframe must be one of ${[...TIMEFRAMES].join(", ")}`);
  return timeframe;
}

export function parseCryptoLookbackDays(value: unknown) {
  const days = Number(value ?? CRYPTO_LOOKBACK_DAYS.defaultValue);
  if (!Number.isInteger(days) || days < CRYPTO_LOOKBACK_DAYS.minimum || days > CRYPTO_LOOKBACK_DAYS.maximum) throw new Error(`Lookback days must be ${CRYPTO_LOOKBACK_DAYS.minimum} to ${CRYPTO_LOOKBACK_DAYS.maximum}`);
  return days;
}

export function cryptoBarsDto(input: { symbols: string[]; timeframe: string; start: Date; end: Date; bars: Record<string, any[]>; retrievedAt?: Date; serverRespondedAt?: Date }) {
  const retrievedAt = input.retrievedAt ?? new Date();
  const serverRespondedAt = input.serverRespondedAt ?? retrievedAt;
  const bars = Object.fromEntries(input.symbols.map(symbol => [symbol, (input.bars[symbol] ?? [])
    .map(bar => normalizeCryptoBar(symbol, bar))
    .filter((bar): bar is NormalizedCryptoBar => bar !== null)
    .map(bar => ({
      ...bar,
      observedAt: bar.timestamp,
      time: normalizeTimeProvenance({
        observationTime: bar.timestamp,
        effectivePeriod: {
          start: bar.timestamp,
          end: bar.timestamp,
          label: `${input.timeframe} bar close`,
        },
        retrievalTime: retrievedAt,
        serverResponseTime: serverRespondedAt,
      }),
    }))]));
  const observationTimes = Object.values(bars)
    .flat()
    .map(bar => new Date(bar.timestamp).getTime())
    .filter(Number.isFinite);
  const observedStart = observationTimes.length ? new Date(Math.min(...observationTimes)).toISOString() : null;
  const observedEnd = observationTimes.length ? new Date(Math.max(...observationTimes)).toISOString() : null;
  return {
    source: "Alpaca crypto historical bars",
    feed: "us",
    timeframe: input.timeframe,
    start: input.start.toISOString(),
    end: input.end.toISOString(),
    symbols: input.symbols,
    bars,
    observedStart,
    observedEnd,
    retrievedAt: retrievedAt.toISOString(),
    serverRespondedAt: serverRespondedAt.toISOString(),
    time: normalizeTimeProvenance({
      observationTime: observedEnd,
      effectivePeriod: {
        start: observedStart ?? input.start,
        end: observedEnd ?? input.end,
        label: `${input.timeframe} requested bar window`,
      },
      retrievalTime: retrievedAt,
      serverResponseTime: serverRespondedAt,
    }),
    asOf: retrievedAt.toISOString(),
  };
}

export function cryptoSnapshotDto(input: { symbols: string[]; snapshots: Record<string, any>; orderbooks?: Record<string, any>; observedAt?: Date; receivedAt?: Date }) {
  const observedAt = input.observedAt ?? new Date();
  const receivedAt = input.receivedAt ?? new Date();
  const latencyMs = Math.max(0, receivedAt.getTime() - observedAt.getTime());
  const records = input.symbols.map(symbol => {
    const snapshot = input.snapshots[symbol] ?? {};
    const quote = snapshot.latestQuote ?? {};
    const trade = snapshot.latestTrade ?? {};
    const latestBar = snapshot.latestBar ?? snapshot.minuteBar ?? {};
    const orderbook = input.orderbooks?.[symbol] ?? snapshot.latestOrderbook ?? null;
    const quoteTime = quote.t ? new Date(quote.t) : null;
    const tradeTime = trade.t ? new Date(trade.t) : null;
    const barTime = latestBar.t ? new Date(latestBar.t) : null;
    const dataTimes = [quoteTime, tradeTime, barTime].filter(date => date && Number.isFinite(date.getTime())) as Date[];
    const newestDataAt = dataTimes.length ? new Date(Math.max(...dataTimes.map(date => date.getTime()))) : observedAt;
    const ageMs = receivedAt.getTime() - newestDataAt.getTime();
    return {
      id: crypto.randomUUID(),
      symbol,
      source: "Alpaca crypto snapshot",
      feed: "us",
      observedAt: newestDataAt.toISOString(),
      retrievedAt: receivedAt.toISOString(),
      serverRespondedAt: receivedAt.toISOString(),
      time: normalizeTimeProvenance({
        observationTime: newestDataAt,
        retrievalTime: receivedAt,
        serverResponseTime: receivedAt,
      }),
      stale: !Number.isFinite(ageMs) || ageMs > 60_000,
      latencyMs,
      payload: {
        quote: {
          bid: finite(quote.bp),
          bidSize: finite(quote.bs),
          ask: finite(quote.ap),
          askSize: finite(quote.as),
          timestamp: quote.t ? new Date(quote.t).toISOString() : null,
        },
        trade: {
          price: finite(trade.p),
          size: finite(trade.s),
          timestamp: trade.t ? new Date(trade.t).toISOString() : null,
          takerSide: trade.tks ?? null,
        },
        bar: {
          open: finite(latestBar.o),
          high: finite(latestBar.h),
          low: finite(latestBar.l),
          close: finite(latestBar.c),
          volume: finite(latestBar.v),
          timestamp: latestBar.t ? new Date(latestBar.t).toISOString() : null,
        },
        orderbook,
      },
    };
  });
  return {
    source: "Alpaca crypto market data",
    feed: "us",
    records,
    retrievedAt: receivedAt.toISOString(),
    serverRespondedAt: receivedAt.toISOString(),
    time: normalizeTimeProvenance({
      observationTime: records
        .map(record => new Date(record.observedAt).getTime())
        .filter(Number.isFinite)
        .sort((left, right) => right - left)[0] ?? null,
      retrievalTime: receivedAt,
      serverResponseTime: receivedAt,
    }),
    asOf: receivedAt.toISOString(),
  };
}
