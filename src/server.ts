import { Alpaca, TimeFrame } from "@alpacahq/alpaca-ts-alpha";
import { benchmarkAttribution, diversificationScore, performancePoints, performanceSummary, stressTests, valueAtRisk95 } from "./analytics";
import { advancedPortfolioRisk, positionLiquidity } from "./advanced-risk";
import { companyMarketSnapshot } from "./company-market";
import { Intent, runPortfolioCopilot } from "./copilot";
import { cryptoBarsDto, cryptoSnapshotDto, parseCryptoLookbackDays, parseCryptoSymbols, parseCryptoTimeframe } from "./crypto-strategy-data";
import { ledgerSummary, normalizeActivity, type LedgerCategory } from "./ledger";
import { monitoringCorporateActions, monitoringEventClusters, monitoringNews, type MonitoringWatchlist } from "./market-monitoring";
import { parseStreamSymbols, streamBarDto, streamQuoteDto } from "./market-stream";
import { calendarDto, discoveryDto, orderSessionGuidance, parseSymbol, parseWatchlistInput, watchlistDto } from "./market-workspace";
import { multiAssetDto } from "./multi-asset";
import { buildReplacementPreview, canCancelOrder, managedOrderDto, OrderTracker, ReplacementInput, signCancelAllPreview, signReplacementPreview, verifyCancelAllPreview, verifyReplacementPreview } from "./order-management";
import { auctionSubmissionError, linkedOrderError, liquidityPreview, OrderTicket, ticketQuantity, ticketRiskPrice } from "./order-ticket";
import { signPreview, verifyPreviewFresh, type Preview } from "./orders";
import { OptionChainQuery, optionChainDto, optionPortfolioGreeks } from "./options-workspace";
import { OptionOrderTicket, optionOrderRisk, signOptionOrderPreview, signOptionPositionAction, verifyOptionOrderPreview, verifyOptionPositionAction } from "./option-order";
import { buildPortfolioSnapshot } from "./portfolio-snapshot";
import { RebalanceBasket, signRebalanceBasketPreview, simulateRebalanceBasket, verifyRebalanceBasketPreview } from "./rebalance-basket";
import { historicalRisk, portfolioHistory, riskSnapshot, rollingTurnover, simulateTrade } from "./risk";
import { runCompanyResearch } from "./research";
import { actorFor, rateLimiter, securityReady, validMutationOrigin } from "./security";
import { searchAssets, type SearchableAsset } from "./search";
import { createStore } from "./store";

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const store = createStore();
const previewSecret = process.env.PREVIEW_SECRET ?? "";
const securityHeaders = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...securityHeaders, "cache-control": "no-store" } });
const MAX_JSON_BYTES = 16_384;

