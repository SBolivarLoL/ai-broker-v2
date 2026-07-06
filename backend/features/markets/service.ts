import { TimeFrame, type Alpaca } from "@alpacahq/alpaca-ts-alpha";
import {
  ClientError,
  json,
  requestJson,
  securityHeaders,
} from "../../http/http";
import type { createStore } from "../../persistence/store";
import { getSec8KAlerts } from "../research/research";
import { companyMarketSnapshot } from "./company-market";
import {
  monitoringCorporateActions,
  monitoringEventClusters,
  monitoringNews,
  monitoringSecFilings,
  type MonitoringWatchlist,
} from "./market-monitoring";
import { parseStreamSymbols } from "./market-stream";
import {
  calendarDto,
  discoveryDto,
  parseSymbol,
  parseWatchlistInput,
  watchlistDto,
} from "./market-workspace";
import { multiAssetDto } from "./multi-asset";
import { searchAssets, type SearchableAsset } from "./search";
import { createStockStreamService } from "./stock-stream";

type Store = ReturnType<typeof createStore>;
type RateLimit = (key: string, maximum: number) => boolean;
type MarketMonitoringResponse = {
  news: ReturnType<typeof monitoringNews>;
  corporateActions: ReturnType<typeof monitoringCorporateActions>;
  secFilings: ReturnType<typeof monitoringSecFilings>;
  clusters: ReturnType<typeof monitoringEventClusters>;
  warnings: string[];
  coverage: {
    symbols: string[];
    omittedSymbols: number;
    secSymbols: string[];
    secOmittedSymbols: number;
  };
  asOf: string;
};

type MarketServiceDependencies = {
  alpaca: Alpaca;
  store: Store;
  allow: RateLimit;
};

