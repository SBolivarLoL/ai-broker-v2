/** Normalizes crypto bars and snapshots into reproducible strategy datasets. */
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

export function cryptoBarsDto(input: { symbols: string[]; timeframe: string; start: Date; end: Date; bars: Record<string, any[]> }) {
  return {
    source: "Alpaca crypto historical bars",
    feed: "us",
    timeframe: input.timeframe,
    start: input.start.toISOString(),
    end: input.end.toISOString(),
    symbols: input.symbols,
    bars: Object.fromEntries(input.symbols.map(symbol => [symbol, (input.bars[symbol] ?? []).map(bar => ({
      symbol,
      timestamp: new Date(bar.timestamp ?? bar.t).toISOString(),
      open: finite(bar.open ?? bar.o),
      high: finite(bar.high ?? bar.h),
      low: finite(bar.low ?? bar.l),
      close: finite(bar.close ?? bar.c),
      volume: finite(bar.volume ?? bar.v),
      vwap: finite(bar.vwap ?? bar.vw),
      tradeCount: finite(bar.tradeCount ?? bar.n),
    })).filter((bar): bar is NormalizedCryptoBar => [bar.open, bar.high, bar.low, bar.close, bar.volume].every(value => value !== null))])),
    asOf: new Date().toISOString(),
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
  return { source: "Alpaca crypto market data", feed: "us", records, asOf: receivedAt.toISOString() };
}