async function requestJson(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new ClientError("Request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new ClientError("Request body is too large", 413);
  try { return JSON.parse(text); }
  catch { throw new ClientError("Request body must be valid JSON", 400); }
}

class ClientError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const accountDto = (account: any) => ({ equity: account.equity, cash: account.cash, buyingPower: account.buyingPower, currency: account.currency, status: account.status });
const positionDto = (position: any) => ({ symbol: position.symbol, qty: position.qty, avgEntryPrice: position.avgEntryPrice, currentPrice: position.currentPrice, marketValue: position.marketValue, unrealizedPl: position.unrealizedPl, unrealizedPlpc: position.unrealizedPlpc });
const allow = rateLimiter();

function shortCapabilityError(account: any, asset: any) {
  if (!account.shortingEnabled || Number(account.multiplier ?? 1) <= 1) return "This paper account is not enabled for margin short selling";
  if (!asset.shortable || !asset.easyToBorrow || !asset.marginable) return "This asset is not currently marginable and easy-to-borrow for a paper short";
  return null;
}
let assetCatalog: { expiresAt: number; assets: SearchableAsset[] } | null = null;
let assetCatalogRequest: Promise<SearchableAsset[]> | null = null;
let activitySync: { expiresAt: number; imported: number; truncated: boolean } | null = null;
let activitySyncRequest: Promise<{ imported: number; truncated: boolean }> | null = null;
const orderTracker = new OrderTracker();
let orderRecoveryRequest: Promise<void> | null = null;
let portfolioCaptureRequest: Promise<ReturnType<typeof buildPortfolioSnapshot>> | null = null;
const companyMarketCache = new Map<string, { expiresAt: number; value: ReturnType<typeof companyMarketSnapshot> }>();
let marketDiscoveryCache: { expiresAt: number; value: ReturnType<typeof discoveryDto> } | null = null;
let marketClockCache: { expiresAt: number; value: any } | null = null;
let marketCalendarCache: { expiresAt: number; value: ReturnType<typeof calendarDto> } | null = null;
type MarketMonitoringResponse = { news: ReturnType<typeof monitoringNews>; corporateActions: ReturnType<typeof monitoringCorporateActions>; clusters: ReturnType<typeof monitoringEventClusters>; warnings: string[]; coverage: { symbols: string[]; omittedSymbols: number }; asOf: string };
const marketMonitoringCache = new Map<string, { expiresAt: number; value: MarketMonitoringResponse }>();
const optionChainCache = new Map<string, { expiresAt: number; value: ReturnType<typeof optionChainDto> }>();
let multiAssetCache: { expiresAt: number; value: ReturnType<typeof multiAssetDto> } | null = null;
const stockUpdates = alpaca.marketData.stockStream({ feed: "iex", reconnect: true, maxReconnectSec: 30 });
const streamEncoder = new TextEncoder();
const streamSubscribers = new Map<number, { symbols: Set<string>; controller: ReadableStreamDefaultController<Uint8Array> }>();
const streamSymbolReferences = new Map<string, number>();
let stockStreamState = "connecting", nextStreamSubscriberId = 1;

function streamSend(controller: ReadableStreamDefaultController<Uint8Array>, value: unknown) {
  controller.enqueue(streamEncoder.encode(`data: ${JSON.stringify(value)}\n\n`));
}

function streamBroadcast(value: { kind: string; symbol?: string; [key: string]: unknown }) {
  for (const [id, subscriber] of streamSubscribers) {
    if (value.symbol && !subscriber.symbols.has(value.symbol)) continue;
    try { streamSend(subscriber.controller, value); }
    catch { removeStreamSubscriber(id); }
  }
}

function removeStreamSubscriber(id: number) {
  const subscriber = streamSubscribers.get(id);
  if (!subscriber) return;
  streamSubscribers.delete(id);
  const unused: string[] = [];
  for (const symbol of subscriber.symbols) {
    const references = (streamSymbolReferences.get(symbol) ?? 1) - 1;
    if (references <= 0) { streamSymbolReferences.delete(symbol); unused.push(symbol); }
    else streamSymbolReferences.set(symbol, references);
  }
  if (unused.length) { stockUpdates.unsubscribeFromQuotes(unused); stockUpdates.unsubscribeFromBars(unused); }
}

function addStreamSubscriber(symbols: string[], controller: ReadableStreamDefaultController<Uint8Array>) {
  const id = nextStreamSubscriberId++, added: string[] = [];
  streamSubscribers.set(id, { symbols: new Set(symbols), controller });
  for (const symbol of symbols) {
    const references = streamSymbolReferences.get(symbol) ?? 0;
    streamSymbolReferences.set(symbol, references + 1);
    if (!references) added.push(symbol);
  }
  if (added.length) { stockUpdates.subscribeForQuotes(added); stockUpdates.subscribeForBars(added); }
  streamSend(controller, { kind: "status", state: stockStreamState, symbols, asOf: new Date().toISOString() });
  return id;
}

stockUpdates.onStateChange(state => { stockStreamState = String(state); streamBroadcast({ kind: "status", state: stockStreamState, asOf: new Date().toISOString() }); });
stockUpdates.onConnect(() => {
  stockStreamState = "authenticated";
  const symbols = [...streamSymbolReferences.keys()];
  if (symbols.length) { stockUpdates.subscribeForQuotes(symbols); stockUpdates.subscribeForBars(symbols); }
  streamBroadcast({ kind: "status", state: stockStreamState, asOf: new Date().toISOString() });
});
stockUpdates.onDisconnect(() => { stockStreamState = "disconnected"; streamBroadcast({ kind: "status", state: stockStreamState, asOf: new Date().toISOString() }); });
stockUpdates.onError(error => { stockStreamState = "error"; console.error("stock stream error", error); streamBroadcast({ kind: "status", state: stockStreamState, asOf: new Date().toISOString() }); });
stockUpdates.onQuote(quote => { try { streamBroadcast(streamQuoteDto(quote)); } catch (error) { console.error("invalid stock quote", error); } });
stockUpdates.onBar(bar => { try { streamBroadcast(streamBarDto(bar)); } catch (error) { console.error("invalid stock bar", error); } });

async function getMarketDiscovery() {
  if (marketDiscoveryCache && marketDiscoveryCache.expiresAt > Date.now()) return marketDiscoveryCache.value;
  const [movers, actives, clock] = await Promise.all([
    alpaca.marketData.screener.movers({ marketType: "stocks", top: 5 }),
    alpaca.marketData.screener.mostActives({ by: "volume", top: 5 }),
    getMarketClock(),
  ]);
  const value = discoveryDto(movers, actives, clock);
  marketDiscoveryCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

async function getMarketClock() {
  if (marketClockCache && marketClockCache.expiresAt > Date.now()) return marketClockCache.value;
  const value = await alpaca.trading.calendar.clock();
  marketClockCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

async function getMarketCalendar() {
  if (marketCalendarCache && marketCalendarCache.expiresAt > Date.now()) return marketCalendarCache.value;
  const start = new Date(), end = new Date(Date.now() + 21 * 86_400_000);
  const [calendar, clock] = await Promise.all([alpaca.trading.calendar.calendar({ market: "NASDAQ", start, end }), getMarketClock()]);
  const value = calendarDto(calendar, clock);
  marketCalendarCache = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

async function getWatchlists() {
  const summaries = await alpaca.trading.watchlists.getWatchlists();
  return Promise.all(summaries.map(item => alpaca.trading.watchlists.getWatchlistById({ watchlistId: item.id })));
}

async function buildMarketMonitoring(force = false): Promise<MarketMonitoringResponse> {
  const [positions, rawWatchlists] = await Promise.all([alpaca.trading.positions.getAllOpenPositions(), getWatchlists()]);
  const watchlists = rawWatchlists.map(watchlistDto) as MonitoringWatchlist[];
  const allSymbols = [...new Set([...positions.map(position => position.symbol), ...watchlists.flatMap(list => list.assets.map(asset => asset.symbol))].map(symbol => symbol.toUpperCase()))].sort();
  const symbols = allSymbols.slice(0, 100);
  const key = JSON.stringify({ positions: positions.map(position => [position.symbol, position.qty]), watchlists: watchlists.map(list => [list.id, list.name, list.assets.map(asset => asset.symbol)]), symbols });
  const cached = marketMonitoringCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  if (!symbols.length) return { news: [], corporateActions: [], clusters: [], warnings: [], coverage: { symbols: [], omittedSymbols: 0 }, asOf: new Date().toISOString() };
  const now = new Date(), start = new Date(now.getTime() - 7 * 86_400_000), end = new Date(now.getTime() + 90 * 86_400_000);
  const [newsResult, actionsResult] = await Promise.allSettled([
    alpaca.marketData.news.news({ symbols: symbols.join(","), start, sort: "desc", limit: 30, includeContent: false }),
    alpaca.marketData.collectCorporateActions({ symbols, start, end, sort: "asc", limit: 1_000 }),
  ]);
  const warnings: string[] = [];
  if (newsResult.status === "rejected") warnings.push("Portfolio and watchlist news is temporarily unavailable.");
  if (actionsResult.status === "rejected") warnings.push("Corporate-action data is temporarily unavailable or not included in this account's data entitlement.");
  if (allSymbols.length > symbols.length) warnings.push(`Monitoring is limited to the first ${symbols.length} symbols; ${allSymbols.length - symbols.length} symbols are omitted.`);
  const news = monitoringNews(newsResult.status === "fulfilled" ? newsResult.value.news : [], positions, watchlists);
  const corporateActions = monitoringCorporateActions(actionsResult.status === "fulfilled" ? actionsResult.value as any : {}, positions, watchlists);
  const value = { news, corporateActions, clusters: monitoringEventClusters(news, corporateActions), warnings, coverage: { symbols, omittedSymbols: allSymbols.length - symbols.length }, asOf: new Date().toISOString() };
  marketMonitoringCache.clear();
  marketMonitoringCache.set(key, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

function watchlistInput(value: unknown) {
  try { return parseWatchlistInput(value); }
  catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid watchlist", 422); }
}

function watchlistSymbol(value: unknown) {
  try { return parseSymbol(value); }
  catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid symbol", 422); }
}

async function getAssetCatalog() {
  if (assetCatalog && assetCatalog.expiresAt > Date.now()) return assetCatalog.assets;
  assetCatalogRequest ??= alpaca.trading.assets.getV2Assets().then(assets => assets
    .filter(asset => asset._class === "us_equity" && asset.status === "active" && asset.tradable && asset.symbol && asset.name)
    .map(asset => ({ symbol: asset.symbol, name: asset.name!, exchange: asset.exchange })))
    .finally(() => { assetCatalogRequest = null; });
  const assets = await assetCatalogRequest;
  assetCatalog = { assets, expiresAt: Date.now() + 15 * 60_000 };
  return assets;
}

async function syncAccountActivities() {
  if (activitySync && activitySync.expiresAt > Date.now()) return activitySync;
  activitySyncRequest ??= (async () => {
    const activities = [];
    const maximum = 1_000;
    for await (const activity of alpaca.trading.iterateActivities({ direction: "desc", pageSize: 100 })) {
      activities.push(normalizeActivity(activity));
      if (activities.length >= maximum) break;
    }
    store.syncActivities(activities);
    return { imported: activities.length, truncated: activities.length >= maximum };
  })().finally(() => { activitySyncRequest = null; });
  const result = await activitySyncRequest;
  activitySync = { ...result, expiresAt: Date.now() + 30_000 };
  return activitySync;
}

function reconcileOrder(order: any) {
  if (order.id && order.status) store.reconcileOrder(order.id, order.status);
  if (!order.clientOrderId || !order.status) return;
  if (order.status === "filled") store.finishRiskReservation(order.clientOrderId, "filled");
  else if (["canceled", "expired", "replaced"].includes(order.status)) store.finishRiskReservation(order.clientOrderId, "canceled");
  else if (order.status === "rejected") store.finishRiskReservation(order.clientOrderId, "rejected");
}

async function recoverOrders() {
  orderRecoveryRequest ??= (async () => {
    const orders = await alpaca.trading.orders.getAllOrders({ status: "all", limit: 100, direction: "desc", nested: true });
    orderTracker.recover(orders);
    for (const order of orders) reconcileOrder(order);
  })().finally(() => { orderRecoveryRequest = null; });
  return orderRecoveryRequest;
}

async function capturePortfolioSnapshot() {
  portfolioCaptureRequest ??= (async () => {
    const [account, positions] = await Promise.all([alpaca.trading.account.getAccount(), alpaca.trading.positions.getAllOpenPositions()]);
    if (account.equity === undefined || account.cash === undefined || account.buyingPower === undefined) throw new Error("Account snapshot data unavailable");
    const risk = riskSnapshot(account.equity, account.cash, positions);
    const snapshot = buildPortfolioSnapshot(account, positions, risk, orderTracker.metadata());
    store.portfolioSnapshot(snapshot);
    return snapshot;
  })().finally(() => { portfolioCaptureRequest = null; });
  return portfolioCaptureRequest;
}

const workingStatuses = new Set(["new", "accepted", "pending_new", "pending_replace", "accepted_for_bidding", "partially_filled", "held", "calculated", "stopped"]);

async function pendingBrokerOrders(orders: any[], candidatePrices: Map<string, number>) {
  const working = orders.filter(order => workingStatuses.has(String(order.status)));
  const symbols = [...new Set(working.map(order => String(order.symbol)))];
  const prices = new Map(await Promise.all(symbols.map(async symbol => [symbol, candidatePrices.get(symbol) ?? await alpaca.marketData.getLatestPrice(symbol)] as const)));
  return working.map(order => {
    const qty = Number(order.qty) - Number(order.filledQty ?? 0);
    const price = Number(order.limitPrice ?? order.stopPrice ?? prices.get(String(order.symbol)));
    if (!(qty > 0) || !Number.isFinite(price) || price <= 0 || !["buy", "sell"].includes(order.side)) {
      throw new Error("A working order could not be valued safely");
    }
    return { orderId: order.id, symbol: String(order.symbol), side: order.side as "buy" | "sell", qty, price };
  });
}

function placePreviewedOrder(preview: Preview, clientOrderId: string) {
  const common = { symbol: preview.symbol, side: preview.side, timeInForce: preview.timeInForce, extendedHours: preview.extendedHours, clientOrderId };
  const takeProfit = preview.takeProfitPrice ? { limitPrice: preview.takeProfitPrice } : undefined;
  const stopLoss = preview.stopLossPrice ? { stopPrice: preview.stopLossPrice, ...(preview.stopLossLimitPrice ? { limitPrice: preview.stopLossLimitPrice } : {}) } : undefined;
  if (preview.orderClass === "bracket") return alpaca.trading.orders.bracket({ ...common, side: "buy", qty: preview.qty, ...(preview.limitPrice ? { limitPrice: preview.limitPrice } : {}), takeProfit: takeProfit!, stopLoss: stopLoss! });
  if (preview.orderClass === "oco") return alpaca.trading.orders.oco({ ...common, side: "sell", qty: preview.qty, takeProfit: takeProfit!, stopLoss: stopLoss! });
  if (preview.orderClass === "oto") return takeProfit
    ? alpaca.trading.orders.oto({ ...common, side: "buy", qty: preview.qty, ...(preview.limitPrice ? { limitPrice: preview.limitPrice } : {}), takeProfit })
    : alpaca.trading.orders.oto({ ...common, side: "buy", qty: preview.qty, ...(preview.limitPrice ? { limitPrice: preview.limitPrice } : {}), stopLoss: stopLoss! });
  if (preview.type === "market") return preview.amountType === "notional"
    ? alpaca.trading.orders.market({ ...common, notional: preview.notional! })
    : alpaca.trading.orders.market({ ...common, qty: preview.qty });
  if (preview.type === "limit") return alpaca.trading.orders.limit({ ...common, qty: preview.qty, limitPrice: preview.limitPrice! });
  if (preview.type === "stop") return alpaca.trading.orders.stop({ ...common, qty: preview.qty, stopPrice: preview.stopPrice! });
  if (preview.type === "stop_limit") return alpaca.trading.orders.stopLimit({ ...common, qty: preview.qty, stopPrice: preview.stopPrice!, limitPrice: preview.limitPrice! });
  return alpaca.trading.orders.trailingStop({ ...common, qty: preview.qty, trailPercent: preview.trailPercent! });
}

async function optionOrderMarketData(symbols: string[]) {
  const [contracts, snapshots] = await Promise.all([
    Promise.all(symbols.map(symbol => alpaca.trading.assets.getOptionContractSymbolOrId({ symbolOrId: symbol }))),
    alpaca.marketData.options.optionSnapshots({ symbols: symbols.join(",") }),
  ]);
  return { contracts, snapshots: snapshots.snapshots ?? {} };
}

const serverPort = Number(process.env.PORT ?? 3000);
Bun.serve({
  port: serverPort,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !validMutationOrigin(request)) return json({ error: "Invalid request origin" }, 403);
    let actor = "anonymous";
    if (url.pathname.startsWith("/api/")) {
      try { actor = actorFor(request); } catch { return json({ error: "Unauthorized" }, 401); }
    }
    try {
      if (url.pathname === "/") return new Response(Bun.file("src/index.html"), { headers: { ...securityHeaders, "cache-control": "no-store" } });
      if (url.pathname === "/health") return json({ status: "ok" });
      if (url.pathname === "/ready") {
        if (previewSecret.length < 32 || !securityReady()) return json({ status: "not_ready", error: "Security configuration is incomplete" }, 503);
        await alpaca.trading.account.getAccount();
        return json({ status: "ready", paper: true });
      }
      if (url.pathname === "/api/account") {
        const [account, positions, orders] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "open", limit: 100 }),
        ]);
        return json({ account: accountDto(account), positions: positions.map(positionDto), orders: orders.map(managedOrderDto) });
      }
      if (url.pathname === "/api/quote") {
        const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
        if (!symbol || !/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "Valid symbol is required" }, 400);
        const price = await alpaca.marketData.getLatestPrice(symbol);
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return json({ error: "No valid current price" }, 502);
        return json({ symbol, price, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/options/chain" && request.method === "GET") {
        const parsed = OptionChainQuery.safeParse({ symbol: url.searchParams.get("symbol"), expiration: url.searchParams.get("expiration") || undefined });
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Invalid option chain query" }, 400);
        const cacheKey = `${parsed.data.symbol}:${parsed.data.expiration ?? "nearest"}`, cached = optionChainCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return json(cached.value);
        const start = new Date(), end = new Date(Date.now() + 60 * 86_400_000);
        const [account, underlyingPrice, contractResponse] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.marketData.getLatestPrice(parsed.data.symbol),
          alpaca.trading.assets.getOptionsContracts({ underlyingSymbols: parsed.data.symbol, status: "active", expirationDateGte: start, expirationDateLte: end, limit: 500 }),
        ]);
        if (typeof underlyingPrice !== "number" || !Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return json({ error: "No valid underlying price" }, 400);
        const allContracts = contractResponse.optionContracts ?? [];
        const expirations = [...new Set(allContracts.map(contract => new Date(contract.expirationDate).toISOString().slice(0, 10)))].sort();
        const expiration = parsed.data.expiration ?? expirations[0];
        if (!expiration || !expirations.includes(expiration)) return json({ error: "No active option contracts are available for that expiration" }, 404);
        const contracts = allContracts.filter(contract => new Date(contract.expirationDate).toISOString().slice(0, 10) === expiration);
        const chainResponse = await alpaca.marketData.options.optionChain({ underlyingSymbol: parsed.data.symbol, expirationDate: new Date(`${expiration}T00:00:00Z`), limit: 500 });
        const value = optionChainDto(contracts, chainResponse.snapshots ?? {}, underlyingPrice, account);
        value.expirations = expirations;
        optionChainCache.set(cacheKey, { expiresAt: Date.now() + 30_000, value });
        return json(value);
      }
      if (url.pathname === "/api/options/portfolio" && request.method === "GET") {
        const positions = (await alpaca.trading.positions.getAllOpenPositions()).filter(position => position.assetClass === "us_option").slice(0, 50);
        if (!positions.length) return json(optionPortfolioGreeks([], {}, []));
        const symbols = positions.map(position => String(position.symbol));
        const [snapshotResponse, contracts] = await Promise.all([
          alpaca.marketData.options.optionSnapshots({ symbols: symbols.join(",") }),
          Promise.all(symbols.map(symbol => alpaca.trading.assets.getOptionContractSymbolOrId({ symbolOrId: symbol }))),
        ]);
        const underlyings = [...new Set(contracts.map(contract => String(contract.underlyingSymbol)))];
        const underlyingPrices = Object.fromEntries(await Promise.all(underlyings.map(async symbol => [symbol, await alpaca.marketData.getLatestPrice(symbol)])));
        return json(optionPortfolioGreeks(positions, snapshotResponse.snapshots ?? {}, contracts, underlyingPrices));
      }
      const optionActionPreviewMatch = request.method === "GET" && url.pathname.match(/^\/api\/options\/positions\/([^/]+)\/action-preview$/);
      if (optionActionPreviewMatch) {
        const symbol = decodeURIComponent(optionActionPreviewMatch[1]!), action = url.searchParams.get("action");
        if (!["exercise", "do_not_exercise"].includes(action ?? "")) return json({ error: "Valid option action is required" }, 400);
        const [position, contract] = await Promise.all([
          alpaca.trading.positions.getOpenPosition({ symbolOrAssetId: symbol }),
          alpaca.trading.assets.getOptionContractSymbolOrId({ symbolOrId: symbol }),
        ]);
        const qty = Number(position.qty), strike = Number(contract.strikePrice), multiplier = Number(contract.multiplier);
        if (!(qty > 0) || ![qty, strike, multiplier].every(Number.isFinite)) return json({ error: "Only exact long option positions can use this workflow" }, 400);
        const expiresAt = Date.now() + 60_000, preview = { symbol, action: action as "exercise" | "do_not_exercise", qty, strike, multiplier, optionType: contract.type, expiration: new Date(contract.expirationDate).toISOString().slice(0, 10), exerciseCost: contract.type === "call" ? strike * multiplier * qty : 0, expiresAt };
        return json({ preview, previewToken: signOptionPositionAction(preview, previewSecret) });
      }
      const optionActionMatch = request.method === "POST" && url.pathname.match(/^\/api\/options\/positions\/([^/]+)\/action$/);
      if (optionActionMatch) {
        const symbol = decodeURIComponent(optionActionMatch[1]!), { previewToken } = await requestJson(request);
        if (typeof previewToken !== "string") return json({ error: "Option action preview token is required" }, 400);
        let preview;
        try { preview = verifyOptionPositionAction(previewToken, previewSecret); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid option action token", 400); }
        if (preview.symbol !== symbol) return json({ error: "Option position changed after preview" }, 409);
        const position = await alpaca.trading.positions.getOpenPosition({ symbolOrAssetId: symbol });
        if (Number(position.qty) !== preview.qty) return json({ error: "Option position quantity changed after preview" }, 409);
        if (preview.action === "exercise") await alpaca.trading.positions.optionExercise({ symbolOrContractId: symbol });
        else await alpaca.trading.positions.optionDoNotExercise({ symbolOrContractId: symbol });
        store.event(`option.position.${preview.action}`, actor, preview);
        return json({ accepted: true, action: preview.action, symbol, qty: preview.qty });
      }
      if (url.pathname === "/api/market/stream" && request.method === "GET") {
        if (!allow(`${actor}:market-stream`, 20) || streamSubscribers.size >= 100) return json({ error: "Market stream connection limit exceeded" }, 429);
        let symbols: string[];
        try { symbols = parseStreamSymbols(url.searchParams.get("symbols") ?? ""); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid stream symbols", 400); }
        let subscriberId = 0, cleaned = false;
        const cleanup = () => { if (!cleaned) { cleaned = true; removeStreamSubscriber(subscriberId); } };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { subscriberId = addStreamSubscriber(symbols, controller); request.signal.addEventListener("abort", cleanup, { once: true }); },
          cancel: cleanup,
        });
        return new Response(stream, { headers: { ...securityHeaders, "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
      }
      if (url.pathname === "/api/market/multi-asset" && request.method === "GET") {
        if (multiAssetCache && multiAssetCache.expiresAt > Date.now()) return json(multiAssetCache.value);
        const warnings: string[] = [];
        const [indices, forex, crypto] = await Promise.all([
          alpaca.marketData.indices.indexLatestValues({ symbols: "SPX,NDX,DJI,VIX" }).then(result => result.values).catch(() => { warnings.push("Index data is unavailable for the current Alpaca entitlement."); return {}; }),
          alpaca.marketData.forex.latestRates({ currencyPairs: "EUR/USD,GBP/USD,USD/JPY" }).then(result => result.rates).catch(() => { warnings.push("FX data is unavailable for the current Alpaca entitlement."); return {}; }),
          alpaca.marketData.crypto.cryptoSnapshots({ loc: "us", symbols: "BTC/USD,ETH/USD,SOL/USD" }).then(result => result.snapshots).catch(() => { warnings.push("Crypto data is unavailable for the current Alpaca entitlement."); return {}; }),
        ]);
        const value = multiAssetDto({ indices, forex, crypto, warnings });
        multiAssetCache = { value, expiresAt: Date.now() + 30_000 };
        return json(value);
      }
      if (url.pathname === "/api/strategy/crypto/bars" && request.method === "GET") {
        let symbols: string[], timeframe: string, days: number;
        try {
          symbols = parseCryptoSymbols(url.searchParams.get("symbols"));
          timeframe = parseCryptoTimeframe(url.searchParams.get("timeframe"));
          days = parseCryptoLookbackDays(url.searchParams.get("days"));
        } catch (error) {
          throw new ClientError(error instanceof Error ? error.message : "Invalid crypto bar query", 400);
        }
        const end = new Date(), start = new Date(end.getTime() - days * 86_400_000);
        const bars = await alpaca.marketData.getCryptoBars({ loc: "us", symbols, timeframe, start, end, limit: 10_000 } as any);
        return json(cryptoBarsDto({ symbols, timeframe, start, end, bars }));
      }
      if (url.pathname === "/api/strategy/crypto/snapshots" && request.method === "POST") {
        if (!allow(`${actor}:strategy-crypto-ingest`, 20)) return json({ error: "Crypto strategy ingestion rate limit exceeded" }, 429);
        const input = await requestJson(request);
        const runId = String(input.runId ?? "").trim();
        if (!runId) return json({ error: "runId is required" }, 400);
        let symbols: string[];
        try { symbols = parseCryptoSymbols(input.symbols); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid crypto symbols", 400); }
        const requested = symbols.join(",");
        const receivedAt = new Date();
        const [snapshots, orderbooks] = await Promise.all([
          alpaca.marketData.crypto.cryptoSnapshots({ loc: "us", symbols: requested }).then(result => result.snapshots ?? {}),
          alpaca.marketData.crypto.cryptoLatestOrderbooks({ loc: "us", symbols: requested }).then(result => result.orderbooks ?? {}).catch(() => ({})),
        ]);
        const result = cryptoSnapshotDto({ symbols, snapshots, orderbooks, receivedAt });
        for (const record of result.records) store.strategyDataSnapshot({ ...record, runId });
        store.event("strategy.crypto.snapshots.ingested", actor, { runId, symbols, count: result.records.length, stale: result.records.filter(record => record.stale).length });
        return json({ runId, ...result });
      }
      if (url.pathname === "/api/assets/search") {
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (query.length < 1 || query.length > 50) return json({ error: "Search must contain 1 to 50 characters" }, 400);
        return json({ query, results: searchAssets(await getAssetCatalog(), query) });
      }
      const assetLogoMatch = request.method === "GET" && url.pathname.match(/^\/api\/assets\/([A-Z.]{1,10})\/logo$/);
      if (assetLogoMatch) {
        try {
          const logo = await alpaca.marketData.logos.logos({ symbol: assetLogoMatch[1]!, placeholder: true });
          return new Response(logo, { headers: { ...securityHeaders, "content-type": logo.type || "image/png", "cache-control": "public, max-age=86400", "x-logo-source": "alpaca" } });
        } catch {
          const symbol = assetLogoMatch[1]!;
          const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" viewBox="0 0 88 88"><rect width="88" height="88" rx="18" fill="#1e293b"/><text x="44" y="52" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" font-weight="700" fill="#e2e8f0">${symbol}</text></svg>`;
          return new Response(placeholder, { headers: { ...securityHeaders, "content-type": "image/svg+xml", "cache-control": "public, max-age=3600", "x-logo-source": "placeholder" } });
        }
      }
      if (url.pathname === "/api/company/market" && request.method === "GET") {
        const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
        const period = url.searchParams.get("period") ?? "3M";
        const benchmarkSymbol = url.searchParams.get("benchmark")?.trim().toUpperCase() || "SPY";
        const periodDays: Record<string, number> = { "1M": 35, "3M": 100, "1Y": 370 };
        if (!/^[A-Z.]{1,10}$/.test(symbol) || !/^[A-Z.]{1,10}$/.test(benchmarkSymbol) || !periodDays[period]) return json({ error: "Valid company, benchmark and period (1M, 3M, or 1Y) are required" }, 400);
        const cacheKey = `${symbol}:${period}:${benchmarkSymbol}`;
        const cached = companyMarketCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return json(cached.value);
        const start = new Date(Date.now() - periodDays[period] * 86_400_000);
        const [asset, snapshot, bars, news, clock, benchmarkBars] = await Promise.all([
          alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol }),
          alpaca.marketData.stocks.stockSnapshotSingle({ symbol, feed: "iex" }),
          alpaca.marketData.getStockBarsFor(symbol, { timeframe: TimeFrame.Day, start, feed: "iex" }),
          alpaca.marketData.news.news({ symbols: symbol, limit: 8, sort: "desc" }).then(response => response.news).catch(() => []),
          alpaca.trading.calendar.clock(),
          alpaca.marketData.getStockBarsFor(benchmarkSymbol, { timeframe: TimeFrame.Day, start, feed: "iex" }),
        ]);
        const value = companyMarketSnapshot(asset, snapshot, bars, news, clock, period, benchmarkSymbol, benchmarkBars);
        companyMarketCache.set(cacheKey, { value, expiresAt: Date.now() + 30_000 });
        if (companyMarketCache.size > 60) companyMarketCache.delete(companyMarketCache.keys().next().value!);
        return json(value);
      }
      if (url.pathname === "/api/market/workspace" && request.method === "GET") {
        const [watchlists, discovery, calendar] = await Promise.all([getWatchlists(), getMarketDiscovery(), getMarketCalendar()]);
        return json({ watchlists: watchlists.map(watchlistDto), discovery, calendar });
      }
      if (url.pathname === "/api/market/monitoring" && request.method === "GET") return json(await buildMarketMonitoring(url.searchParams.get("refresh") === "1"));
      if (url.pathname === "/api/watchlists" && request.method === "POST") {
        if (!allow(`${actor}:watchlists`, 30)) return json({ error: "Watchlist rate limit exceeded" }, 429);
        const input = watchlistInput(await requestJson(request));
        const watchlist = await alpaca.trading.watchlists.postWatchlist({ updateWatchlistRequest: input });
        store.event("watchlist.created", actor, { watchlistId: watchlist.id, name: input.name, symbols: input.symbols });
        return json(watchlistDto(watchlist), 201);
      }
      const watchlistMatch = url.pathname.match(/^\/api\/watchlists\/([A-Za-z0-9-]{1,64})$/);
      if (watchlistMatch && request.method === "PATCH") {
        if (!allow(`${actor}:watchlists`, 30)) return json({ error: "Watchlist rate limit exceeded" }, 429);
        const input = watchlistInput(await requestJson(request));
        const watchlist = await alpaca.trading.watchlists.updateWatchlistById({ watchlistId: watchlistMatch[1]!, updateWatchlistRequest: input });
        store.event("watchlist.updated", actor, { watchlistId: watchlist.id, name: input.name, symbols: input.symbols });
        return json(watchlistDto(watchlist));
      }
      if (watchlistMatch && request.method === "DELETE") {
        if (!allow(`${actor}:watchlists`, 30)) return json({ error: "Watchlist rate limit exceeded" }, 429);
        await alpaca.trading.watchlists.deleteWatchlistById({ watchlistId: watchlistMatch[1]! });
        store.event("watchlist.deleted", actor, { watchlistId: watchlistMatch[1] });
        return new Response(null, { status: 204, headers: securityHeaders });
      }
      const watchlistAssetsMatch = url.pathname.match(/^\/api\/watchlists\/([A-Za-z0-9-]{1,64})\/assets$/);
      if (watchlistAssetsMatch && request.method === "POST") {
        if (!allow(`${actor}:watchlists`, 30)) return json({ error: "Watchlist rate limit exceeded" }, 429);
        const symbol = watchlistSymbol((await requestJson(request)).symbol);
        const watchlist = await alpaca.trading.watchlists.addAssetToWatchlist({ watchlistId: watchlistAssetsMatch[1]!, addAssetToWatchlistRequest: { symbol } });
        store.event("watchlist.asset.added", actor, { watchlistId: watchlist.id, symbol });
        return json(watchlistDto(watchlist));
      }
      const watchlistAssetMatch = url.pathname.match(/^\/api\/watchlists\/([A-Za-z0-9-]{1,64})\/assets\/([^/]+)$/);
      if (watchlistAssetMatch && request.method === "DELETE") {
        if (!allow(`${actor}:watchlists`, 30)) return json({ error: "Watchlist rate limit exceeded" }, 429);
        const symbol = watchlistSymbol(decodeURIComponent(watchlistAssetMatch[2]!));
        const watchlist = await alpaca.trading.watchlists.removeAssetFromWatchlist({ watchlistId: watchlistAssetMatch[1]!, symbol });
        store.event("watchlist.asset.removed", actor, { watchlistId: watchlist.id, symbol });
        return json(watchlistDto(watchlist));
      }
      if (url.pathname === "/api/account/activities" && request.method === "GET") {
        const allowedCategories = new Set<LedgerCategory>(["trade", "dividend", "interest", "fee", "transfer", "corporate_action", "option", "other"]);
        const rawCategory = url.searchParams.get("category") ?? "";
        const category = rawCategory ? rawCategory as LedgerCategory : undefined;
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if ((category && !allowedCategories.has(category)) || !Number.isInteger(limit) || limit < 1 || limit > 200) return json({ error: "Valid activity category and limit from 1 to 200 are required" }, 400);
        const sync = await syncAccountActivities();
        const allActivities = store.activities(5_000);
        return json({ summary: ledgerSummary(allActivities, sync.truncated), activities: store.activities(limit, category), imported: sync.imported, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/portfolio/risk") {
        const [account, positions] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
        ]);
        if (account.equity === undefined || account.cash === undefined) return json({ error: "Account risk data unavailable" }, 502);
        const start = new Date(Date.now() - 90 * 86_400_000);
        const [positionData, benchmarkBars] = await Promise.all([
          Promise.all(positions.map(async position => {
            const [bars, marketSnapshot] = await Promise.all([alpaca.marketData.getStockBarsFor(position.symbol, { timeframe: TimeFrame.Day, start }), alpaca.marketData.stocks.stockSnapshotSingle({ symbol: position.symbol, feed: "iex" })]);
            return { position, bars: bars.slice(-90), marketSnapshot };
          })),
          alpaca.marketData.getStockBarsFor("SPY", { timeframe: TimeFrame.Day, start }),
        ]);
        const series = positionData.map(item => ({ marketValue: Number(item.position.marketValue), closes: item.bars.map(bar => bar.close) }));
        const history = portfolioHistory(Number(account.equity), Number(account.cash), series);
        const snapshot = riskSnapshot(account.equity, account.cash, positions);
        const advanced = advancedPortfolioRisk(snapshot.equity, positionData.map(item => ({ symbol: item.position.symbol, weight: Number(item.position.marketValue) / snapshot.equity, closes: item.bars.map(bar => bar.close) })), benchmarkBars.map(bar => bar.close));
        const liquidity = positionData.map(item => positionLiquidity(item.position, item.marketSnapshot, item.bars));
        return json({ ...snapshot, ...historicalRisk(history), ...valueAtRisk95(snapshot.equity, history), advanced, liquidity, diversification: diversificationScore(snapshot.hhi, snapshot.largestPositionPercent), stressTests: stressTests(snapshot.equity, snapshot.cash, snapshot.weights), asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/portfolio/snapshots" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 30);
        if (!Number.isInteger(limit) || limit < 1 || limit > 366) return json({ error: "Snapshot limit must be 1 to 366" }, 400);
        const current = await capturePortfolioSnapshot();
        return json({ current, history: store.portfolioSnapshots(limit), asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/portfolio/performance") {
        const periods: Record<string, string> = { "1M": "1M", "3M": "3M", "6M": "6M", "1Y": "1A" };
        const period = url.searchParams.get("period") ?? "3M";
        if (!periods[period]) return json({ error: "Period must be 1M, 3M, 6M, or 1Y" }, 400);
        const benchmarkSymbol = (process.env.PORTFOLIO_BENCHMARK ?? "SPY").trim().toUpperCase();
        if (!/^[A-Z.]{1,10}$/.test(benchmarkSymbol)) return json({ error: "PORTFOLIO_BENCHMARK must be a valid symbol" }, 500);
        const [history, positions] = await Promise.all([
          alpaca.trading.portfolioHistory.getAccountPortfolioHistory({ period: periods[period], timeframe: "1D", pnlReset: "no_reset", cashflowTypes: "CSD,CSW,JNLC" }),
          alpaca.trading.positions.getAllOpenPositions(),
        ]);
        const points = performancePoints(history);
        const benchmarkBars = points.length ? await alpaca.marketData.getStockBarsFor(benchmarkSymbol, { timeframe: TimeFrame.Day, start: new Date(points[0].timestamp - 3 * 86_400_000), end: new Date(points.at(-1)!.timestamp + 2 * 86_400_000) }) : [];
        const benchmark = benchmarkAttribution(points, benchmarkBars, benchmarkSymbol);
        const attribution = positions.map(position => ({ symbol: position.symbol, marketValue: Number(position.marketValue), unrealizedProfitLoss: Number(position.unrealizedPl), unrealizedReturnPercent: Number(position.unrealizedPlpc) * 100 }))
          .filter(item => Object.values(item).every(value => typeof value === "string" || Number.isFinite(value)))
          .sort((a, b) => b.unrealizedProfitLoss - a.unrealizedProfitLoss);
        return json({ period, summary: performanceSummary(points), benchmark, points, attribution, quality: { cashflowAdjusted: true, benchmarkCoverage: benchmark.quality }, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/agent/plans" && request.method === "POST") {
        if (!allow(`${actor}:agent`, 10)) return json({ error: "Agent rate limit exceeded" }, 429);
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable the agent" }, 503);
        const parsed = Intent.safeParse((await requestJson(request)).intent);
        if (!parsed.success) return json({ error: "Intent must be reduce_concentration, balanced_growth, or preserve_capital" }, 400);
        const planId = crypto.randomUUID();
        const output = await runPortfolioCopilot(alpaca, parsed.data);
        store.plan(planId, parsed.data, output);
        store.event("agent.plan.created", actor, { planId, intent: parsed.data, ideas: output.ideas.length });
        return json({ planId, intent: parsed.data, ...output });
      }
      if (url.pathname.startsWith("/api/agent/plans/") && request.method === "GET") {
        const plan = store.getPlan(url.pathname.split("/").pop() ?? "");
        return plan ? json(plan) : json({ error: "Plan not found" }, 404);
      }
      if (url.pathname === "/api/research/runs" && request.method === "POST") {
        if (!allow(`${actor}:research`, 6)) return json({ error: "Research agent rate limit exceeded" }, 429);
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable company research" }, 503);
        const symbol = String((await requestJson(request)).symbol ?? "").trim().toUpperCase();
        if (!/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "A valid stock symbol is required" }, 400);
        const runId = crypto.randomUUID(); const model = process.env.OPENAI_MODEL ?? "gpt-5.5";
        store.startResearch(runId, symbol, model);
        try {
          const result = await runCompanyResearch(alpaca, symbol, runId);
          store.completeResearch(runId, result, result.metrics);
          store.event("research.completed", actor, { runId, symbol, score: result.metrics.overallScore, latencyMs: result.metrics.latencyMs });
          return json(result);
        } catch (error) {
          store.failResearch(runId, error instanceof Error ? error.message : String(error));
          if (error instanceof Error && error.message.startsWith("Output guardrail triggered")) {
            throw new ClientError("The research report did not meet the minimum evidence-grounding threshold. Please run it again.", 422);
          }
          throw error;
        }
      }
      if (url.pathname === "/api/research/metrics" && request.method === "GET") return json(store.researchMetrics());
      if (url.pathname.startsWith("/api/research/runs/") && request.method === "GET") {
        const research = store.getResearch(url.pathname.split("/").pop() ?? "");
        return research ? json(research) : json({ error: "Research run not found" }, 404);
      }
      if (url.pathname === "/api/orders" && request.method === "GET") {
        const status = url.searchParams.get("status") ?? "all";
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if (!["open", "closed", "all"].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: "Status must be open, closed, or all and limit must be 1 to 100" }, 400);
        if (orderTracker.size === 0) await recoverOrders();
        const orders = orderTracker.list(status as "open" | "closed" | "all", limit);
        return json({ status, orders: orders.map(managedOrderDto), sync: orderTracker.metadata(), asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/orders/cancel-all-preview" && request.method === "GET") {
        const orders = (await alpaca.trading.orders.getAllOrders({ status: "open", limit: 100, nested: true })).filter(order => order.id && canCancelOrder(order.status));
        if (!orders.length) return json({ error: "There are no cancelable working orders" }, 409);
        const expiresAt = Date.now() + 60_000, orderIds = orders.map(order => order.id!);
        return json({ orders: orders.map(managedOrderDto), expiresAt, previewToken: signCancelAllPreview({ orderIds, expiresAt }, previewSecret) });
      }
      if (url.pathname === "/api/orders" && request.method === "DELETE") {
        if (!allow(`${actor}:order-cancel-all`, 5)) return json({ error: "Cancel-all rate limit exceeded" }, 429);
        const { previewToken } = await requestJson(request);
        if (typeof previewToken !== "string") return json({ error: "A cancel-all preview token is required" }, 400);
        let preview;
        try { preview = verifyCancelAllPreview(previewToken, previewSecret); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid cancel-all preview", 400); }
        const results = await Promise.all(preview.orderIds.map(async orderId => {
          try {
            const order = await alpaca.trading.orders.getOrderByOrderID({ orderId, nested: true });
            if (!canCancelOrder(order.status)) return { orderId, status: "not_cancelable", brokerStatus: order.status };
            await alpaca.trading.orders.deleteOrderByOrderID({ orderId });
            return { orderId, status: "cancel_requested" };
          } catch { return { orderId, status: "state_changed" }; }
        }));
        store.event("orders.cancel_all.requested", actor, { reviewedOrderIds: preview.orderIds, results });
        return json({ results, requestedAt: new Date().toISOString() }, 202);
      }
      const cancelOrderMatch = request.method === "DELETE" && url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/i);
      if (cancelOrderMatch) {
        if (!allow(`${actor}:order-cancel`, 20)) return json({ error: "Order cancellation rate limit exceeded" }, 429);
        const orderId = cancelOrderMatch[1]!;
        const order = await alpaca.trading.orders.getOrderByOrderID({ orderId, nested: true });
        if (!order.id || !canCancelOrder(order.status)) return json({ error: `Order is no longer cancelable (${order.status ?? "unknown"})` }, 409);
        try { await alpaca.trading.orders.deleteOrderByOrderID({ orderId }); }
        catch { throw new ClientError("Alpaca could not accept the cancellation because the order state changed. Refresh the blotter.", 409); }
        store.event("order.cancel.requested", actor, { orderId, clientOrderId: order.clientOrderId, symbol: order.symbol, priorStatus: order.status });
        return json({ orderId, status: "cancel_requested", requestedAt: new Date().toISOString() }, 202);
      }
      const replacementPreviewMatch = request.method === "POST" && url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/replacement-preview$/i);
      if (replacementPreviewMatch) {
        if (!allow(`${actor}:order-replace`, 20)) return json({ error: "Order replacement rate limit exceeded" }, 429);
        const body = await requestJson(request);
        const replacement = ReplacementInput.safeParse({ qty: Number(body.qty), limitPrice: body.limitPrice === null ? null : Number(body.limitPrice), stopPrice: body.stopPrice === null ? null : Number(body.stopPrice) });
        if (!replacement.success) return json({ error: "Valid whole-share quantity and required prices are required" }, 400);
        const order = await alpaca.trading.orders.getOrderByOrderID({ orderId: replacementPreviewMatch[1]!, nested: true });
        let preview;
        try { preview = buildReplacementPreview(order, replacement.data, Date.now() + 120_000); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid replacement", 422); }
        store.event("order.replace.preview", actor, { orderId: order.id, symbol: order.symbol, original: preview.original, replacement: preview.replacement });
        return json({ preview, previewToken: signReplacementPreview(preview, previewSecret) });
      }
      const replaceOrderMatch = request.method === "PATCH" && url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/i);
      if (replaceOrderMatch) {
        if (!allow(`${actor}:order-replace`, 20)) return json({ error: "Order replacement rate limit exceeded" }, 429);
        const { previewToken, idempotencyKey } = await requestJson(request);
        if (typeof previewToken !== "string" || typeof idempotencyKey !== "string" || !/^[\w-]{8,100}$/.test(idempotencyKey)) return json({ error: "Valid replacement preview and idempotency key are required" }, 400);
        const previous = store.submission(idempotencyKey); if (previous) return previous.pending ? json({ error: "Replacement is already processing" }, 409) : json(previous);
        let preview;
        try { preview = verifyReplacementPreview(previewToken, previewSecret); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid replacement preview", 400); }
        if (preview.orderId !== replaceOrderMatch[1]) return json({ error: "Replacement preview does not match this order" }, 400);
        if (!store.reserveSubmission(idempotencyKey)) return json({ error: "Replacement is already processing" }, 409);
        try {
          const order = await alpaca.trading.orders.getOrderByOrderID({ orderId: preview.orderId, nested: true });
          if ((order.updatedAt?.toISOString() ?? null) !== preview.expectedUpdatedAt) throw new ClientError("The order changed after preview. Refresh and review the replacement again.", 409);
          buildReplacementPreview(order, preview.replacement, preview.expiresAt);
          let replaced;
          try {
            replaced = await alpaca.trading.orders.patchOrderByOrderId({ orderId: preview.orderId, patchOrderRequest: { qty: String(preview.replacement.qty), limitPrice: preview.replacement.limitPrice === null ? undefined : String(preview.replacement.limitPrice), stopPrice: preview.replacement.stopPrice === null ? undefined : String(preview.replacement.stopPrice), clientOrderId: idempotencyKey } });
          } catch (replacementError) {
            try { replaced = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId: idempotencyKey }); }
            catch { throw replacementError; }
          }
          if (!replaced.id) throw new Error("Alpaca returned a replacement without an id");
          orderTracker.update(replaced); reconcileOrder(replaced);
          const response = { ...managedOrderDto(replaced), replacedOrderId: preview.orderId };
          store.completeSubmission(idempotencyKey, replaced.id, response);
          store.event("order.replace.submitted", actor, { orderId: preview.orderId, replacementOrderId: replaced.id, symbol: preview.symbol, replacement: preview.replacement });
          return json(response);
        } catch (error) {
          store.releaseSubmission(idempotencyKey);
          if (error instanceof ClientError) throw error;
          throw new ClientError("Alpaca could not replace the order because its state changed. Refresh the blotter.", 409);
        }
      }
      if (url.pathname === "/api/options/orders/preview" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const parsed = OptionOrderTicket.safeParse(await requestJson(request));
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Invalid option ticket" }, 400);
        const ticket = parsed.data, symbols = ticket.legs.map(leg => leg.symbol);
        const [account, marketData] = await Promise.all([alpaca.trading.account.getAccount(), optionOrderMarketData(symbols)]);
        const requiredLevel = ticket.kind === "vertical" ? 3 : 2;
        if (Number(account.optionsTradingLevel ?? 0) < requiredLevel) return json({ error: `Options trading level ${requiredLevel} is required` }, 400);
        const risk = optionOrderRisk(ticket, marketData.contracts, marketData.snapshots);
        const equity = Number(account.equity), buyingPower = Number(account.optionsBuyingPower ?? 0), maxOrderRisk = Math.min(2_500, equity * .025);
        if (!Number.isFinite(equity) || !Number.isFinite(buyingPower)) throw new Error("Option risk data is unavailable");
        if (risk.maxLoss > maxOrderRisk || risk.maxLoss > buyingPower) return json({ error: `Maximum option loss exceeds the $${maxOrderRisk.toFixed(2)} order-risk or buying-power limit` }, 422);
        const expiresAt = Date.now() + 120_000;
        const preview = { kind: ticket.kind, legs: risk.legs, qty: ticket.qty, type: ticket.type, limitPrice: ticket.limitPrice, maxLoss: risk.maxLoss, maxProfit: risk.maxProfit, exerciseCost: risk.exerciseCost, assignmentNotional: risk.assignmentNotional, expiresAt };
        store.event("option.order.preview", actor, { preview, referenceDebit: risk.referenceDebit });
        return json({ allowed: true, preview, referenceDebit: risk.referenceDebit, previewToken: signOptionOrderPreview(preview, previewSecret) });
      }
      if (url.pathname === "/api/options/orders" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const { previewToken, idempotencyKey } = await requestJson(request);
        if (typeof previewToken !== "string" || typeof idempotencyKey !== "string" || !/^[\w-]{8,80}$/.test(idempotencyKey)) return json({ error: "Valid option preview token and idempotency key are required" }, 400);
        const previous = store.submission(idempotencyKey);
        if (previous) return previous.pending ? json({ error: "Option order is already processing" }, 409) : json(previous);
        if (!store.reserveSubmission(idempotencyKey)) return json({ error: "Option order is already processing" }, 409);
        let preview, reservation;
        try {
          preview = verifyOptionOrderPreview(previewToken, previewSecret);
          const ticket = OptionOrderTicket.parse({ kind: preview.kind, legs: preview.legs.map(leg => ({ symbol: leg.symbol, side: leg.side, positionIntent: leg.positionIntent })), qty: preview.qty, type: preview.type, limitPrice: preview.limitPrice });
          const [account, marketData] = await Promise.all([alpaca.trading.account.getAccount(), optionOrderMarketData(ticket.legs.map(leg => leg.symbol))]);
          const requiredLevel = ticket.kind === "vertical" ? 3 : 2;
          if (Number(account.optionsTradingLevel ?? 0) < requiredLevel) throw new ClientError("Options permission changed; review the order again", 409);
          const freshRisk = optionOrderRisk(ticket, marketData.contracts, marketData.snapshots), equity = Number(account.equity), buyingPower = Number(account.optionsBuyingPower ?? 0), maxOrderRisk = Math.min(2_500, equity * .025);
          if (ticket.type === "market" && freshRisk.maxLoss > preview.maxLoss * 1.1) throw new ClientError("Option ask moved more than 10%; review the order again", 409);
          if (freshRisk.maxLoss > maxOrderRisk || freshRisk.maxLoss > buyingPower) throw new ClientError("Option risk or buying power changed; review the order again", 409);
          reservation = store.reserveRisk(idempotencyKey, { symbol: "OPTIONS_RISK", side: "buy", qty: 1, price: freshRisk.maxLoss }, active => {
            const reserved = active.filter(item => item.symbol === "OPTIONS_RISK").reduce((sum, item) => sum + item.qty * item.price, 0);
            const allowed = reserved + freshRisk.maxLoss <= Math.min(buyingPower, equity * .05);
            return { allowed, value: { ...freshRisk, portfolioReservedRisk: reserved + freshRisk.maxLoss } };
          });
          if (!reservation.reserved) {
            store.releaseSubmission(idempotencyKey);
            if (reservation.reason === "risk") return json({ error: "Concurrent option risk exceeds the 5% portfolio cap", risk: reservation.validation }, 422);
            return json({ error: "Option order is already processing" }, 409);
          }
        } catch (error) {
          store.releaseSubmission(idempotencyKey);
          if (error instanceof ClientError) throw error;
          if (error instanceof Error && ["Invalid option preview token", "Option preview expired"].includes(error.message)) throw new ClientError(error.message, 400);
          throw error;
        }
        let order;
        try {
          if (preview.kind === "single") {
            const leg = preview.legs[0]!, common = { symbol: leg.symbol, side: "buy" as const, qty: preview.qty, timeInForce: "day" as const, positionIntent: "buy_to_open" as const, clientOrderId: idempotencyKey };
            order = preview.type === "market" ? await alpaca.trading.orders.market(common) : await alpaca.trading.orders.limit({ ...common, limitPrice: preview.limitPrice! });
          } else {
            order = await alpaca.trading.orders.submit({ type: "limit", orderClass: "mleg", qty: preview.qty, limitPrice: preview.limitPrice!, timeInForce: "day", clientOrderId: idempotencyKey, legs: preview.legs.map(leg => ({ symbol: leg.symbol, side: leg.side, positionIntent: leg.positionIntent, ratioQty: "1" })) });
          }
        } catch (placementError) {
          try { order = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId: idempotencyKey }); }
          catch { store.finishRiskReservation(idempotencyKey, "released"); store.releaseSubmission(idempotencyKey); throw placementError; }
        }
        if (!order.id) { store.finishRiskReservation(idempotencyKey, "released"); store.releaseSubmission(idempotencyKey); throw new Error("Alpaca returned an option order without an id"); }
        store.markRiskSubmitted(idempotencyKey, order.id);
        if (order.status === "filled") store.finishRiskReservation(idempotencyKey, "filled");
        else if (order.status === "rejected") store.finishRiskReservation(idempotencyKey, "rejected");
        orderTracker.update(order);
        const receiptId = crypto.randomUUID(), response = { ...managedOrderDto(order), receiptId };
        store.completeSubmission(idempotencyKey, order.id, response);
        store.receipt(receiptId, { advisor: actor, kind: "option_order", preview: { ...preview, risk: reservation.validation }, idempotencyKey, orderId: order.id, status: order.status, createdAt: new Date().toISOString() });
        store.event("option.order.submitted", actor, { orderId: order.id, receiptId, kind: preview.kind });
        return json(response);
      }
      if (url.pathname === "/api/orders/basket/preview" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const parsedBasket = RebalanceBasket.safeParse(await requestJson(request));
        if (!parsedBasket.success) return json({ error: parsedBasket.error.issues[0]?.message ?? "Invalid rebalance basket" }, 400);
        const basket = parsedBasket.data;
        const [account, positions, recentOrders, clock, marketLegs] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
          getMarketClock(),
          Promise.all(basket.legs.map(async leg => {
            const [asset, price, marketSnapshot] = await Promise.all([
              alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: leg.symbol }),
              alpaca.marketData.getLatestPrice(leg.symbol),
              alpaca.marketData.stocks.stockSnapshotSingle({ symbol: leg.symbol, feed: "iex" }),
            ]);
            return { ...leg, asset, price, marketSnapshot };
          })),
        ]);
        if (account.equity === undefined || account.cash === undefined) throw new Error("Account risk data unavailable");
        if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
        for (const leg of marketLegs) {
          if (!leg.asset.tradable || leg.asset._class !== "us_equity") return json({ error: `${leg.symbol} is not a tradable US stock or ETF` }, 400);
          if (typeof leg.price !== "number" || !Number.isFinite(leg.price) || leg.price <= 0) return json({ error: `No valid current price for ${leg.symbol}` }, 400);
          if (!leg.asset.fractionable && !Number.isInteger(leg.qty)) return json({ error: `${leg.symbol} does not support fractional orders` }, 400);
        }
        const pricedLegs = marketLegs.map(({ symbol, side, qty, price }) => ({ symbol, side, qty, price: price as number }));
        const brokerPending = await pendingBrokerOrders(recentOrders, new Map(pricedLegs.map(leg => [leg.symbol, leg.price])));
        const simulation = simulateRebalanceBasket({ snapshot: riskSnapshot(account.equity, account.cash, positions), positions, legs: pricedLegs, dailyTurnover: rollingTurnover(recentOrders), pendingOrders: brokerPending });
        const liquidity = marketLegs.map(leg => ({ symbol: leg.symbol, ...liquidityPreview(leg.marketSnapshot, leg.qty, leg.price as number, "market") }));
        store.event("order.basket.preview", actor, { legs: pricedLegs, simulation, liquidity });
        if (!simulation.allowed) return json({ allowed: false, simulation, liquidity }, 422);
        const expiresAt = Date.now() + 120_000;
        return json({ allowed: true, simulation, liquidity, session: orderSessionGuidance(clock), expiresAt, previewToken: signRebalanceBasketPreview({ legs: pricedLegs, timeInForce: basket.timeInForce, expiresAt }, previewSecret) });
      }
      if (url.pathname === "/api/orders/basket" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const { previewToken, idempotencyKey } = await requestJson(request);
        if (typeof previewToken !== "string" || typeof idempotencyKey !== "string" || !/^[\w-]{8,80}$/.test(idempotencyKey)) return json({ error: "Valid basket preview token and idempotency key are required" }, 400);
        const previous = store.submission(idempotencyKey);
        if (previous) return previous.pending ? json({ error: "Basket submission is already processing" }, 409) : json(previous);
        if (!store.reserveSubmission(idempotencyKey)) return json({ error: "Basket submission is already processing" }, 409);
        let preview;
        let freshLegs: { symbol: string; side: "buy" | "sell"; qty: number; price: number }[] = [];
        let reservationKeys: string[] = [];
        let freshSimulation;
        try {
          preview = verifyRebalanceBasketPreview(previewToken, previewSecret);
          const [account, positions, recentOrders, checkedLegs] = await Promise.all([
            alpaca.trading.account.getAccount(),
            alpaca.trading.positions.getAllOpenPositions(),
            alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
            Promise.all(preview.legs.map(async leg => {
              const [asset, price] = await Promise.all([
                alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: leg.symbol }),
                alpaca.marketData.getLatestPrice(leg.symbol),
              ]);
              if (!asset.tradable || asset._class !== "us_equity") throw new ClientError(`${leg.symbol} is no longer tradable`, 409);
              if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error(`Fresh price unavailable for ${leg.symbol}`);
              if (!asset.fractionable && !Number.isInteger(leg.qty)) throw new ClientError(`${leg.symbol} no longer supports this fractional order`, 409);
              if (Math.abs(price / leg.price - 1) > 0.01) throw new ClientError(`${leg.symbol} moved more than 1%; review the basket again`, 409);
              return { symbol: leg.symbol, side: leg.side, qty: leg.qty, price };
            })),
          ]);
          if (account.equity === undefined || account.cash === undefined) throw new Error("Account risk data unavailable");
          if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
          freshLegs = checkedLegs;
          const brokerPending = await pendingBrokerOrders(recentOrders, new Map(freshLegs.map(leg => [leg.symbol, leg.price])));
          const reservation = store.reserveRiskBasket(idempotencyKey, freshLegs, active => {
            const brokerIds = new Set(brokerPending.map(order => order.orderId));
            const localPending = active.filter(order => !order.orderId || !brokerIds.has(order.orderId));
            const simulation = simulateRebalanceBasket({ snapshot: riskSnapshot(account.equity!, account.cash!, positions), positions, legs: freshLegs, dailyTurnover: rollingTurnover(recentOrders), pendingOrders: [...brokerPending, ...localPending] });
            return { allowed: simulation.allowed, value: simulation };
          });
          if (!reservation.reserved) {
            store.releaseSubmission(idempotencyKey);
            if (reservation.reason === "risk") return json({ allowed: false, simulation: reservation.validation }, 422);
            return json({ error: "Basket submission is already processing" }, 409);
          }
          reservationKeys = reservation.keys;
          freshSimulation = reservation.validation;
        } catch (error) {
          store.releaseSubmission(idempotencyKey);
          if (error instanceof ClientError) throw error;
          if (error instanceof Error && ["Invalid basket preview token", "Basket preview expired"].includes(error.message)) throw new ClientError(error.message, 400);
          throw error;
        }
        store.event("order.basket.confirmed", actor, { legs: freshLegs, simulation: freshSimulation, idempotencyKey });
        const results: { symbol: string; side: "buy" | "sell"; qty: number; orderId: string | null; status: string; error?: string }[] = [];
        for (let index = 0; index < freshLegs.length; index++) {
          const leg = freshLegs[index]!, clientOrderId = `${idempotencyKey.slice(0, 40)}-${index}`;
          try {
            let order;
            try { order = await alpaca.trading.orders.market({ symbol: leg.symbol, side: leg.side, qty: leg.qty, timeInForce: preview.timeInForce, clientOrderId }); }
            catch (placementError) {
              try { order = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId }); }
              catch { throw placementError; }
            }
            if (!order.id) throw new Error("Alpaca returned an order without an id");
            store.markRiskSubmitted(reservationKeys[index]!, order.id);
            if (order.status === "filled") store.finishRiskReservation(reservationKeys[index]!, "filled");
            else if (order.status === "rejected") store.finishRiskReservation(reservationKeys[index]!, "rejected");
            orderTracker.update(order);
            results.push({ symbol: leg.symbol, side: leg.side, qty: leg.qty, orderId: order.id, status: String(order.status) });
          } catch (error) {
            store.finishRiskReservation(reservationKeys[index]!, "released");
            results.push({ symbol: leg.symbol, side: leg.side, qty: leg.qty, orderId: null, status: "not_submitted", error: error instanceof Error ? error.message : "Broker submission failed" });
            for (let remaining = index + 1; remaining < reservationKeys.length; remaining++) store.finishRiskReservation(reservationKeys[remaining]!, "released");
            break;
          }
        }
        const receiptId = crypto.randomUUID(), completed = results.length === freshLegs.length && results.every(result => result.orderId);
        const response = { status: completed ? "submitted" : "partial", results, receiptId, warning: "Basket legs are independent broker orders and may fill or fail separately." };
        store.completeSubmission(idempotencyKey, `basket:${receiptId}`, response);
        store.receipt(receiptId, { advisor: actor, kind: "rebalance_basket", preview: { ...preview, legs: freshLegs, simulation: freshSimulation }, idempotencyKey, orderIds: results.flatMap(result => result.orderId ? [result.orderId] : []), status: response.status, results, createdAt: new Date().toISOString() });
        store.event("order.basket.submitted", actor, { receiptId, idempotencyKey, status: response.status, results });
        return json(response, completed ? 200 : 207);
      }
      if (url.pathname === "/api/orders/preview" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const parsedTicket = OrderTicket.safeParse(await requestJson(request));
        if (!parsedTicket.success) return json({ error: parsedTicket.error.issues[0]?.message ?? "Invalid order ticket" }, 400);
        const ticket = parsedTicket.data;
        const { symbol, side, planId } = ticket;
        const auctionError = auctionSubmissionError(ticket.timeInForce);
        if (auctionError) return json({ error: auctionError }, 400);
        if (planId !== undefined && (typeof planId !== "string" || !store.getPlan(planId))) return json({ error: "Valid stored plan id is required" }, 400);
        const [account, positions, asset, price, recentOrders, clock, marketSnapshot] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol }),
          alpaca.marketData.getLatestPrice(symbol),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
          getMarketClock(),
          alpaca.marketData.stocks.stockSnapshotSingle({ symbol, feed: "iex" }),
        ]);
        if (!asset.tradable || asset._class !== "us_equity") return json({ error: "Only tradable US stocks and ETFs are supported" }, 400);
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return json({ error: "No valid current price" }, 400);
        if (account.equity === undefined || account.cash === undefined) return json({ error: "Account risk data unavailable" }, 502);
        const qty = ticketQuantity(ticket, price);
        if (!asset.fractionable && !Number.isInteger(qty)) return json({ error: "This asset does not support fractional or dollar-notional orders" }, 400);
        const shortError = ticket.allowShort ? shortCapabilityError(account, asset) : null;
        if (shortError) return json({ error: shortError }, 400);
        const linkedError = linkedOrderError(ticket, price);
        if (linkedError) return json({ error: linkedError }, 400);
        const riskPrice = ticketRiskPrice(ticket, price);
        const simulation = simulateTrade({ snapshot: riskSnapshot(account.equity, account.cash, positions), positions, symbol, side, qty, price: riskPrice, dailyTurnover: rollingTurnover(recentOrders), allowShort: ticket.allowShort });
        const liquidity = liquidityPreview(marketSnapshot, qty, price, ticket.type);
        store.event("order.preview", actor, { symbol, side, qty, type: ticket.type, simulation, liquidity });
        if (!simulation.allowed) return json({ allowed: false, simulation, liquidity }, 422);
        const expiresAt = Date.now() + 120_000;
        const preview: Preview = { symbol, side, qty, ...(ticket.notional ? { notional: ticket.notional } : {}), amountType: ticket.amountType, type: ticket.type, orderClass: ticket.orderClass, limitPrice: ticket.limitPrice, stopPrice: ticket.stopPrice, trailPercent: ticket.trailPercent, takeProfitPrice: ticket.takeProfitPrice, stopLossPrice: ticket.stopLossPrice, stopLossLimitPrice: ticket.stopLossLimitPrice, timeInForce: ticket.timeInForce, extendedHours: ticket.extendedHours, allowShort: ticket.allowShort, price, expiresAt, ...(planId ? { planId } : {}), simulation };
        return json({ allowed: true, simulation, liquidity, session: orderSessionGuidance(clock), order: { type: ticket.type, orderClass: ticket.orderClass, amountType: ticket.amountType, qty, notional: ticket.notional ?? null, limitPrice: ticket.limitPrice, stopPrice: ticket.stopPrice, trailPercent: ticket.trailPercent, takeProfitPrice: ticket.takeProfitPrice, stopLossPrice: ticket.stopLossPrice, stopLossLimitPrice: ticket.stopLossLimitPrice, timeInForce: ticket.timeInForce, extendedHours: ticket.extendedHours, allowShort: ticket.allowShort }, expiresAt, previewToken: signPreview(preview, previewSecret) });
      }
      if (url.pathname === "/api/orders" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const { previewToken, idempotencyKey } = await requestJson(request);
        if (typeof previewToken !== "string" || typeof idempotencyKey !== "string" || !/^[\w-]{8,100}$/.test(idempotencyKey)) return json({ error: "Valid preview token and idempotency key are required" }, 400);
        const previous = store.submission(idempotencyKey);
        if (previous) return previous.pending ? json({ error: "Order submission is already processing" }, 409) : json(previous);
        if (!store.reserveSubmission(idempotencyKey)) return json({ error: "Order submission is already processing" }, 409);
        let preview: Preview;
        let freshPrice = 0;
        let freshQty = 0;
        let freshRiskPrice = 0;
        let freshSimulation;
        try {
          const fresh = await verifyPreviewFresh(previewToken, previewSecret, async intent => {
            const auctionError = auctionSubmissionError(intent.timeInForce);
            if (auctionError) throw new ClientError(`${auctionError}; review the order again`, 409);
            const [account, positions, asset, price, recentOrders] = await Promise.all([
              alpaca.trading.account.getAccount(),
              alpaca.trading.positions.getAllOpenPositions(),
              alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: intent.symbol }),
              alpaca.marketData.getLatestPrice(intent.symbol),
              alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
            ]);
            if (!asset.tradable || asset._class !== "us_equity") throw new ClientError("The asset is no longer tradable", 409);
            if (account.equity === undefined || account.cash === undefined || typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error("Fresh trade validation data is unavailable");
            const qty = intent.amountType === "notional" ? intent.notional! / price : intent.qty;
            if (!asset.fractionable && !Number.isInteger(qty)) throw new ClientError("This asset does not support fractional or dollar-notional orders", 409);
            const shortError = intent.allowShort ? shortCapabilityError(account, asset) : null;
            if (shortError) throw new ClientError(`${shortError}; review the order again`, 409);
            if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
            if (Math.abs(price / intent.price - 1) > 0.01) throw new ClientError("The price moved more than 1%; review the order again", 409);
            const linkedError = linkedOrderError(intent, price);
            if (linkedError) throw new ClientError(`${linkedError}; review the linked order again`, 409);
            const brokerPending = await pendingBrokerOrders(recentOrders, new Map([[intent.symbol, price]]));
            return { account, positions, price, qty, riskPrice: ticketRiskPrice(intent, price), recentOrders, brokerPending };
          });
          preview = fresh.preview;
          freshPrice = fresh.validation.price;
          freshQty = fresh.validation.qty;
          freshRiskPrice = fresh.validation.riskPrice;
          const reservation = store.reserveRisk(idempotencyKey, { symbol: preview.symbol, side: preview.side, qty: freshQty, price: freshRiskPrice }, active => {
            const brokerIds = new Set(fresh.validation.brokerPending.map(order => order.orderId));
            const localPending = active.filter(order => !order.orderId || !brokerIds.has(order.orderId));
            const simulation = simulateTrade({
              snapshot: riskSnapshot(Number(fresh.validation.account.equity), Number(fresh.validation.account.cash), fresh.validation.positions),
              positions: fresh.validation.positions,
              symbol: preview.symbol,
              side: preview.side,
              qty: freshQty,
              price: freshRiskPrice,
              dailyTurnover: rollingTurnover(fresh.validation.recentOrders),
              pendingOrders: [...fresh.validation.brokerPending, ...localPending],
              allowShort: preview.allowShort,
            });
            return { allowed: simulation.allowed, value: simulation };
          });
          if (!reservation.reserved) {
            store.releaseSubmission(idempotencyKey);
            if (reservation.reason === "risk") return json({ allowed: false, simulation: reservation.validation }, 422);
            return json({ error: "Order submission is already processing" }, 409);
          }
          freshSimulation = reservation.validation;
        } catch (error) {
          store.releaseSubmission(idempotencyKey);
          if (error instanceof ClientError) throw error;
          if (error instanceof Error && ["Invalid preview token", "Preview expired"].includes(error.message)) throw new ClientError(error.message, 400);
          throw error;
        }
        store.event("order.confirmed", actor, { symbol: preview.symbol, side: preview.side, qty: freshQty, notional: preview.notional, type: preview.type, price: freshPrice, riskPrice: freshRiskPrice, simulation: freshSimulation, idempotencyKey });
        // Alpaca also enforces this key, covering a lost response after acceptance.
        let order;
        try {
          order = await placePreviewedOrder(preview, idempotencyKey);
        } catch (placementError) {
          try { order = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId: idempotencyKey }); }
          catch {
            store.finishRiskReservation(idempotencyKey, "released");
            store.releaseSubmission(idempotencyKey);
            throw placementError;
          }
        }
        if (!order.id) {
          store.finishRiskReservation(idempotencyKey, "released");
          store.releaseSubmission(idempotencyKey);
          throw new Error("Alpaca returned an order without an id");
        }
        if (!store.markRiskSubmitted(idempotencyKey, order.id)) console.error("risk reservation transition failed", { idempotencyKey, orderId: order.id });
        if (order.status === "filled") store.finishRiskReservation(idempotencyKey, "filled");
        else if (order.status === "rejected") store.finishRiskReservation(idempotencyKey, "rejected");
        const receiptId = crypto.randomUUID();
        const response = { ...managedOrderDto(order), receiptId };
        store.completeSubmission(idempotencyKey, order.id, response);
        store.receipt(receiptId, { advisor: actor, plan: preview.planId ? store.getPlan(preview.planId) : null, preview: { ...preview, qty: freshQty, price: freshPrice, simulation: freshSimulation }, idempotencyKey, orderId: order.id, status: order.status, createdAt: new Date().toISOString() });
        store.event("order.submitted", actor, { orderId: order.id, receiptId, idempotencyKey, type: preview.type });
        return json(response);
      }
      if (url.pathname.startsWith("/api/receipts/") && request.method === "GET") {
        const receipt = store.getReceipt(url.pathname.split("/").pop() ?? "");
        return receipt ? json(receipt) : json({ error: "Receipt not found" }, 404);
      }
      if (url.pathname === "/api/receipts" && request.method === "GET") return json(store.receipts());
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof ClientError) return json({ error: error.message }, error.status);
      console.error("request failed", { method: request.method, path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      return json({ error: "The broker service could not complete the request" }, 502);
    }
  },
});