/** Owns market caches and HTTP translation, delegating the stock-stream lifecycle. */
export function createMarketService({
  alpaca,
  store,
  allow,
}: MarketServiceDependencies) {
  let assetCatalog: { expiresAt: number; assets: SearchableAsset[] } | null =
    null;
  let assetCatalogRequest: Promise<SearchableAsset[]> | null = null;
  const companyMarketCache = new Map<
    string,
    {
      expiresAt: number;
      value: ReturnType<typeof companyMarketSnapshot>;
    }
  >();
  let discoveryCache: {
    expiresAt: number;
    value: ReturnType<typeof discoveryDto>;
  } | null = null;
  let clockCache: { expiresAt: number; value: any } | null = null;
  let calendarCache: {
    expiresAt: number;
    value: ReturnType<typeof calendarDto>;
  } | null = null;
  const monitoringCache = new Map<
    string,
    { expiresAt: number; value: MarketMonitoringResponse }
  >();
  let multiAssetCache: {
    expiresAt: number;
    value: ReturnType<typeof multiAssetDto>;
  } | null = null;

  const stockStream = createStockStreamService(alpaca);

  async function getClock() {
    if (clockCache && clockCache.expiresAt > Date.now())
      return clockCache.value;
    const value = await alpaca.trading.calendar.clock();
    clockCache = { value, expiresAt: Date.now() + 30_000 };
    return value;
  }

  async function getDiscovery() {
    if (discoveryCache && discoveryCache.expiresAt > Date.now())
      return discoveryCache.value;
    const [movers, actives, clock] = await Promise.all([
      alpaca.marketData.screener.movers({ marketType: "stocks", top: 5 }),
      alpaca.marketData.screener.mostActives({ by: "volume", top: 5 }),
      getClock(),
    ]);
    const value = discoveryDto(movers, actives, clock);
    discoveryCache = { value, expiresAt: Date.now() + 30_000 };
    return value;
  }

  async function getCalendar() {
    if (calendarCache && calendarCache.expiresAt > Date.now())
      return calendarCache.value;
    const start = new Date();
    const end = new Date(Date.now() + 21 * 86_400_000);
    const [calendar, clock] = await Promise.all([
      alpaca.trading.calendar.calendar({ market: "NASDAQ", start, end }),
      getClock(),
    ]);
    const value = calendarDto(calendar, clock);
    calendarCache = { value, expiresAt: Date.now() + 5 * 60_000 };
    return value;
  }

  async function getWatchlists() {
    const summaries = await alpaca.trading.watchlists.getWatchlists();
    return Promise.all(
      summaries.map((item) =>
        alpaca.trading.watchlists.getWatchlistById({ watchlistId: item.id }),
      ),
    );
  }

  async function buildMonitoring(
    force = false,
  ): Promise<MarketMonitoringResponse> {
    const [positions, rawWatchlists] = await Promise.all([
      alpaca.trading.positions.getAllOpenPositions(),
      getWatchlists(),
    ]);
    const watchlists = rawWatchlists.map(watchlistDto) as MonitoringWatchlist[];
    const allSymbols = [
      ...new Set(
        [
          ...positions.map((position) => position.symbol),
          ...watchlists.flatMap((list) =>
            list.assets.map((asset) => asset.symbol),
          ),
        ].map((symbol) => symbol.toUpperCase()),
      ),
    ].sort();
    const symbols = allSymbols.slice(0, 100);
    const key = JSON.stringify({
      positions: positions.map((position) => [position.symbol, position.qty]),
      watchlists: watchlists.map((list) => [
        list.id,
        list.name,
        list.assets.map((asset) => asset.symbol),
      ]),
      symbols,
    });
    const cached = monitoringCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    if (!symbols.length) {
      return {
        news: [],
        corporateActions: [],
        secFilings: [],
        clusters: [],
        warnings: [],
        coverage: {
          symbols: [],
          omittedSymbols: 0,
          secSymbols: [],
          secOmittedSymbols: 0,
        },
        asOf: new Date().toISOString(),
      };
    }

    const now = new Date();
    const start = new Date(now.getTime() - 7 * 86_400_000);
    const end = new Date(now.getTime() + 90 * 86_400_000);
    const secSymbols = symbols.slice(0, 12);
    const [brokerResults, secResults] = await Promise.all([
      Promise.allSettled([
        alpaca.marketData.news.news({
          symbols: symbols.join(","),
          start,
          sort: "desc",
          limit: 30,
          includeContent: false,
        }),
        alpaca.marketData.collectCorporateActions({
          symbols,
          start,
          end,
          sort: "asc",
          limit: 1_000,
        }),
      ]),
      Promise.allSettled(
        secSymbols.map((symbol) => getSec8KAlerts(symbol, 14, 2)),
      ),
    ]);
    const [newsResult, actionsResult] = brokerResults;
    const warnings: string[] = [];
    if (newsResult.status === "rejected") {
      warnings.push("Portfolio and watchlist news is temporarily unavailable.");
    }
    if (actionsResult.status === "rejected") {
      warnings.push(
        "Corporate-action data is temporarily unavailable or not included in this account's data entitlement.",
      );
    }
    if (secResults.some((result) => result.status === "rejected")) {
      warnings.push(
        "Official SEC 8-K monitoring is temporarily incomplete for one or more symbols.",
      );
    }
    if (allSymbols.length > symbols.length) {
      warnings.push(
        `Monitoring is limited to the first ${symbols.length} symbols; ${allSymbols.length - symbols.length} symbols are omitted.`,
      );
    }
    if (symbols.length > secSymbols.length) {
      warnings.push(
        `SEC 8-K monitoring is limited to the first ${secSymbols.length} portfolio/watchlist symbols; ${symbols.length - secSymbols.length} symbols are omitted.`,
      );
    }
    const news = monitoringNews(
      newsResult.status === "fulfilled" ? newsResult.value.news : [],
      positions,
      watchlists,
    );
    const corporateActions = monitoringCorporateActions(
      actionsResult.status === "fulfilled" ? (actionsResult.value as any) : {},
      positions,
      watchlists,
    );
    const secFilings = monitoringSecFilings(
      secResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value.alerts : [],
      ),
      positions,
      watchlists,
    );
    const value = {
      news,
      corporateActions,
      secFilings,
      clusters: monitoringEventClusters(news, corporateActions, secFilings),
      warnings,
      coverage: {
        symbols,
        omittedSymbols: allSymbols.length - symbols.length,
        secSymbols,
        secOmittedSymbols: symbols.length - secSymbols.length,
      },
      asOf: new Date().toISOString(),
    };
    monitoringCache.clear();
    monitoringCache.set(key, { value, expiresAt: Date.now() + 60_000 });
    return value;
  }

  function watchlistInput(value: unknown) {
    try {
      return parseWatchlistInput(value);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid watchlist",
        422,
      );
    }
  }

  function watchlistSymbol(value: unknown) {
    try {
      return parseSymbol(value);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid symbol",
        422,
      );
    }
  }

  async function getAssetCatalog() {
    if (assetCatalog && assetCatalog.expiresAt > Date.now())
      return assetCatalog.assets;
    assetCatalogRequest ??= alpaca.trading.assets
      .getV2Assets()
      .then((assets) =>
        assets
          .filter(
            (asset) =>
              asset._class === "us_equity" &&
              asset.status === "active" &&
              asset.tradable &&
              asset.symbol &&
              asset.name,
          )
          .map((asset) => ({
            symbol: asset.symbol,
            name: asset.name!,
            exchange: asset.exchange,
          })),
      )
      .finally(() => {
        assetCatalogRequest = null;
      });
    const assets = await assetCatalogRequest;
    assetCatalog = { assets, expiresAt: Date.now() + 15 * 60_000 };
    return assets;
  }

  async function handleRequest(
    request: Request,
    url: URL,
    actor: string,
  ): Promise<Response | null> {
    if (url.pathname === "/api/quote") {
      const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
      if (!symbol || !/^[A-Z.]{1,10}$/.test(symbol)) {
        return json({ error: "Valid symbol is required" }, 400);
      }
      const price = await alpaca.marketData.getLatestPrice(symbol);
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        return json({ error: "No valid current price" }, 502);
      }
      return json({ symbol, price, asOf: new Date().toISOString() });
    }

    if (url.pathname === "/api/market/stream" && request.method === "GET") {
      if (!allow(`${actor}:market-stream`, 20) || stockStream.size() >= 100) {
        return json({ error: "Market stream connection limit exceeded" }, 429);
      }
      let symbols: string[];
      try {
        symbols = parseStreamSymbols(url.searchParams.get("symbols") ?? "");
      } catch (error) {
        throw new ClientError(
          error instanceof Error ? error.message : "Invalid stream symbols",
          400,
        );
      }
      return stockStream.open(request, symbols);
    }

    if (
      url.pathname === "/api/market/multi-asset" &&
      request.method === "GET"
    ) {
      if (multiAssetCache && multiAssetCache.expiresAt > Date.now()) {
        return json(multiAssetCache.value);
      }
      const warnings: string[] = [];
      const [indices, forex, crypto] = await Promise.all([
        alpaca.marketData.indices
          .indexLatestValues({ symbols: "SPX,NDX,DJI,VIX" })
          .then((result) => result.values)
          .catch(() => {
            warnings.push(
              "Index data is unavailable for the current Alpaca entitlement.",
            );
            return {};
          }),
        alpaca.marketData.forex
          .latestRates({ currencyPairs: "EUR/USD,GBP/USD,USD/JPY" })
          .then((result) => result.rates)
          .catch(() => {
            warnings.push(
              "FX data is unavailable for the current Alpaca entitlement.",
            );
            return {};
          }),
        alpaca.marketData.crypto
          .cryptoSnapshots({ loc: "us", symbols: "BTC/USD,ETH/USD,SOL/USD" })
          .then((result) => result.snapshots)
          .catch(() => {
            warnings.push(
              "Crypto data is unavailable for the current Alpaca entitlement.",
            );
            return {};
          }),
      ]);
      const value = multiAssetDto({ indices, forex, crypto, warnings });
      multiAssetCache = { value, expiresAt: Date.now() + 30_000 };
      return json(value);
    }

    if (url.pathname === "/api/assets/search") {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (query.length < 1 || query.length > 50) {
        return json({ error: "Search must contain 1 to 50 characters" }, 400);
      }
      return json({
        query,
        results: searchAssets(await getAssetCatalog(), query),
      });
    }

    const assetLogoMatch =
      request.method === "GET" &&
      url.pathname.match(/^\/api\/assets\/([A-Z.]{1,10})\/logo$/);
    if (assetLogoMatch) {
      try {
        const logo = await alpaca.marketData.logos.logos({
          symbol: assetLogoMatch[1]!,
          placeholder: true,
        });
        return new Response(logo, {
          headers: {
            ...securityHeaders,
            "content-type": logo.type || "image/png",
            "cache-control": "public, max-age=86400",
            "x-logo-source": "alpaca",
          },
        });
      } catch {
        const symbol = assetLogoMatch[1]!;
        const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" viewBox="0 0 88 88"><rect width="88" height="88" rx="18" fill="#1e293b"/><text x="44" y="52" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" font-weight="700" fill="#e2e8f0">${symbol}</text></svg>`;
        return new Response(placeholder, {
          headers: {
            ...securityHeaders,
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=3600",
            "x-logo-source": "placeholder",
          },
        });
      }
    }

    if (url.pathname === "/api/company/market" && request.method === "GET") {
      const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
      const period = url.searchParams.get("period") ?? "3M";
      const benchmarkSymbol =
        url.searchParams.get("benchmark")?.trim().toUpperCase() || "SPY";
      const periodDays: Record<string, number> = {
        "1M": 35,
        "3M": 100,
        "1Y": 370,
      };
      if (
        !/^[A-Z.]{1,10}$/.test(symbol) ||
        !/^[A-Z.]{1,10}$/.test(benchmarkSymbol) ||
        !periodDays[period]
      ) {
        return json(
          {
            error:
              "Valid company, benchmark and period (1M, 3M, or 1Y) are required",
          },
          400,
        );
      }
      const cacheKey = `${symbol}:${period}:${benchmarkSymbol}`;
      const cached = companyMarketCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return json(cached.value);
      const start = new Date(Date.now() - periodDays[period] * 86_400_000);
      const [asset, snapshot, bars, news, clock, benchmarkBars] =
        await Promise.all([
          alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
            symbolOrAssetId: symbol,
          }),
          alpaca.marketData.stocks.stockSnapshotSingle({ symbol, feed: "iex" }),
          alpaca.marketData.getStockBarsFor(symbol, {
            timeframe: TimeFrame.Day,
            start,
            feed: "iex",
          }),
          alpaca.marketData.news
            .news({ symbols: symbol, limit: 8, sort: "desc" })
            .then((response) => response.news)
            .catch(() => []),
          alpaca.trading.calendar.clock(),
          alpaca.marketData.getStockBarsFor(benchmarkSymbol, {
            timeframe: TimeFrame.Day,
            start,
            feed: "iex",
          }),
        ]);
      const value = companyMarketSnapshot(
        asset,
        snapshot,
        bars,
        news,
        clock,
        period,
        benchmarkSymbol,
        benchmarkBars,
      );
      companyMarketCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + 30_000,
      });
      if (companyMarketCache.size > 60) {
        companyMarketCache.delete(companyMarketCache.keys().next().value!);
      }
      return json(value);
    }

    if (url.pathname === "/api/market/workspace" && request.method === "GET") {
      const [watchlists, discovery, calendar] = await Promise.all([
        getWatchlists(),
        getDiscovery(),
        getCalendar(),
      ]);
      return json({
        watchlists: watchlists.map(watchlistDto),
        discovery,
        calendar,
      });
    }

    if (url.pathname === "/api/market/monitoring" && request.method === "GET") {
      return json(
        await buildMonitoring(url.searchParams.get("refresh") === "1"),
      );
    }

    if (url.pathname === "/api/watchlists" && request.method === "POST") {
      if (!allow(`${actor}:watchlists`, 30)) {
        return json({ error: "Watchlist rate limit exceeded" }, 429);
      }
      const input = watchlistInput(await requestJson(request));
      const watchlist = await alpaca.trading.watchlists.postWatchlist({
        updateWatchlistRequest: input,
      });
      store.event("watchlist.created", actor, {
        watchlistId: watchlist.id,
        name: input.name,
        symbols: input.symbols,
      });
      return json(watchlistDto(watchlist), 201);
    }

    const watchlistMatch = url.pathname.match(
      /^\/api\/watchlists\/([A-Za-z0-9-]{1,64})$/,
    );
    if (watchlistMatch && request.method === "PATCH") {
      if (!allow(`${actor}:watchlists`, 30)) {
        return json({ error: "Watchlist rate limit exceeded" }, 429);
      }
      const input = watchlistInput(await requestJson(request));
      const watchlist = await alpaca.trading.watchlists.updateWatchlistById({
        watchlistId: watchlistMatch[1]!,
        updateWatchlistRequest: input,
      });
      store.event("watchlist.updated", actor, {
        watchlistId: watchlist.id,
        name: input.name,
        symbols: input.symbols,
      });
      return json(watchlistDto(watchlist));
    }
    if (watchlistMatch && request.method === "DELETE") {
      if (!allow(`${actor}:watchlists`, 30)) {
        return json({ error: "Watchlist rate limit exceeded" }, 429);
      }
      await alpaca.trading.watchlists.deleteWatchlistById({
        watchlistId: watchlistMatch[1]!,
      });
      store.event("watchlist.deleted", actor, {
        watchlistId: watchlistMatch[1],
      });
      return new Response(null, { status: 204, headers: securityHeaders });
    }

    const watchlistAssetsMatch = url.pathname.match(
      /^\/api\/watchlists\/([A-Za-z0-9-]{1,64})\/assets$/,
    );
    if (watchlistAssetsMatch && request.method === "POST") {
      if (!allow(`${actor}:watchlists`, 30)) {
        return json({ error: "Watchlist rate limit exceeded" }, 429);
      }
      const symbol = watchlistSymbol((await requestJson(request)).symbol);
      const watchlist = await alpaca.trading.watchlists.addAssetToWatchlist({
        watchlistId: watchlistAssetsMatch[1]!,
        addAssetToWatchlistRequest: { symbol },
      });
      store.event("watchlist.asset.added", actor, {
        watchlistId: watchlist.id,
        symbol,
      });
      return json(watchlistDto(watchlist));
    }

    const watchlistAssetMatch = url.pathname.match(
      /^\/api\/watchlists\/([A-Za-z0-9-]{1,64})\/assets\/([^/]+)$/,
    );
    if (watchlistAssetMatch && request.method === "DELETE") {
      if (!allow(`${actor}:watchlists`, 30)) {
        return json({ error: "Watchlist rate limit exceeded" }, 429);
      }
      const symbol = watchlistSymbol(
        decodeURIComponent(watchlistAssetMatch[2]!),
      );
      const watchlist =
        await alpaca.trading.watchlists.removeAssetFromWatchlist({
          watchlistId: watchlistAssetMatch[1]!,
          symbol,
        });
      store.event("watchlist.asset.removed", actor, {
        watchlistId: watchlist.id,
        symbol,
      });
      return json(watchlistDto(watchlist));
    }

    return null;
  }

  const start = () => stockStream.start();

  return { getClock, handleRequest, start };
}
