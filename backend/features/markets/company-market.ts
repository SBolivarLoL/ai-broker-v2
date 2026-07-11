import {
  providerTimeFields,
  type ProviderTimeFields,
} from "../../shared/time-provenance";

type DateInput = string | number | Date;

type CompanyAsset = {
  symbol: string;
  name?: string;
  exchange?: string;
  status?: string;
  tradable?: boolean;
  fractionable?: boolean;
  shortable?: boolean;
  marginable?: boolean;
};

type MarketSnapshot = {
  latestQuote?: {
    bp?: unknown;
    ap?: unknown;
    bs?: unknown;
    as?: unknown;
    t?: DateInput;
  };
  latestTrade?: { p?: unknown; t?: DateInput };
  dailyBar?: { v?: unknown };
  prevDailyBar?: { c?: unknown };
};

type MarketClock = {
  market?: { acronym?: string };
  phase?: string;
  timestamp?: DateInput;
  nextMarketOpen?: DateInput;
  nextMarketClose?: DateInput;
};

type CompanyBarInput = {
  timestamp: DateInput;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume: unknown;
  vwap?: unknown;
};

type BenchmarkBarInput = Pick<CompanyBarInput, "timestamp" | "close">;

type CompanyNewsInput = {
  id: unknown;
  headline: unknown;
  summary: unknown;
  source: unknown;
  author: unknown;
  createdAt: DateInput;
  updatedAt: DateInput;
  url?: unknown;
};

