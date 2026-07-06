/** Validation and browser DTOs for live equity quote/bar stream messages. */
const symbolPattern = /^[A-Z.]{1,10}$/;

export function parseStreamSymbols(value: string, maximum = 20) {
  const symbols = [
    ...new Set(
      value
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (
    !symbols.length ||
    symbols.length > maximum ||
    symbols.some((symbol) => !symbolPattern.test(symbol))
  )
    throw new Error(`Provide 1 to ${maximum} valid stock symbols`);
  return symbols;
}

const timestamp = (value: unknown) => {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime()))
    throw new Error("Stream update has an invalid timestamp");
  return date.toISOString();
};

export function streamQuoteDto(quote: any) {
  const bid = Number(quote.bidPrice),
    ask = Number(quote.askPrice);
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  return {
    kind: "quote" as const,
    symbol: String(quote.symbol),
    bid: bid > 0 ? bid : null,
    ask: ask > 0 ? ask : null,
    bidSize: Number(quote.bidSize) || 0,
    askSize: Number(quote.askSize) || 0,
    midpoint,
    spreadBps:
      midpoint && ask >= bid ? ((ask - bid) / midpoint) * 10_000 : null,
    timestamp: timestamp(quote.timestamp),
    feed: "iex",
  };
}

export function streamBarDto(bar: any) {
  const values = [bar.open, bar.high, bar.low, bar.close, bar.volume].map(
    Number,
  );
  if (
    values.some((value) => !Number.isFinite(value)) ||
    values.slice(0, 4).some((value) => value <= 0) ||
    values[4] < 0
  )
    throw new Error("Stream bar contains invalid market data");
  return {
    kind: "bar" as const,
    symbol: String(bar.symbol),
    open: values[0],
    high: values[1],
    low: values[2],
    close: values[3],
    volume: values[4],
    vwap: Number.isFinite(Number(bar.vwap)) ? Number(bar.vwap) : null,
    tradeCount: Number.isFinite(Number(bar.tradeCount))
      ? Number(bar.tradeCount)
      : null,
    timestamp: timestamp(bar.timestamp),
    feed: "iex",
  };
}