console.log(`AI Broker running at http://localhost:${serverPort}`);
const orderUpdates = alpaca.trading.stream({ reconnect: true, maxReconnectSec: 30 });
orderUpdates.onStateChange(state => orderTracker.setStreamState(state));
orderUpdates.onConnect(() => { orderTracker.setStreamState("authenticated"); orderUpdates.subscribeTradeUpdates(); });
orderUpdates.onDisconnect(() => orderTracker.setStreamState("disconnected"));
orderUpdates.onError(error => { orderTracker.setStreamState("error", error); console.error("order stream error", error); });
orderUpdates.onTradeUpdate(update => {
  orderTracker.update(update.order, update.timestamp ?? new Date()); reconcileOrder(update.order);
  store.event("order.stream.update", "alpaca-stream", { event: update.event, orderId: update.order.id, clientOrderId: update.order.clientOrderId, symbol: update.order.symbol, status: update.order.status, timestamp: update.timestamp });
});
orderUpdates.connect();
stockUpdates.connect();
void recoverOrders().then(() => capturePortfolioSnapshot()).catch(error => console.error("startup recovery failed", error instanceof Error ? error.message : error));
setInterval(() => void recoverOrders().catch(error => console.error("order recovery failed", error instanceof Error ? error.message : error)), 30_000);
setInterval(() => void capturePortfolioSnapshot().catch(error => console.error("portfolio snapshot failed", error instanceof Error ? error.message : error)), 15 * 60_000);
setInterval(() => {
  for (const [id, subscriber] of streamSubscribers) {
    try { subscriber.controller.enqueue(streamEncoder.encode(": heartbeat\n\n")); }
    catch { removeStreamSubscriber(id); }
  }
}, 20_000);