export type CompanyBar = ProviderTimeFields & {
  timestamp: string;
  observedAt: string;
  source: string;
  feed: "iex";
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
};

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function normalizeCompanyBars(
  bars: CompanyBarInput[],
  retrievedAt: string,
  serverRespondedAt: string,
) {
  // Reject malformed provider rows before any extrema or return calculations;
  // a single NaN would otherwise poison the entire browser snapshot.
  return bars
    .map((bar) => {
      const observedAt = new Date(bar.timestamp).toISOString();
      return {
        timestamp: observedAt,
        ...providerTimeFields({
          observationTime: observedAt,
          publicationTime: null,
          effectivePeriod: {
            start: observedAt,
            end: observedAt,
            label: "IEX historical bar",
          },
          retrievalTime: retrievedAt,
          serverResponseTime: serverRespondedAt,
        }),
        observedAt,
        source: "Alpaca IEX market data",
        feed: "iex" as const,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.volume),
        vwap: Number(bar.vwap),
      };
    })
    .filter(
      (bar): bar is CompanyBar =>
        [bar.open, bar.high, bar.low, bar.close, bar.volume, bar.vwap].every(
          finite,
        ) &&
        bar.open > 0 &&
        bar.high > 0 &&
        bar.low > 0 &&
        bar.close > 0 &&
        bar.volume >= 0,
    )
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function normalizeBenchmarkBars(
  bars: BenchmarkBarInput[],
  retrievedAt: string,
  serverRespondedAt: string,
) {
  return bars
    .map((bar) => {
      const observedAt = new Date(bar.timestamp).toISOString();
      return {
        timestamp: observedAt,
        ...providerTimeFields({
          observationTime: observedAt,
          publicationTime: null,
          effectivePeriod: {
            start: observedAt,
            end: observedAt,
            label: "benchmark historical bar",
          },
          retrievalTime: retrievedAt,
          serverResponseTime: serverRespondedAt,
        }),
        observedAt,
        source: "Alpaca IEX market data",
        feed: "iex" as const,
        close: Number(bar.close),
      };
    })
    .filter((bar) => finite(bar.close) && bar.close > 0)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function returnPercent(bars: { close: number }[]) {
  if (bars.length < 2) return null;
  return (bars.at(-1)!.close / bars[0]!.close - 1) * 100;
}

function barEffectivePeriod(
  bars: { timestamp: string }[],
  label: string,
) {
  return bars.length
    ? {
        start: bars[0]!.timestamp,
        end: bars.at(-1)!.timestamp,
        label,
      }
    : null;
}

/** Builds the browser-facing company view from raw broker data. */
export function companyMarketSnapshot(
  asset: CompanyAsset,
  snapshot: MarketSnapshot,
  bars: CompanyBarInput[],
  news: CompanyNewsInput[],
  clock: { clocks?: MarketClock[] },
  period: string,
  benchmarkSymbol = "SPY",
  benchmarkBars: BenchmarkBarInput[] = [],
  retrievedAtInput: DateInput = new Date(),
  serverRespondedAtInput: DateInput = retrievedAtInput,
) {
  const retrievedAt = new Date(retrievedAtInput).toISOString();
  const responseAt = new Date(serverRespondedAtInput).toISOString();
  const normalizedBars = normalizeCompanyBars(bars, retrievedAt, responseAt);
  const normalizedBenchmark = normalizeBenchmarkBars(
    benchmarkBars,
    retrievedAt,
    responseAt,
  );
  const quote = snapshot.latestQuote ?? {};
  const trade = snapshot.latestTrade ?? {};
  const daily = snapshot.dailyBar ?? {};
  const previous = snapshot.prevDailyBar ?? {};

  const bid = Number(quote.bp);
  const ask = Number(quote.ap);
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const spread = midpoint && ask >= bid ? ask - bid : null;
  const spreadBps =
    spread !== null && midpoint ? (spread / midpoint) * 10_000 : null;

  const exchangeClock =
    clock.clocks?.find((item) => item.market?.acronym === asset.exchange) ??
    clock.clocks?.find((item) => item.market?.acronym === "IEX");
  // Quote age is measured against the exchange clock when available so test
  // fixtures and delayed market clocks remain deterministic.
  const marketPhase = exchangeClock?.phase ?? "unknown";
  const quoteAt = quote.t ? new Date(quote.t).toISOString() : null;
  const tradeAt = trade.t ? new Date(trade.t).toISOString() : null;
  const quoteObservationAt =
    quoteAt ?? tradeAt ?? normalizedBars.at(-1)?.observedAt ?? null;
  const marketObservationAt =
    [quoteAt, tradeAt, normalizedBars.at(-1)?.observedAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  const sessionObservedAt = exchangeClock?.timestamp
    ? new Date(exchangeClock.timestamp).toISOString()
    : null;
  const periodEffective = barEffectivePeriod(
    normalizedBars,
    `${period} company market window`,
  );
  const benchmarkObservedAt = normalizedBenchmark.at(-1)?.observedAt ?? null;
  const benchmarkEffective = barEffectivePeriod(
    normalizedBenchmark,
    `${period} benchmark market window`,
  );
  const clockAt = exchangeClock?.timestamp
    ? new Date(exchangeClock.timestamp).getTime()
    : Date.now();
  const quoteAgeSeconds = quoteAt
    ? Math.max(0, (clockAt - new Date(quoteAt).getTime()) / 1_000)
    : null;

  // Closed sessions are expected to have old quotes; during open sessions,
  // 120 seconds or a 50 bps spread signals data that should not look healthy.
  const quality = !midpoint
    ? "unavailable"
    : marketPhase === "closed"
      ? "market_closed"
      : quoteAgeSeconds !== null && quoteAgeSeconds > 120
        ? "stale"
        : spreadBps !== null && spreadBps > 50
          ? "wide"
          : "healthy";

  const recentVolumes = normalizedBars.slice(-20).map((bar) => bar.volume);
  const averageVolume20d = recentVolumes.length
    ? recentVolumes.reduce((sum, volume) => sum + volume, 0) /
      recentVolumes.length
    : null;
  const currentVolume = finite(daily.v)
    ? daily.v
    : (normalizedBars.at(-1)?.volume ?? null);
  const price =
    finite(trade.p) && trade.p > 0
      ? trade.p
      : (normalizedBars.at(-1)?.close ?? null);
  const previousClose =
    finite(previous.c) && previous.c > 0
      ? previous.c
      : (normalizedBars.at(-2)?.close ?? null);
  const dayChangePercent =
    price && previousClose ? (price / previousClose - 1) * 100 : null;
  const periodReturnPercent = returnPercent(normalizedBars);
  const benchmarkReturnPercent = returnPercent(normalizedBenchmark);

  return {
    company: {
      symbol: asset.symbol,
      name: asset.name ?? asset.symbol,
      exchange: asset.exchange,
      status: asset.status,
      tradable: Boolean(asset.tradable),
      fractionable: Boolean(asset.fractionable),
      shortable: Boolean(asset.shortable),
      marginable: Boolean(asset.marginable),
      source: "Alpaca Trading API asset master",
      ...providerTimeFields({
        observationTime: null,
        publicationTime: null,
        effectivePeriod: null,
        retrievalTime: retrievedAt,
        serverResponseTime: responseAt,
      }),
    },
    period,
    quote: {
      price,
      tradeAt,
      bid: bid > 0 ? bid : null,
      ask: ask > 0 ? ask : null,
      bidSize: finite(quote.bs) ? quote.bs : null,
      askSize: finite(quote.as) ? quote.as : null,
      midpoint,
      spread,
      spreadBps,
      quoteAt,
      source: "Alpaca IEX market data",
      ...providerTimeFields({
        observationTime: quoteObservationAt,
        publicationTime: null,
        effectivePeriod: null,
        retrievalTime: retrievedAt,
        serverResponseTime: responseAt,
      }),
      quoteAgeSeconds,
      quality,
      feed: "iex",
    },
    session: {
      phase: marketPhase,
      nextOpen: exchangeClock?.nextMarketOpen
        ? new Date(exchangeClock.nextMarketOpen).toISOString()
        : null,
      nextClose: exchangeClock?.nextMarketClose
        ? new Date(exchangeClock.nextMarketClose).toISOString()
        : null,
      source: "Alpaca market clock",
      ...providerTimeFields({
        observationTime: sessionObservedAt,
        publicationTime: null,
        effectivePeriod: null,
        retrievalTime: retrievedAt,
        serverResponseTime: responseAt,
      }),
    },
    stats: {
      dayChangePercent,
      periodReturnPercent,
      periodHigh: normalizedBars.length
        ? Math.max(...normalizedBars.map((bar) => bar.high))
        : null,
      periodLow: normalizedBars.length
        ? Math.min(...normalizedBars.map((bar) => bar.low))
        : null,
      currentVolume,
      averageVolume20d,
      relativeVolume:
        currentVolume !== null && averageVolume20d
          ? currentVolume / averageVolume20d
          : null,
      source: "Derived from Alpaca IEX market data",
      ...providerTimeFields({
        observationTime: marketObservationAt,
        publicationTime: null,
        effectivePeriod: periodEffective,
        retrievalTime: retrievedAt,
        serverResponseTime: responseAt,
      }),
    },
    benchmark: {
      symbol: benchmarkSymbol,
      returnPercent: benchmarkReturnPercent,
      relativeStrengthPercent:
        periodReturnPercent !== null && benchmarkReturnPercent !== null
          ? periodReturnPercent - benchmarkReturnPercent
          : null,
      observations: normalizedBenchmark.length,
      quality: normalizedBenchmark.length > 1 ? "complete" : "insufficient",
      bars: normalizedBenchmark,
      source: "Alpaca IEX market data",
      ...providerTimeFields({
        observationTime: benchmarkObservedAt,
        publicationTime: null,
        effectivePeriod: benchmarkEffective,
        retrievalTime: retrievedAt,
        serverResponseTime: responseAt,
      }),
    },
    bars: normalizedBars,
    news: news.slice(0, 8).map((article) => ({
      id: article.id,
      headline: article.headline,
      summary: article.summary,
      source: article.source,
      author: article.author,
      createdAt: new Date(article.createdAt).toISOString(),
      updatedAt: new Date(article.updatedAt).toISOString(),
      ...providerTimeFields({
        observationTime: null,
        publicationTime: new Date(article.createdAt).toISOString(),
        effectivePeriod: null,
        retrievalTime: retrievedAt,
        serverResponseTime: responseAt,
      }),
      url: article.url ?? null,
    })),
    source: "Alpaca Trading API and IEX market data",
    ...providerTimeFields({
      observationTime: marketObservationAt,
      publicationTime: null,
      effectivePeriod: periodEffective,
      retrievalTime: retrievedAt,
      serverResponseTime: responseAt,
    }),
  };
}
