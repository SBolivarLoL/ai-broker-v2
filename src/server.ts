import { Alpaca, TimeFrame } from "@alpacahq/alpaca-ts-alpha";
import { benchmarkAttribution, diversificationScore, performancePoints, performanceSummary, stressTests, valueAtRisk95 } from "./analytics";
import { advancedPortfolioRisk, positionLiquidity } from "./advanced-risk";
import { riskReservationStatusForBrokerStatus, workingBrokerOrderStatuses } from "./broker-status";
import { companyMarketSnapshot } from "./company-market";
import { Intent, PortfolioQuestion, reviewedPlanAllowsOrder, runPortfolioCopilot, runPortfolioQuestion } from "./copilot";
import { cryptoBarsDto, cryptoSnapshotDto, parseCryptoLookbackDays, parseCryptoSymbols, parseCryptoTimeframe } from "./crypto-strategy-data";
import { buildCryptoOrderPreview, cryptoOrderMarketFromSnapshot, CryptoOrderTicket, signCryptoOrderPreview, verifyCryptoOrderPreview, type CryptoOrderPreview } from "./crypto-order-ticket";
import { buildDataGovernanceReport } from "./data-governance";
import { buildFixedIncomeResearchStatus } from "./fixed-income-research";
import { getFinnhubCompanyEnrichment } from "./finnhub";
import { getGdeltCompanySignals } from "./gdelt";
import { ledgerSummary, normalizeActivity, type LedgerCategory } from "./ledger";
import { getOfficialMacroContext } from "./macro-context";
import { monitoringCorporateActions, monitoringEventClusters, monitoringNews, monitoringSecFilings, type MonitoringWatchlist } from "./market-monitoring";
import { parseStreamSymbols, streamBarDto, streamQuoteDto } from "./market-stream";
import { getStockBarsWithFallback } from "./market-data";
import { calendarDto, discoveryDto, orderSessionGuidance, parseSymbol, parseWatchlistInput, watchlistDto } from "./market-workspace";
import { multiAssetDto } from "./multi-asset";
import { getOpenFigiIdentity } from "./openfigi";
import { buildReplacementPreview, canCancelOrder, managedOrderDto, OrderTracker, ReplacementInput, signCancelAllPreview, signReplacementPreview, verifyCancelAllPreview, verifyReplacementPreview } from "./order-management";
import { auctionSubmissionError, linkedOrderError, liquidityPreview, OrderTicket, ticketQuantity, ticketRiskPrice } from "./order-ticket";
import { signPreview, verifyPreviewFresh, type Preview } from "./orders";
import { OptionChainQuery, optionChainDto, optionPortfolioGreeks } from "./options-workspace";
import { OptionOrderTicket, optionOrderRisk, signOptionOrderPreview, signOptionPositionAction, verifyOptionOrderPreview, verifyOptionPositionAction } from "./option-order";
import { evaluateOperationsPolicy, type OperationsPolicyEvaluation } from "./operations-policy";
import { buildPortfolioSnapshot } from "./portfolio-snapshot";
import { buildPortfolioExposureReport, type ExposureBar } from "./portfolio-exposure";
import { buildPortfolioOptimizerReport, PortfolioOptimizerRequest } from "./portfolio-optimizer";
import { buildPortfolioScenarioReport, CustomPortfolioScenario } from "./portfolio-scenarios";
import { buildClosedBetaEvidenceReport, buildProductionGovernanceReport } from "./production-governance";
import { RebalanceBasket, signRebalanceBasketPreview, simulateRebalanceBasket, verifyRebalanceBasketPreview } from "./rebalance-basket";
import { buildConstrainedRebalancePlan, ConstrainedRebalancePlanRequest } from "./rebalance-planner";
import { historicalRisk, portfolioHistory, riskSnapshot, rollingTurnover, simulateTrade } from "./risk";
import { getCompanySecEvidence, getComparableValuations, getSec8KAlerts, getSecCompanyClassification, getValuationScenarios, runCompanyResearch } from "./research";
import { secUserAgentFromEnv } from "./sec-edgar";
import { authContextFor, authorize, rateLimiter, securityReady, validMutationOrigin, type AuthContext } from "./security";
import { searchAssets, type SearchableAsset } from "./search";
import { decryptSecretValue, encryptSecretValue, SecretName } from "./secret-vault";
import { createStore } from "./store";
import { buildStrategyOrderAttribution } from "./strategy-attribution";
import { buildStrategyAlerts } from "./strategy-alerts";
import { evaluateStrategyPlugin, runBacktest, strategyFunctionFromPlugin, strategyPluginFromId, walkForwardWindows } from "./strategy-backtest";
import { buildStrategyDashboard } from "./strategy-dashboard";
import { buildStrategyExecutionReplay } from "./strategy-execution-replay";
import { draftStrategyPaperOrder, evaluateStrategyPaperRiskPolicy, parseStrategyPaperApproval, strategyPaperState, type StrategyPaperApproval } from "./strategy-paper";
import { buildStrategyPerformance } from "./strategy-performance";
import { buildStrategyExperimentReport } from "./strategy-report";
import { parseStrategyReview, withStrategyReviewConfig } from "./strategy-review";
import { normalizeStrategySchedule, parseStrategyIntervalMinutes, strategyRunIsDue, withNextStrategySchedule } from "./strategy-scheduler";
import { buildStrategyDecisionMetrics, buildStrategyErrorMetric, buildStrategySpan } from "./strategy-observability";
import { appendTradeJournalReview, createTradeJournalEntry, journalCandidateFromReceipt, TradeJournalCreateInput, TradeJournalReviewInput } from "./trade-journal";

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const store = createStore();
process.on("uncaughtException", error => {
  if (error instanceof Error && error.message.startsWith("WebSocket is not open")) {
    console.error("market stream websocket not ready", error.message);
    return;
  }
  throw error;
});
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

function operationalPolicyBlocked(operationalPolicy: OperationsPolicyEvaluation, extra: Record<string, unknown> = {}) {
  return json({ allowed: false, operationalPolicy, reasons: operationalPolicy.reasons, runbook: operationalPolicy.runbook, ...extra }, 422);
}

function authorizeRoute(auth: AuthContext, path: string, method: string) {
  if (path.startsWith("/api/operations/secrets") || path === "/api/operations/backup") return authorize(auth, ["admin"]);
  if (path.startsWith("/api/operations/")) return authorize(auth, method === "GET" ? ["operator", "admin"] : ["admin"]);
  if (method === "GET") return true;
  if (path.startsWith("/api/orders") || path.startsWith("/api/options") || path.startsWith("/api/strategy/crypto/orders") || path.includes("/paper-approval") || path.endsWith("/tick") || path.endsWith("/scheduler/tick")) return authorize(auth, ["trader", "admin"]);
  if (path.startsWith("/api/agent") || path.startsWith("/api/research")) return authorize(auth, ["researcher", "admin"]);
  if (path.startsWith("/api/trade-journal")) return authorize(auth, ["researcher", "trader", "admin"]);
  if (path.startsWith("/api/watchlists") || path.startsWith("/api/strategy")) return authorize(auth, ["operator", "trader", "admin"]);
  return true;
}

function vaultKey() {
  const key = process.env.SECRET_VAULT_KEY ?? "";
  if (key.length < 32) throw new ClientError("Secret vault key is not configured", 503);
  return key;
}

function secretNameInput(value: unknown) {
  try { return SecretName.parse(value); }
  catch { throw new ClientError("Valid secret name is required", 400); }
}

function secIdentityConfigured() {
  try { secUserAgentFromEnv(); return true; }
  catch { return false; }
}
let assetCatalog: { expiresAt: number; assets: SearchableAsset[] } | null = null;
let assetCatalogRequest: Promise<SearchableAsset[]> | null = null;
let activitySync: { expiresAt: number; imported: number; truncated: boolean } | null = null;
let activitySyncRequest: Promise<{ imported: number; truncated: boolean }> | null = null;
const orderTracker = new OrderTracker();
let orderRecoveryRequest: Promise<void> | null = null;
let portfolioCaptureRequest: Promise<ReturnType<typeof buildPortfolioSnapshot>> | null = null;
type CurrentPortfolioExposure = { equity: number; report: ReturnType<typeof buildPortfolioExposureReport> };
let portfolioExposureCache: { key: string; expiresAt: number; value: CurrentPortfolioExposure } | null = null;
const companyMarketCache = new Map<string, { expiresAt: number; value: ReturnType<typeof companyMarketSnapshot> }>();
let marketDiscoveryCache: { expiresAt: number; value: ReturnType<typeof discoveryDto> } | null = null;
let marketClockCache: { expiresAt: number; value: any } | null = null;
let marketCalendarCache: { expiresAt: number; value: ReturnType<typeof calendarDto> } | null = null;
type MarketMonitoringResponse = { news: ReturnType<typeof monitoringNews>; corporateActions: ReturnType<typeof monitoringCorporateActions>; secFilings: ReturnType<typeof monitoringSecFilings>; clusters: ReturnType<typeof monitoringEventClusters>; warnings: string[]; coverage: { symbols: string[]; omittedSymbols: number; secSymbols: string[]; secOmittedSymbols: number }; asOf: string };
const marketMonitoringCache = new Map<string, { expiresAt: number; value: MarketMonitoringResponse }>();
const optionChainCache = new Map<string, { expiresAt: number; value: ReturnType<typeof optionChainDto> }>();
let multiAssetCache: { expiresAt: number; value: ReturnType<typeof multiAssetDto> } | null = null;
const stockUpdates = alpaca.marketData.stockStream({ feed: "iex", reconnect: true, maxReconnectSec: 30 });
const streamEncoder = new TextEncoder();
const streamSubscribers = new Map<number, { symbols: Set<string>; controller: ReadableStreamDefaultController<Uint8Array> }>();
const streamSymbolReferences = new Map<string, number>();
let stockStreamState = "connecting", nextStreamSubscriberId = 1;

async function currentPortfolioExposure(): Promise<CurrentPortfolioExposure> {
  const [account, allPositions] = await Promise.all([alpaca.trading.account.getAccount(), alpaca.trading.positions.getAllOpenPositions()]);
  if (account.equity === undefined || account.cash === undefined) throw new ClientError("Account exposure data unavailable", 502);
  const positions = allPositions.slice(0, 100), key = JSON.stringify([account.equity, account.cash, positions.map(position => [position.symbol, position.assetClass, position.marketValue])]);
  if (portfolioExposureCache?.key === key && portfolioExposureCache.expiresAt > Date.now()) return portfolioExposureCache.value;
  const start = new Date(Date.now() - 150 * 86_400_000), warnings: string[] = [];
  const benchmarkResult = await Promise.allSettled([alpaca.marketData.getStockBarsFor("SPY", { timeframe: TimeFrame.Day, start, feed: "iex" })]);
  const benchmarkBars: ExposureBar[] = benchmarkResult[0]?.status === "fulfilled" ? benchmarkResult[0].value.map(bar => ({ date: new Date(bar.timestamp).toISOString().slice(0, 10), close: Number(bar.close) })) : [];
  if (!benchmarkBars.length) warnings.push("SPY IEX history is unavailable; market-beta exposure remains unavailable.");
  if (allPositions.length > positions.length) warnings.push(`${allPositions.length - positions.length} positions were omitted by the 100-position exposure bound.`);
  const exposurePositions = await Promise.all(positions.map(async position => {
    const assetClass = String(position.assetClass ?? "unknown"), positionWarnings: string[] = [];
    if (assetClass !== "us_equity") return { symbol: position.symbol, marketValue: Number(position.marketValue), assetClass, warnings: positionWarnings };
    const [barsResult, classificationResult] = await Promise.allSettled([
      alpaca.marketData.getStockBarsFor(position.symbol, { timeframe: TimeFrame.Day, start, feed: "iex" }),
      getSecCompanyClassification(position.symbol),
    ]);
    const bars = barsResult.status === "fulfilled" ? barsResult.value.map(bar => ({ date: new Date(bar.timestamp).toISOString().slice(0, 10), close: Number(bar.close) })) : [];
    if (!bars.length) positionWarnings.push(`${position.symbol} IEX history is unavailable; its return-derived factor contribution is omitted.`);
    const official = classificationResult.status === "fulfilled" ? classificationResult.value : null;
    const classification = official?.sic ? { sic: official.sic, industry: official.industry, sourceUrl: official.sourceUrl } : null;
    if (!classification) positionWarnings.push(`${position.symbol} has no usable SEC SIC classification.`);
    return { symbol: position.symbol, marketValue: Number(position.marketValue), assetClass, bars, classification, marketDataSource: bars.length ? "alpaca:iex" : null, warnings: positionWarnings };
  }));
  const equity = Number(account.equity);
  const report = buildPortfolioExposureReport({ equity, cash: Number(account.cash), positions: exposurePositions, benchmarkBars, warnings });
  const value = { equity, report };
  portfolioExposureCache = { key, expiresAt: Date.now() + 5 * 60_000, value };
  return value;
}

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
  if (!symbols.length) return { news: [], corporateActions: [], secFilings: [], clusters: [], warnings: [], coverage: { symbols: [], omittedSymbols: 0, secSymbols: [], secOmittedSymbols: 0 }, asOf: new Date().toISOString() };
  const now = new Date(), start = new Date(now.getTime() - 7 * 86_400_000), end = new Date(now.getTime() + 90 * 86_400_000);
  const secSymbols = symbols.slice(0, 12);
  const [brokerResults, secResults] = await Promise.all([
    Promise.allSettled([
      alpaca.marketData.news.news({ symbols: symbols.join(","), start, sort: "desc", limit: 30, includeContent: false }),
      alpaca.marketData.collectCorporateActions({ symbols, start, end, sort: "asc", limit: 1_000 }),
    ]),
    Promise.allSettled(secSymbols.map(symbol => getSec8KAlerts(symbol, 14, 2))),
  ]);
  const [newsResult, actionsResult] = brokerResults;
  const warnings: string[] = [];
  if (newsResult.status === "rejected") warnings.push("Portfolio and watchlist news is temporarily unavailable.");
  if (actionsResult.status === "rejected") warnings.push("Corporate-action data is temporarily unavailable or not included in this account's data entitlement.");
  if (secResults.some(result => result.status === "rejected")) warnings.push("Official SEC 8-K monitoring is temporarily incomplete for one or more symbols.");
  if (allSymbols.length > symbols.length) warnings.push(`Monitoring is limited to the first ${symbols.length} symbols; ${allSymbols.length - symbols.length} symbols are omitted.`);
  if (symbols.length > secSymbols.length) warnings.push(`SEC 8-K monitoring is limited to the first ${secSymbols.length} portfolio/watchlist symbols; ${symbols.length - secSymbols.length} symbols are omitted.`);
  const news = monitoringNews(newsResult.status === "fulfilled" ? newsResult.value.news : [], positions, watchlists);
  const corporateActions = monitoringCorporateActions(actionsResult.status === "fulfilled" ? actionsResult.value as any : {}, positions, watchlists);
  const secFilings = monitoringSecFilings(secResults.flatMap(result => result.status === "fulfilled" ? result.value.alerts : []), positions, watchlists);
  const value = { news, corporateActions, secFilings, clusters: monitoringEventClusters(news, corporateActions, secFilings), warnings, coverage: { symbols, omittedSymbols: allSymbols.length - symbols.length, secSymbols, secOmittedSymbols: symbols.length - secSymbols.length }, asOf: new Date().toISOString() };
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
  if (order.id && order.status) store.reconcileStrategyOrder(order.id, order.status, { broker: managedOrderDto(order), brokerReconciledAt: new Date().toISOString() });
  if (!order.clientOrderId || !order.status) return;
  const riskStatus = riskReservationStatusForBrokerStatus(order.status);
  if (riskStatus) store.finishRiskReservation(order.clientOrderId, riskStatus);
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

async function pendingBrokerOrders(orders: any[], candidatePrices: Map<string, number>) {
  const working = orders.filter(order => workingBrokerOrderStatuses.has(String(order.status)));
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

function placePreviewedCryptoOrder(preview: CryptoOrderPreview, clientOrderId: string) {
  const common = { symbol: preview.symbol, side: preview.side, timeInForce: preview.timeInForce, clientOrderId };
  if (preview.type === "market") return preview.amountType === "notional"
    ? alpaca.trading.orders.market({ ...common, notional: preview.notional! })
    : alpaca.trading.orders.market({ ...common, qty: preview.estimatedQty });
  if (preview.type === "limit") return alpaca.trading.orders.limit({ ...common, qty: preview.estimatedQty, limitPrice: preview.limitPrice! });
  return alpaca.trading.orders.stopLimit({ ...common, qty: preview.estimatedQty, stopPrice: preview.stopPrice!, limitPrice: preview.limitPrice! });
}

async function optionOrderMarketData(symbols: string[]) {
  const [contracts, snapshots] = await Promise.all([
    Promise.all(symbols.map(symbol => alpaca.trading.assets.getOptionContractSymbolOrId({ symbolOrId: symbol }))),
    alpaca.marketData.options.optionSnapshots({ symbols: symbols.join(",") }),
  ]);
  return { contracts, snapshots: snapshots.snapshots ?? {} };
}

type StrategyRunRecord = NonNullable<ReturnType<typeof store.getStrategyRun>>;
type StrategyTickTrigger = "manual" | "scheduler";
const STRATEGY_IDS = "cash, buy-and-hold, time-sliced-accumulation, moving-average-trend, breakout-momentum, volatility-filter, mean-reversion, btc-eth-relative-strength, or order-book-liquidity-scout";

function normalizeStrategySymbols(strategyId: string, rawSymbols: unknown) {
  const maximum = strategyId === "btc-eth-relative-strength" ? 2 : 1;
  const symbols = parseCryptoSymbols(rawSymbols, maximum);
  if (strategyId !== "btc-eth-relative-strength") return symbols;
  const primary = symbols[0]!;
  if (!["BTC/USD", "ETH/USD"].includes(primary)) throw new Error("BTC/ETH relative strength must start with BTC/USD or ETH/USD");
  const peer = primary === "BTC/USD" ? "ETH/USD" : "BTC/USD";
  return [...new Set([primary, peer])];
}

async function strategyConfigHash(config: unknown) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(config))).then(bytes => `sha256:${[...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`);
}

function strategyAuditSnapshot(run: StrategyRunRecord | null | undefined) {
  return run ? {
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
  } : null;
}

function recordStrategyAudit(actor: string, kind: string, subject: string, beforeRun: StrategyRunRecord | null | undefined, afterRun: StrategyRunRecord | null | undefined, metadata: Record<string, unknown> = {}) {
  const run = afterRun ?? beforeRun;
  if (!run) return;
  try {
    store.strategyAudit({
      runId: run.id,
      kind,
      actor,
      subject,
      strategyId: run.strategyId,
      strategyVersion: run.strategyVersion,
      policyVersion: run.policyVersion,
      configHash: run.configHash,
      before: strategyAuditSnapshot(beforeRun),
      after: strategyAuditSnapshot(afterRun),
      metadata,
    });
  } catch (error) {
    store.event("strategy.audit.persist_failed", "strategy-audit", { runId: run.id, kind, error: error instanceof Error ? error.message : String(error) });
  }
}

async function recordStrategyBlock(run: StrategyRunRecord, actor: string, symbol: string, reasonCode: string, reason: string, trigger: StrategyTickTrigger, mode = run.status, tickStartedAt = Date.now(), traceId = crypto.randomUUID()) {
  const decisionId = crypto.randomUUID(), receiptId = crypto.randomUUID();
  const config = run.config as { params?: Record<string, unknown> };
  store.strategyDecision({
    id: decisionId,
    traceId,
    runId: run.id,
    symbol,
    decision: "block",
    features: {},
    weights: {},
    thresholds: config.params ?? {},
    riskChecks: { allowed: false, mode, trigger, submittedOrder: false, reasons: [reasonCode], intendedAction: "missed" },
    dataSnapshotIds: [],
    rawSignal: null,
    riskAdjustedSignal: null,
    targetPosition: null,
    reason,
  });
  const trace = store.getStrategyDecisionTrace(traceId);
  const asOf = new Date().toISOString();
  recordStrategyMetricRows(buildStrategyDecisionMetrics({ runId: run.id, asOf, tickLatencyMs: Date.now() - tickStartedAt, snapshots: [], decision: "block", submittedOrder: false }));
  recordStrategySpan(actor, { traceId, name: "strategy.decision", startedAt: tickStartedAt, endedAt: Date.now(), attributes: { runId: run.id, symbol, decision: "block", trigger, reasonCode } });
  store.receipt(receiptId, { advisor: actor, kind: mode === "paper" ? "strategy_paper_decision" : "strategy_shadow_decision", runId: run.id, traceId, decisionId, symbol, decision: "block", submittedOrder: false, trigger, createdAt: asOf });
  store.event(`strategy.${mode}.blocked`, actor, { runId: run.id, traceId, decisionId, symbol, trigger, reason: reasonCode });
  return { runId: run.id, traceId, decisionId, receiptId, trace };
}

function cryptoSnapshotQuote(record: { payload: any } | undefined) {
  const bid = Number(record?.payload?.quote?.bid), ask = Number(record?.payload?.quote?.ask);
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const spreadBps = midpoint && ask >= bid ? (ask - bid) / midpoint * 10_000 : null;
  return { bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null, midpoint, spreadBps };
}

function normalizeCryptoPositionSymbol(symbol: string) {
  return symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function cryptoPositionQty(positions: any[], symbol: string) {
  const target = normalizeCryptoPositionSymbol(symbol);
  const position = positions.find(item => normalizeCryptoPositionSymbol(String(item.symbol ?? "")) === target);
  const qty = Number(position?.qty ?? position?.quantity ?? 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

async function latestCryptoOrderMarket(symbol: string) {
  const [snapshots, orderbooks] = await Promise.all([
    alpaca.marketData.crypto.cryptoSnapshots({ loc: "us", symbols: symbol }).then(result => result.snapshots ?? {}),
    alpaca.marketData.crypto.cryptoLatestOrderbooks({ loc: "us", symbols: symbol }).then(result => result.orderbooks ?? {}).catch(() => ({})),
  ]);
  const result = cryptoSnapshotDto({ symbols: [symbol], snapshots, orderbooks, receivedAt: new Date() });
  const record = result.records[0];
  if (!record) throw new Error("Crypto market snapshot unavailable");
  return { record, market: cryptoOrderMarketFromSnapshot(record.payload) };
}

function recordStrategyMetricRows(rows: { runId: string; name: string; value: number; unit: string; asOf: string }[]) {
  for (const row of rows) {
    try { store.strategyMetric(row); }
    catch (error) { store.event("strategy.metric.persist_failed", "strategy-observability", { runId: row.runId, name: row.name, error: error instanceof Error ? error.message : String(error) }); }
  }
}

function recordStrategySpan(actor: string, input: Parameters<typeof buildStrategySpan>[0]) {
  try { store.event("otel.span", actor, buildStrategySpan(input)); }
  catch (error) { console.error("strategy span persist failed", error instanceof Error ? error.message : error); }
}

function paperOrderSlippageBps(order: any, referencePrice: number | null | undefined) {
  const filledAvgPrice = Number(order?.filledAvgPrice ?? order?.filled_avg_price);
  const side = String(order?.side ?? "").toLowerCase();
  if (!referencePrice || !Number.isFinite(referencePrice) || !Number.isFinite(filledAvgPrice) || !["buy", "sell"].includes(side)) return null;
  return side === "buy" ? (filledAvgPrice - referencePrice) / referencePrice * 10_000 : (referencePrice - filledAvgPrice) / referencePrice * 10_000;
}

function recordStrategyOrderMetrics(runId: string, orders: { status: string; payload: any }[], asOf = new Date().toISOString()) {
  if (!orders.length) return;
  const filled = orders.filter(order => String(order.status) === "filled");
  const slippages = filled
    .map(order => {
      const broker = order.payload?.broker ?? {};
      const referencePrice = Number(order.payload?.referencePrice);
      const filledAvgPrice = Number(broker.filledAvgPrice ?? order.payload?.filledAvgPrice);
      const side = String(order.payload?.side ?? broker.side ?? "").toLowerCase();
      if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(filledAvgPrice) || !["buy", "sell"].includes(side)) return null;
      return side === "buy" ? (filledAvgPrice - referencePrice) / referencePrice * 10_000 : (referencePrice - filledAvgPrice) / referencePrice * 10_000;
    })
    .filter((value): value is number => value !== null);
  const rows = [
    { runId, name: "strategy_paper_order_fill_ratio", value: filled.length / orders.length, unit: "ratio", asOf },
    { runId, name: "strategy_paper_order_count", value: orders.length, unit: "count", asOf },
  ];
  if (slippages.length) rows.push({ runId, name: "strategy_slippage_estimate_bps", value: slippages.reduce((sum, value) => sum + value, 0) / slippages.length, unit: "bps", asOf });
  recordStrategyMetricRows(rows);
}

function recordStrategyPerformanceMetrics(runId: string, performance: any) {
  const summary = performance?.summary ?? {};
  if (summary.status !== "available") return;
  const asOf = summary.lastMarkAt ?? performance.generatedAt ?? new Date().toISOString();
  const rows = [
    ["strategy_active_return_percent", summary.totalReturnPercent, "percent"],
    ["strategy_active_drawdown_percent", summary.maxDrawdownPercent, "percent"],
    ["strategy_active_pnl_usd", summary.totalPnl, "usd"],
  ]
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([name, value, unit]) => ({ runId, name: String(name), value: Number(value), unit: String(unit), asOf }));
  recordStrategyMetricRows(rows);
}

async function evaluateStrategyRun(run: StrategyRunRecord, actor: string, trigger: StrategyTickTrigger) {
  const tickStartedAt = Date.now(), traceId = crypto.randomUUID();
  if (!["shadow", "paper"].includes(run.status)) throw new ClientError("Only shadow or approved paper runs can be evaluated by this endpoint", 409);
  const config = run.config as { symbols: string[]; strategyId: string; params?: Record<string, unknown>; timeframe: string; days: number };
  const symbols = config.symbols;
  const symbol = symbols[0]!;
  const end = new Date(), start = new Date(end.getTime() - config.days * 86_400_000);
  const requestedSymbols = symbols.join(",");
  const dataStartedAt = Date.now();
  const [barsBySymbol, snapshotResponse, orderbookResponse] = await Promise.all([
    alpaca.marketData.getCryptoBars({ loc: "us", symbols, timeframe: config.timeframe, start, end, limit: 10_000 } as any),
    alpaca.marketData.crypto.cryptoSnapshots({ loc: "us", symbols: requestedSymbols }).then(result => result.snapshots ?? {}),
    alpaca.marketData.crypto.cryptoLatestOrderbooks({ loc: "us", symbols: requestedSymbols }).then(result => result.orderbooks ?? {}).catch(() => ({})),
  ]);
  recordStrategySpan(actor, { traceId, name: "strategy.market_data.fetch", startedAt: dataStartedAt, endedAt: Date.now(), attributes: { runId: run.id, symbol, symbols, timeframe: config.timeframe, days: config.days } });
  const bars = barsBySymbol[symbol] ?? [];
  if (!bars.length) {
    recordStrategySpan(actor, { traceId, name: "strategy.tick", startedAt: tickStartedAt, endedAt: Date.now(), status: "error", error: "data_unavailable", attributes: { runId: run.id, symbol, mode: run.status, trigger } });
    return recordStrategyBlock(run, actor, symbol, "data_unavailable", "Strategy tick missed because no crypto bars were available.", trigger, run.status, tickStartedAt, traceId);
  }
  const ingestStartedAt = Date.now();
  const snapshotResult = cryptoSnapshotDto({ symbols, snapshots: snapshotResponse, orderbooks: orderbookResponse, receivedAt: new Date() });
  for (const record of snapshotResult.records) store.strategyDataSnapshot({ ...record, runId: run.id });
  recordStrategySpan(actor, { traceId, name: "strategy.market_data.ingest", startedAt: ingestStartedAt, endedAt: Date.now(), attributes: { runId: run.id, symbol, snapshotCount: snapshotResult.records.length, staleSnapshotCount: snapshotResult.records.filter(record => record.stale).length } });
  const featureStartedAt = Date.now();
  const strategy = strategyPluginFromId(config.strategyId, config.params ?? {});
  const decisionOutput = evaluateStrategyPlugin(strategy, bars, bars.length - 1, symbol, { histories: barsBySymbol, snapshots: Object.fromEntries(snapshotResult.records.map(record => [record.symbol, record])) });
  recordStrategySpan(actor, { traceId, name: "strategy.feature_calculation", startedAt: featureStartedAt, endedAt: Date.now(), attributes: { runId: run.id, symbol, strategyId: strategy.id, strategyVersion: strategy.version, bars: bars.length } });
  const riskStartedAt = Date.now();
  const hasStaleData = snapshotResult.records.some(record => record.stale);
  const quote = cryptoSnapshotQuote(snapshotResult.records[0]);
  const referencePrice = quote.midpoint ?? Number(bars.at(-1)?.close);
  const paperApproval = (run.config as { paperApproval?: StrategyPaperApproval }).paperApproval;
  const paperOrders = run.status === "paper" ? store.strategyOrders(run.id) : [];
  const paperState = run.status === "paper" ? strategyPaperState(paperOrders) : { netNotional: 0 };
  const paperDraft = run.status === "paper" && !hasStaleData && paperApproval
    ? draftStrategyPaperOrder({ approval: paperApproval, symbol, targetExposure: decisionOutput.targetExposure, currentNotional: paperState.netNotional, referencePrice, spreadBps: quote.spreadBps })
    : null;
  let paperRiskPolicy: ReturnType<typeof evaluateStrategyPaperRiskPolicy> | null = null, paperOperationsPolicy: OperationsPolicyEvaluation | null = null, paperAccountError: string | null = null;
  if (run.status === "paper" && paperApproval && paperDraft?.allowed && paperDraft.order) {
    let account: any = null, positions: any[] = [], recentOrders: any[] = [];
    try {
      [account, positions, recentOrders] = await Promise.all([
        alpaca.trading.account.getAccount(),
        alpaca.trading.positions.getAllOpenPositions(),
        alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
      ]);
    }
    catch (error) { paperAccountError = error instanceof Error ? error.message : String(error); }
    if (!paperAccountError && recentOrders.length >= 500) paperAccountError = "The complete order window could not be verified";
    const performance = buildStrategyPerformance({ run, orders: paperOrders as any[], barsBySymbol: { [symbol]: bars }, generatedAt: new Date().toISOString() });
    paperRiskPolicy = evaluateStrategyPaperRiskPolicy({
      approval: paperApproval,
      draftOrder: paperDraft.order,
      account,
      orders: paperOrders as any[],
      decisions: store.strategyDecisions(run.id, 50) as any[],
      performance,
    });
    if (paperAccountError) (paperRiskPolicy.evidence as Record<string, unknown>).accountError = paperAccountError;
    if (account && !paperAccountError) {
      paperOperationsPolicy = evaluateOperationsPolicy({
        policy: store.operationsPolicy(),
        order: { assetClass: "strategy_crypto", symbol, side: paperDraft.order.side, notional: paperDraft.order.notional, qty: paperDraft.order.qty, price: referencePrice },
        account,
        positions,
        dailyTurnover: rollingTurnover(recentOrders),
      });
    }
  }
  const intendedAction = run.status === "paper" && paperDraft?.order
    ? paperDraft.order.side === "buy" ? (paperState.netNotional > 0 ? "increase" : "enter") : (decisionOutput.targetExposure <= 0.01 ? "exit" : "reduce")
    : decisionOutput.targetExposure > 0.01 ? "enter" : "hold";
  const blockReasons = hasStaleData
    ? ["stale_data"]
    : run.status === "paper" && !paperApproval
      ? ["approval_missing"]
      : paperDraft && !paperDraft.allowed
        ? paperDraft.reasons
        : paperRiskPolicy && !paperRiskPolicy.allowed
          ? paperRiskPolicy.reasons
          : paperAccountError
            ? ["account_data_unavailable"]
          : paperOperationsPolicy && !paperOperationsPolicy.allowed
            ? paperOperationsPolicy.reasons
          : [];
  const decision = blockReasons.length ? "block" : paperDraft?.order ? intendedAction : intendedAction === "enter" && run.status === "paper" ? "hold" : intendedAction;
  recordStrategySpan(actor, { traceId, name: "strategy.risk_policy", startedAt: riskStartedAt, endedAt: Date.now(), attributes: { runId: run.id, symbol, mode: run.status, allowed: !blockReasons.length, reasons: blockReasons, intendedAction, targetExposure: decisionOutput.targetExposure, spreadBps: quote.spreadBps, paperPolicy: paperRiskPolicy ? { allowed: paperRiskPolicy.allowed, reasons: paperRiskPolicy.reasons } : null, operationalPolicy: paperOperationsPolicy ? { allowed: paperOperationsPolicy.allowed, reasons: paperOperationsPolicy.reasons } : null } });
  const decisionId = crypto.randomUUID(), receiptId = crypto.randomUUID();
  let order: any = null, orderError: string | null = null, clientOrderId: string | null = null;
  if (run.status === "paper" && paperDraft?.allowed && paperDraft.order && (!paperRiskPolicy || paperRiskPolicy.allowed) && (!paperOperationsPolicy || paperOperationsPolicy.allowed)) {
    clientOrderId = crypto.randomUUID();
    const orderStartedAt = Date.now();
    try {
      order = paperDraft.order.side === "buy"
        ? await alpaca.trading.orders.market({ symbol, side: "buy", notional: paperDraft.order.notional, timeInForce: paperDraft.order.timeInForce, clientOrderId })
        : await alpaca.trading.orders.market({ symbol, side: "sell", qty: paperDraft.order.qty, timeInForce: paperDraft.order.timeInForce, clientOrderId });
    } catch (error) {
      orderError = error instanceof Error ? error.message : String(error);
    }
    recordStrategySpan(actor, { traceId, name: "strategy.paper_order.submit", startedAt: orderStartedAt, endedAt: Date.now(), status: orderError ? "error" : "ok", error: orderError, attributes: { runId: run.id, symbol, side: paperDraft.order.side, notional: paperDraft.order.notional, qty: paperDraft.order.qty, timeInForce: paperDraft.order.timeInForce, brokerOrderId: order?.id, brokerStatus: order?.status } });
  }
  const submittedOrder = Boolean(order?.id);
  const finalDecision = orderError ? "block" : decision;
  const finalReasons = orderError ? ["broker_order_rejected"] : blockReasons;
  const targetWithinBand = Boolean(paperDraft && (paperDraft.reasons as string[]).includes("target_within_band"));
  const paperPolicyBlocked = Boolean(paperRiskPolicy && !paperRiskPolicy.allowed);
  const operationalPolicyBlocked = Boolean(paperOperationsPolicy && !paperOperationsPolicy.allowed);
  store.strategyDecision({
    id: decisionId,
    traceId,
    runId: run.id,
    symbol,
    decision: finalDecision,
    features: decisionOutput.features ?? {},
    weights: decisionOutput.weights ?? {},
    thresholds: decisionOutput.thresholds ?? config.params ?? {},
    riskChecks: {
      allowed: finalReasons.length === 0,
      mode: run.status,
      trigger,
      submittedOrder,
      reasons: finalReasons,
      intendedAction,
      paper: run.status === "paper" ? {
        currentNotional: paperState.netNotional,
        spreadBps: quote.spreadBps,
        draftOrder: paperDraft?.order ?? null,
        orderError,
        clientOrderId,
        riskPolicy: paperRiskPolicy ? { allowed: paperRiskPolicy.allowed, reasons: paperRiskPolicy.reasons, evidence: paperRiskPolicy.evidence } : null,
        operationalPolicy: paperOperationsPolicy,
        accountError: paperAccountError,
      } : null,
      strategyPlugin: { id: strategy.id, version: strategy.version, risk: decisionOutput.risk, orders: decisionOutput.orders, attribution: decisionOutput.attribution },
    },
    dataSnapshotIds: snapshotResult.records.map(record => record.id),
    rawSignal: decisionOutput.risk.rawTargetExposure,
    riskAdjustedSignal: finalReasons.length ? 0 : decisionOutput.risk.riskAdjustedSignal,
    targetPosition: finalReasons.length ? 0 : decisionOutput.targetExposure,
    reason: orderError ? `Paper order was blocked by broker response: ${orderError}` : hasStaleData ? `Blocked by stale crypto market data; intended action was ${intendedAction}.` : paperPolicyBlocked ? `Blocked by crypto paper risk policy: ${finalReasons.join(", ")}.` : operationalPolicyBlocked ? `Blocked by global operations policy: ${finalReasons.join(", ")}.` : targetWithinBand ? "Approved paper run is already within the target exposure band." : decisionOutput.reason,
    draftOrder: paperDraft?.order ?? undefined,
    paperOrderId: order?.id ?? null,
  });
  const asOf = new Date().toISOString();
  recordStrategyMetricRows(buildStrategyDecisionMetrics({
    runId: run.id,
    asOf,
    tickLatencyMs: Date.now() - tickStartedAt,
    snapshots: snapshotResult.records,
    decision: finalDecision,
    submittedOrder,
    orderStatus: order?.status ?? null,
    spreadBps: quote.spreadBps,
    slippageBps: paperOrderSlippageBps(order, referencePrice),
  }));
  recordStrategySpan(actor, { traceId, name: "strategy.decision", startedAt: riskStartedAt, endedAt: Date.now(), attributes: { runId: run.id, symbol, decision: finalDecision, intendedAction, submittedOrder, reasonCount: finalReasons.length } });
  if (order?.id && paperDraft?.order) {
    store.strategyOrder({ id: crypto.randomUUID(), runId: run.id, decisionId, paperOrderId: order.id, status: order.status, payload: { ...paperDraft.order, clientOrderId, submittedAt: asOf, broker: managedOrderDto(order), referencePrice } });
    recordStrategyOrderMetrics(run.id, store.strategyOrders(run.id), asOf);
  }
  if (trigger === "scheduler" && normalizeStrategySchedule(run.config)) {
    const nextConfig = withNextStrategySchedule(run.config, new Date());
    const nextConfigHash = await strategyConfigHash(nextConfig);
    const beforeRun = store.getStrategyRun(run.id) ?? run;
    if (store.updateStrategyRunConfig(run.id, nextConfig, nextConfigHash)) recordStrategyAudit(actor, "schedule_advanced", "strategy_schedule", beforeRun, store.getStrategyRun(run.id), { trigger });
  }
  const trace = store.getStrategyDecisionTrace(traceId);
  store.receipt(receiptId, { advisor: actor, kind: run.status === "paper" ? "strategy_paper_decision" : "strategy_shadow_decision", runId: run.id, traceId, decisionId, symbol, decision: finalDecision, submittedOrder, paperOrderId: order?.id ?? null, trigger, createdAt: asOf });
  store.event(`strategy.${run.status}.tick`, actor, { runId: run.id, traceId, decisionId, symbol, decision: finalDecision, intendedAction, submittedOrder, paperOrderId: order?.id ?? null, targetExposure: decisionOutput.targetExposure, trigger });
  recordStrategySpan(actor, { traceId, name: "strategy.tick", startedAt: tickStartedAt, endedAt: Date.now(), attributes: { runId: run.id, symbol, mode: run.status, trigger, decision: finalDecision, submittedOrder } });
  return { runId: run.id, traceId, decisionId, receiptId, trace };
}

async function evaluateDueShadowStrategies(actor: string) {
  const now = new Date(), runs = store.strategyRuns(100);
  const dueRuns = runs.filter(run => strategyRunIsDue(run, now, store.strategyDecisions(run.id, 1)[0]?.createdAt ?? null));
  const results = [];
  for (const run of dueRuns) {
    try { results.push(await evaluateStrategyRun(run, actor, "scheduler")); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const asOf = new Date().toISOString();
      recordStrategyMetricRows([buildStrategyErrorMetric(run.id, asOf)]);
      recordStrategySpan(actor, { traceId: crypto.randomUUID(), name: "strategy.scheduler.evaluate", startedAt: Date.now(), endedAt: Date.now(), status: "error", error: message, attributes: { runId: run.id, strategyId: run.strategyId } });
      store.event("strategy.scheduler.error", actor, { runId: run.id, error: message });
      results.push({ runId: run.id, error: message });
    }
  }
  return { checked: runs.length, due: dueRuns.length, results, asOf: now.toISOString() };
}

async function reconciledStrategyOrders(runId: string) {
  const orders = store.strategyOrders(runId);
  const reconcileStartedAt = Date.now();
  const traceId = crypto.randomUUID();
  await Promise.all(orders.slice(0, 50).map(async order => {
    try {
      const brokerOrder = await alpaca.trading.orders.getOrderByOrderID({ orderId: order.paperOrderId, nested: true });
      if (brokerOrder.id && brokerOrder.status) store.reconcileStrategyOrder(order.paperOrderId, brokerOrder.status, { broker: managedOrderDto(brokerOrder), brokerReconciledAt: new Date().toISOString() });
    } catch (error) {
      recordStrategyMetricRows([buildStrategyErrorMetric(runId, new Date().toISOString())]);
      store.event("strategy.order.reconcile_failed", "strategy-attribution", { runId, paperOrderId: order.paperOrderId, error: error instanceof Error ? error.message : String(error) });
    }
  }));
  const reconciled = store.strategyOrders(runId);
  recordStrategyOrderMetrics(runId, reconciled);
  recordStrategySpan("strategy-reconciler", { traceId, name: "strategy.order.reconcile", startedAt: reconcileStartedAt, endedAt: Date.now(), attributes: { runId, orderCount: orders.length, reconciledCount: reconciled.length } });
  return reconciled;
}

async function buildStrategyAttributionForRun(run: StrategyRunRecord, orders = store.strategyOrders(run.id)) {
  const decisions = store.strategyDecisions(run.id, 500);
  const traces = decisions.map(decision => store.getStrategyDecisionTrace(decision.traceId)).filter(Boolean) as any[];
  const fillTimes = orders
    .map(order => Date.parse(order.payload?.broker?.filledAt ?? order.payload?.filledAt ?? ""))
    .filter(Number.isFinite);
  const symbols = [...new Set([...run.symbols, ...orders.map(order => String(order.payload?.symbol ?? order.payload?.broker?.symbol ?? "")).filter(Boolean)])];
  let barsBySymbol: Record<string, any[]> = {};
  const warnings: string[] = [];
  if (fillTimes.length && symbols.length) {
    const start = new Date(Math.min(...fillTimes) - 60 * 60_000);
    const end = new Date();
    try {
      barsBySymbol = await alpaca.marketData.getCryptoBars({ loc: "us", symbols, timeframe: "1Hour", start, end, limit: 10_000 } as any);
    } catch (error) {
      warnings.push(`Post-fill market bars unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const attribution = buildStrategyOrderAttribution({ run, orders, barsBySymbol });
  const executionReplay = buildStrategyExecutionReplay({ run, orders: orders as any[], traces });
  const replayByPaperOrderId = new Map(executionReplay.orders.map(order => [order.paperOrderId, order]));
  attribution.orders = attribution.orders.map(order => ({ ...order, executionReplay: replayByPaperOrderId.get(order.paperOrderId)?.replay ?? null }));
  (attribution as any).executionReplay = executionReplay;
  attribution.warnings.push(...warnings);
  attribution.warnings.push(...executionReplay.warnings);
  return attribution;
}

async function buildStrategyPerformanceForRun(run: StrategyRunRecord, orders = store.strategyOrders(run.id)) {
  const fillTimes = orders
    .map(order => Date.parse(order.payload?.broker?.filledAt ?? order.payload?.filledAt ?? ""))
    .filter(Number.isFinite);
  const symbols = [...new Set([...run.symbols, ...orders.map(order => String(order.payload?.symbol ?? order.payload?.broker?.symbol ?? "")).filter(Boolean)])];
  let barsBySymbol: Record<string, any[]> = {};
  const warnings: string[] = [];
  if (fillTimes.length && symbols.length) {
    const start = new Date(Math.min(...fillTimes) - 60 * 60_000);
    const end = new Date();
    try {
      barsBySymbol = await alpaca.marketData.getCryptoBars({ loc: "us", symbols, timeframe: "1Hour", start, end, limit: 10_000 } as any);
    } catch (error) {
      warnings.push(`Active-run performance bars unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const performance = buildStrategyPerformance({ run, orders, barsBySymbol });
  performance.warnings.push(...warnings);
  recordStrategyPerformanceMetrics(run.id, performance);
  return performance;
}

async function buildStrategyAlertsForRun(run: StrategyRunRecord) {
  const orders = await reconciledStrategyOrders(run.id);
  const decisions = store.strategyDecisions(run.id, 500);
  const traces = decisions.map(decision => store.getStrategyDecisionTrace(decision.traceId)).filter(Boolean);
  let performance: unknown = null;
  try { performance = await buildStrategyPerformanceForRun(run, orders); }
  catch (error) {
    recordStrategyMetricRows([buildStrategyErrorMetric(run.id, new Date().toISOString())]);
    store.event("strategy.alerts.performance_unavailable", "strategy-alerts", { runId: run.id, error: error instanceof Error ? error.message : String(error) });
  }
  const result = buildStrategyAlerts({
    run,
    decisions: decisions as any[],
    traces: traces as any[],
    orders,
    metrics: store.strategyMetrics(run.id) as any[],
    performance,
  });
  if (result.alerts.length) store.event("strategy.alerts.generated", "strategy-alerts", { runId: run.id, alerts: result.alerts.map(alert => ({ code: alert.code, severity: alert.severity })) });
  return result;
}

let strategySchedulerBusy = false;
async function pollStrategyScheduler() {
  if (strategySchedulerBusy) return;
  strategySchedulerBusy = true;
  try {
    const result = await evaluateDueShadowStrategies("strategy-scheduler");
    if (result.due) console.log(`Strategy scheduler evaluated ${result.due} due shadow run(s)`);
  } catch (error) {
    console.error("strategy scheduler failed", error instanceof Error ? error.message : error);
  } finally {
    strategySchedulerBusy = false;
  }
}

const serverPort = Number(process.env.PORT ?? 3000);
Bun.serve({
  port: serverPort,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !validMutationOrigin(request)) return json({ error: "Invalid request origin" }, 403);
    let actor = "anonymous", auth: AuthContext | null = null;
    if (url.pathname.startsWith("/api/")) {
      try {
        auth = authContextFor(request);
        authorizeRoute(auth, url.pathname, request.method);
        actor = auth.actor;
      } catch (error) {
        return json({ error: error instanceof Error && error.message === "Forbidden" ? "Forbidden" : "Unauthorized" }, error instanceof Error && error.message === "Forbidden" ? 403 : 401);
      }
    }
    try {
      if (url.pathname === "/") return new Response(Bun.file("src/index.html"), { headers: { ...securityHeaders, "cache-control": "no-store" } });
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers: { ...securityHeaders, "cache-control": "public, max-age=86400" } });
      if (url.pathname === "/health") return json({ status: "ok" });
      if (url.pathname === "/ready") {
        if (previewSecret.length < 32 || !securityReady() || !secIdentityConfigured()) return json({ status: "not_ready", error: "Security or external-data identity configuration is incomplete" }, 503);
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
      if (url.pathname === "/api/operations/policy" && request.method === "GET") return json({ policy: store.operationsPolicy(), asOf: new Date().toISOString() });
      if (url.pathname === "/api/operations/policy" && request.method === "POST") {
        if (!allow(`${actor}:operations-policy`, 10)) return json({ error: "Operations policy update rate limit exceeded" }, 429);
        const policy = store.updateOperationsPolicy(actor, await requestJson(request));
        store.event("operations.policy.updated", actor, { policy });
        return json({ policy, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/operations/kill-switch" && request.method === "POST") {
        if (!allow(`${actor}:operations-kill-switch`, 10)) return json({ error: "Operations kill switch rate limit exceeded" }, 429);
        const input = await requestJson(request);
        const active = input.active !== false;
        const reason = String(input.reason ?? "").trim();
        if (active && !reason) return json({ error: "A kill-switch reason is required" }, 400);
        const policy = store.updateOperationsPolicy(actor, {
          globalKillSwitch: active
            ? { active: true, reason, activatedAt: new Date().toISOString(), activatedBy: actor }
            : { active: false, reason, activatedAt: null, activatedBy: actor },
        });
        store.event(active ? "operations.kill_switch.activated" : "operations.kill_switch.cleared", actor, { reason, policy });
        return json({ policy, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/operations/secrets" && request.method === "GET") return json({ secrets: store.encryptedSecretMetadata(), asOf: new Date().toISOString() });
      if (url.pathname === "/api/operations/secrets" && request.method === "POST") {
        if (!allow(`${actor}:operations-secrets`, 10)) return json({ error: "Operations secret update rate limit exceeded" }, 429);
        const input = await requestJson(request);
        const name = secretNameInput(input.name);
        const value = String(input.value ?? "");
        const key = vaultKey();
        const envelope = encryptSecretValue(value, key);
        if (decryptSecretValue(envelope, key) !== value) throw new Error("Encrypted secret self-check failed");
        const secret = store.upsertEncryptedSecret(name, envelope, actor);
        store.event("operations.secret.upserted", actor, { name, algorithm: secret.algorithm, keyDigest: secret.keyDigest, ciphertextBytes: secret.ciphertextBytes });
        return json({ secret, asOf: new Date().toISOString() });
      }
      const secretMatch = url.pathname.match(/^\/api\/operations\/secrets\/([^/]+)$/);
      if (secretMatch && request.method === "GET") {
        const secret = store.encryptedSecret(secretNameInput(decodeURIComponent(secretMatch[1]!)));
        return secret ? json({ secret: store.encryptedSecretMetadata().find(item => item.name === secret.name), asOf: new Date().toISOString() }) : json({ error: "Secret not found" }, 404);
      }
      if (secretMatch && request.method === "DELETE") {
        if (!allow(`${actor}:operations-secrets`, 10)) return json({ error: "Operations secret update rate limit exceeded" }, 429);
        const name = secretNameInput(decodeURIComponent(secretMatch[1]!));
        const deleted = store.deleteEncryptedSecret(name);
        store.event("operations.secret.deleted", actor, { name, deleted });
        return deleted ? json({ deleted: true, name }) : json({ error: "Secret not found" }, 404);
      }
      if (url.pathname === "/api/operations/readiness" && request.method === "GET") {
        const backup = store.databaseBackup().metadata;
        const observability = store.observabilityExport(100);
        return json({
          migrations: store.schemaMigrations(),
          backup,
          observability: {
            generatedAt: observability.generatedAt,
            spanCount: observability.spans.length,
            metricCount: observability.strategyMetrics.length,
            eventCount: observability.recentEvents.length,
            decisionAuditVerification: observability.decisionAuditVerification,
          },
          secrets: { count: store.encryptedSecretMetadata().length },
          externalDataIdentity: { secUserAgentConfigured: secIdentityConfigured() },
          incident: store.incidentPacket(50),
          asOf: new Date().toISOString(),
        });
      }
      if (url.pathname === "/api/operations/backup" && request.method === "POST") {
        if (!allow(`${actor}:operations-backup`, 5)) return json({ error: "Operations backup rate limit exceeded" }, 429);
        store.event("operations.backup.exported", actor, { requestedAt: new Date().toISOString() });
        const backup = store.databaseBackup();
        return new Response(new Blob([new Uint8Array(backup.bytes)]), {
          headers: {
            ...securityHeaders,
            "content-type": "application/vnd.sqlite3",
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="ai-broker-backup-${backup.metadata.createdAt.replace(/[:.]/g, "-")}.sqlite"`,
            "x-backup-sha256": backup.metadata.sha256,
            "x-backup-size-bytes": String(backup.metadata.sizeBytes),
          },
        });
      }
      if (url.pathname === "/api/operations/observability-export" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 500);
        if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) return json({ error: "Observability export limit must be between 1 and 5000" }, 400);
        return json(store.observabilityExport(limit));
      }
      if (url.pathname === "/api/operations/incident-packet" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 200);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) return json({ error: "Incident packet limit must be between 1 and 1000" }, 400);
        return json(store.incidentPacket(limit));
      }
      if (url.pathname === "/api/operations/data-governance" && request.method === "GET") return json(buildDataGovernanceReport());
      if (url.pathname === "/api/operations/production-governance" && request.method === "GET") return json(buildProductionGovernanceReport());
      if (url.pathname === "/api/operations/closed-beta-evidence" && request.method === "GET") {
        const runs = store.strategyRuns(100);
        const strategyRuns = runs.map(run => {
          const config = run.config && typeof run.config === "object" && !Array.isArray(run.config) ? run.config as Record<string, unknown> : {};
          return { id: run.id, status: run.status, config, reviewCount: Array.isArray(config.reviewHistory) ? config.reviewHistory.length : 0 };
        });
        const strategyDecisions = runs.flatMap(run => store.strategyDecisions(run.id, 500).map(decision => ({
          runId: decision.runId,
          decision: decision.decision,
          riskChecks: decision.riskChecks && typeof decision.riskChecks === "object" && !Array.isArray(decision.riskChecks) ? decision.riskChecks as Record<string, unknown> : {},
          paperOrderId: decision.paperOrderId,
          orderOutcome: decision.orderOutcome,
        })));
        const backup = store.databaseBackup().metadata;
        return json(buildClosedBetaEvidenceReport({
          paperClient: true,
          decisionAuditVerification: store.verifyDecisionAuditTrail(),
          receipts: store.receipts(1_000),
          events: store.events(1_000),
          strategyRuns,
          strategyDecisions,
          backupMetadata: { sha256: backup.sha256, sizeBytes: backup.sizeBytes, createdAt: backup.createdAt },
        }));
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
        const ingestStartedAt = Date.now();
        const traceId = crypto.randomUUID();
        const [snapshots, orderbooks] = await Promise.all([
          alpaca.marketData.crypto.cryptoSnapshots({ loc: "us", symbols: requested }).then(result => result.snapshots ?? {}),
          alpaca.marketData.crypto.cryptoLatestOrderbooks({ loc: "us", symbols: requested }).then(result => result.orderbooks ?? {}).catch(() => ({})),
        ]);
        const result = cryptoSnapshotDto({ symbols, snapshots, orderbooks, receivedAt });
        for (const record of result.records) store.strategyDataSnapshot({ ...record, runId });
        recordStrategyMetricRows([
          { runId, name: "strategy_snapshot_ingested_count", value: result.records.length, unit: "count", asOf: result.asOf },
          { runId, name: "strategy_stale_snapshot_count", value: result.records.filter(record => record.stale).length, unit: "count", asOf: result.asOf },
          { runId, name: "strategy_stale_data_rate", value: result.records.length ? result.records.filter(record => record.stale).length / result.records.length : 0, unit: "ratio", asOf: result.asOf },
        ]);
        recordStrategySpan(actor, { traceId, name: "strategy.market_data.ingest", startedAt: ingestStartedAt, endedAt: Date.now(), attributes: { runId, symbols, snapshotCount: result.records.length, staleSnapshotCount: result.records.filter(record => record.stale).length } });
        store.event("strategy.crypto.snapshots.ingested", actor, { runId, symbols, count: result.records.length, stale: result.records.filter(record => record.stale).length });
        return json({ runId, ...result });
      }
      if (url.pathname === "/api/strategy/crypto/order-preview" && request.method === "POST") {
        if (!allow(`${actor}:strategy-crypto-order-preview`, 20)) return json({ error: "Crypto order preview rate limit exceeded" }, 429);
        const parsedTicket = CryptoOrderTicket.safeParse(await requestJson(request));
        if (!parsedTicket.success) return json({ error: parsedTicket.error.issues[0]?.message ?? "Invalid crypto order ticket" }, 400);
        const ticket = parsedTicket.data;
        const [account, positions, recentOrders, latest] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
          latestCryptoOrderMarket(ticket.symbol),
        ]);
        const cash = Number(account.cash);
        if (!Number.isFinite(cash)) return json({ error: "Account cash data unavailable" }, 502);
        if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
        if (latest.record.stale) {
          store.event("strategy.crypto.order.preview", actor, { symbol: ticket.symbol, side: ticket.side, type: ticket.type, allowed: false, reasons: ["stale_data"], market: latest.market });
          return json({ allowed: false, reasons: ["stale_data"], market: latest.market, snapshot: latest.record }, 422);
        }
        const result = buildCryptoOrderPreview({ ticket, market: latest.market, cash, heldQty: cryptoPositionQty(positions, ticket.symbol) });
        const operationalPolicy = result.allowed
          ? evaluateOperationsPolicy({ policy: store.operationsPolicy(), order: { assetClass: "crypto", symbol: ticket.symbol, side: ticket.side, notional: result.preview.estimatedNotional }, account, positions, dailyTurnover: rollingTurnover(recentOrders) })
          : null;
        store.event("strategy.crypto.order.preview", actor, { symbol: ticket.symbol, side: ticket.side, type: ticket.type, allowed: result.allowed && (operationalPolicy?.allowed ?? true), reasons: result.allowed ? operationalPolicy?.reasons ?? [] : result.reasons, operationalPolicy, market: latest.market });
        if (!result.allowed) return json({ allowed: false, reasons: result.reasons, market: result.market, snapshot: latest.record }, 422);
        if (operationalPolicy && !operationalPolicy.allowed) return operationalPolicyBlocked(operationalPolicy, { market: result.market, snapshot: latest.record });
        return json({ allowed: true, preview: result.preview, operationalPolicy, market: result.market, snapshot: latest.record, previewToken: signCryptoOrderPreview(result.preview, previewSecret) });
      }
      if (url.pathname === "/api/strategy/crypto/orders" && request.method === "POST") {
        if (!allow(`${actor}:strategy-crypto-orders`, 10)) return json({ error: "Crypto order submission rate limit exceeded" }, 429);
        const { previewToken, idempotencyKey } = await requestJson(request);
        if (typeof previewToken !== "string" || typeof idempotencyKey !== "string" || !/^[\w-]{8,100}$/.test(idempotencyKey)) return json({ error: "Valid crypto preview token and idempotency key are required" }, 400);
        const previous = store.submission(idempotencyKey);
        if (previous) return previous.pending ? json({ error: "Crypto order submission is already processing" }, 409) : json(previous);
        if (!store.reserveSubmission(idempotencyKey)) return json({ error: "Crypto order submission is already processing" }, 409);
        let preview!: CryptoOrderPreview;
        let freshPreview!: CryptoOrderPreview;
        let freshMarket!: ReturnType<typeof cryptoOrderMarketFromSnapshot>;
        let freshSnapshot!: Awaited<ReturnType<typeof latestCryptoOrderMarket>>["record"];
        let freshOperationalPolicy: OperationsPolicyEvaluation | null = null;
        try {
          preview = verifyCryptoOrderPreview(previewToken, previewSecret);
          const ticket = CryptoOrderTicket.parse({ symbol: preview.symbol, side: preview.side, type: preview.type, amountType: preview.amountType, qty: preview.qty, notional: preview.notional, limitPrice: preview.limitPrice, stopPrice: preview.stopPrice, timeInForce: preview.timeInForce });
          const [account, positions, recentOrders, latest] = await Promise.all([
            alpaca.trading.account.getAccount(),
            alpaca.trading.positions.getAllOpenPositions(),
            alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
            latestCryptoOrderMarket(preview.symbol),
          ]);
          const cash = Number(account.cash);
          if (!Number.isFinite(cash)) throw new Error("Fresh account cash data unavailable");
          if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
          if (latest.record.stale) throw new ClientError("Crypto market data is stale; review the order again", 409);
          const fresh = buildCryptoOrderPreview({ ticket, market: latest.market, cash, heldQty: cryptoPositionQty(positions, preview.symbol), maxOrderNotional: preview.maxOrderNotional });
          if (!fresh.allowed) {
            store.releaseSubmission(idempotencyKey);
            return json({ allowed: false, reasons: fresh.reasons, market: fresh.market, snapshot: latest.record }, 422);
          }
          freshOperationalPolicy = evaluateOperationsPolicy({ policy: store.operationsPolicy(), order: { assetClass: "crypto", symbol: preview.symbol, side: preview.side, notional: fresh.preview.estimatedNotional }, account, positions, dailyTurnover: rollingTurnover(recentOrders) });
          if (!freshOperationalPolicy.allowed) {
            store.releaseSubmission(idempotencyKey);
            return operationalPolicyBlocked(freshOperationalPolicy, { market: fresh.market, snapshot: latest.record });
          }
          if (Math.abs(fresh.preview.referencePrice / preview.referencePrice - 1) > 0.01) throw new ClientError("Crypto reference price moved more than 1%; review the order again", 409);
          freshPreview = fresh.preview;
          freshMarket = fresh.market;
          freshSnapshot = latest.record;
        } catch (error) {
          store.releaseSubmission(idempotencyKey);
          if (error instanceof ClientError) throw error;
          if (error instanceof Error && ["Invalid crypto order preview token", "Crypto order preview expired"].includes(error.message)) throw new ClientError(error.message, 400);
          throw error;
        }
        store.event("strategy.crypto.order.confirmed", actor, { symbol: freshPreview.symbol, side: freshPreview.side, qty: freshPreview.estimatedQty, notional: freshPreview.notional, type: freshPreview.type, estimatedNotional: freshPreview.estimatedNotional, operationalPolicy: freshOperationalPolicy, idempotencyKey });
        let order;
        try {
          order = await placePreviewedCryptoOrder(freshPreview, idempotencyKey);
        } catch (placementError) {
          try { order = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId: idempotencyKey }); }
          catch {
            store.releaseSubmission(idempotencyKey);
            throw placementError;
          }
        }
        if (!order.id) {
          store.releaseSubmission(idempotencyKey);
          throw new Error("Alpaca returned a crypto order without an id");
        }
        const receiptId = crypto.randomUUID();
        const response = { ...managedOrderDto(order), receiptId };
        store.completeSubmission(idempotencyKey, order.id, response);
        store.receipt(receiptId, { advisor: actor, kind: "crypto_order", preview: { ...freshPreview, operationalPolicy: freshOperationalPolicy }, originalPreview: preview, market: freshMarket, snapshotId: freshSnapshot.id, idempotencyKey, orderId: order.id, status: order.status, createdAt: new Date().toISOString() });
        store.event("strategy.crypto.order.submitted", actor, { orderId: order.id, receiptId, idempotencyKey, symbol: freshPreview.symbol, side: freshPreview.side, type: freshPreview.type, status: order.status });
        return json(response);
      }
      if (url.pathname === "/api/strategy/backtests" && request.method === "POST") {
        if (!allow(`${actor}:strategy-backtest`, 20)) return json({ error: "Strategy backtest rate limit exceeded" }, 429);
        const input = await requestJson(request);
        const strategyId = String(input.strategyId ?? "buy-and-hold");
        let symbols: string[], timeframe: string, days: number;
        try {
          symbols = normalizeStrategySymbols(strategyId, input.symbols);
          timeframe = parseCryptoTimeframe(input.timeframe);
          days = parseCryptoLookbackDays(input.days);
        } catch (error) {
          throw new ClientError(error instanceof Error ? error.message : "Invalid backtest input", 400);
        }
        let strategyPlugin;
        try { strategyPlugin = strategyPluginFromId(strategyId, input.params ?? {}); }
        catch { throw new ClientError(`strategyId must be ${STRATEGY_IDS}`, 400); }
        const initialCash = Number(input.initialCash ?? 10_000), feeBps = Number(input.feeBps ?? 0), slippageBps = Number(input.slippageBps ?? 5);
        const end = new Date(), start = new Date(end.getTime() - days * 86_400_000);
        const symbol = symbols[0]!;
        const barsBySymbol = await alpaca.marketData.getCryptoBars({ loc: "us", symbols, timeframe, start, end, limit: 10_000 } as any);
        const bars = barsBySymbol[symbol] ?? [];
        const strategy = strategyFunctionFromPlugin(strategyPlugin, { histories: barsBySymbol }, symbol);
        const result = runBacktest({ strategyId, bars, strategy, initialCash, feeBps, slippageBps });
        const baselines = {
          cash: runBacktest({ strategyId: "cash", bars, strategy: strategyFunctionFromPlugin(strategyPluginFromId("cash"), { histories: barsBySymbol }, symbol), initialCash, feeBps, slippageBps }),
          buyAndHold: runBacktest({ strategyId: "buy-and-hold", bars, strategy: strategyFunctionFromPlugin(strategyPluginFromId("buy-and-hold"), { histories: barsBySymbol }, symbol), initialCash, feeBps, slippageBps }),
        };
        const trainSize = Number(input.trainSize ?? 0), testSize = Number(input.testSize ?? 0);
        const walkForward = trainSize && testSize ? walkForwardWindows(bars, trainSize, testSize).map(window => ({ trainStart: window.trainStart, testStart: window.testStart, trainBars: window.train.length, testBars: window.test.length })) : [];
        store.event("strategy.backtest.completed", actor, { strategyId, symbol, timeframe, days, totalReturnPercent: result.totalReturnPercent, bars: bars.length });
        return json({ source: "Alpaca crypto historical bars", symbol, symbols, timeframe, start: start.toISOString(), end: end.toISOString(), result, baselines, walkForward, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/strategy/runs" && request.method === "GET") return json({ runs: store.strategyRuns(), asOf: new Date().toISOString() });
      if (url.pathname === "/api/strategy/runs" && request.method === "POST") {
        if (!allow(`${actor}:strategy-runs`, 10)) return json({ error: "Strategy run rate limit exceeded" }, 429);
        const input = await requestJson(request);
        const strategyId = String(input.strategyId ?? "");
        let symbols: string[];
        try { symbols = normalizeStrategySymbols(strategyId, input.symbols); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid crypto symbols", 400); }
        try { strategyPluginFromId(strategyId, input.params ?? {}); }
        catch { throw new ClientError("Unsupported strategyId for shadow run", 400); }
        let intervalMinutes: number | null;
        try { intervalMinutes = parseStrategyIntervalMinutes(input.intervalMinutes ?? input.schedule?.intervalMinutes); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid strategy schedule", 400); }
        const runId = crypto.randomUUID();
        const schedule = intervalMinutes ? { enabled: true, intervalMinutes, nextRunAt: new Date().toISOString() } : undefined;
        const config = { symbols, strategyId, params: input.params ?? {}, timeframe: parseCryptoTimeframe(input.timeframe), days: parseCryptoLookbackDays(input.days), mode: "shadow", ...(schedule ? { schedule } : {}) };
        const configHash = await strategyConfigHash(config);
        store.createStrategyRun({ id: runId, strategyId, strategyVersion: "backtest-v1", status: "shadow", configHash, policyVersion: "crypto-shadow-v1", symbols, budget: 0, config, notes: String(input.notes ?? "") || null });
        recordStrategyAudit(actor, "run_created", "strategy_run", null, store.getStrategyRun(runId), { mode: "shadow", intervalMinutes, pluginVersion: strategyPluginFromId(strategyId, input.params ?? {}).version });
        store.event("strategy.run.created", actor, { runId, strategyId, symbols, mode: "shadow", intervalMinutes });
        return json({ runId, ...store.getStrategyRun(runId) }, 201);
      }
      if (url.pathname === "/api/strategy/scheduler/tick" && request.method === "POST") {
        if (!allow(`${actor}:strategy-scheduler`, 10)) return json({ error: "Strategy scheduler rate limit exceeded" }, 429);
        return json(await evaluateDueShadowStrategies(actor));
      }
      const strategyPaperApprovalMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/paper-approval$/);
      if (strategyPaperApprovalMatch && request.method === "POST") {
        if (!allow(`${actor}:strategy-paper-approval`, 5)) return json({ error: "Strategy paper approval rate limit exceeded" }, 429);
        const runId = decodeURIComponent(strategyPaperApprovalMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        if (!["shadow", "paused"].includes(run.status)) return json({ error: "Only shadow or paused runs can be approved for paper automation" }, 409);
        const input = await requestJson(request);
        let approval: StrategyPaperApproval;
        try { approval = parseStrategyPaperApproval(input, actor); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid paper approval", 400); }
        const config = { ...(run.config as Record<string, unknown>), mode: "paper", paperApproval: approval };
        const configHash = await strategyConfigHash(config);
        if (!store.approveStrategyRunPaper(runId, approval.budget, config, configHash)) return json({ error: "Strategy run could not be approved" }, 409);
        recordStrategyAudit(actor, "paper_approved", "paper_approval", run, store.getStrategyRun(runId), { expiresAt: approval.expiresAt, budget: approval.budget, riskPolicy: approval.riskPolicy });
        store.strategyNote(runId, actor, `Approved paper automation until ${approval.expiresAt} with budget ${approval.budget}.`);
        store.event("strategy.paper.approved", actor, { runId, approval: { ...approval, approvedBy: actor } });
        return json({ runId, ...store.getStrategyRun(runId) });
      }
      const strategyPauseMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/pause$/);
      if (strategyPauseMatch && request.method === "POST") {
        const runId = decodeURIComponent(strategyPauseMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        const input = await requestJson(request).catch(() => ({}));
        const reason = String(input.reason ?? "Paused from Strategy Lab").slice(0, 200);
        store.updateStrategyRunStatus(runId, "paused", reason);
        recordStrategyAudit(actor, "status_changed", "strategy_status", run, store.getStrategyRun(runId), { reason, status: "paused" });
        store.strategyNote(runId, actor, reason);
        store.event("strategy.run.paused", actor, { runId, reason });
        return json({ runId, ...store.getStrategyRun(runId) });
      }
      const strategyKillMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/kill$/);
      if (strategyKillMatch && request.method === "POST") {
        const runId = decodeURIComponent(strategyKillMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        const input = await requestJson(request).catch(() => ({}));
        const reason = String(input.reason ?? "Kill switch activated from Strategy Lab").slice(0, 200);
        const config = { ...(run.config as Record<string, unknown>), paperApproval: { ...((run.config as { paperApproval?: Record<string, unknown> }).paperApproval ?? {}), killSwitch: { activatedAt: new Date().toISOString(), reason } } };
        store.updateStrategyRunConfig(runId, config, await strategyConfigHash(config));
        store.updateStrategyRunStatus(runId, "retired", reason);
        recordStrategyAudit(actor, "kill_switch", "strategy_config", run, store.getStrategyRun(runId), { reason, status: "retired" });
        store.strategyNote(runId, actor, reason);
        store.event("strategy.run.kill_switch", actor, { runId, reason });
        return json({ runId, ...store.getStrategyRun(runId) });
      }
      const strategyReviewMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/review$/);
      if (strategyReviewMatch && request.method === "POST") {
        if (!allow(`${actor}:strategy-review`, 10)) return json({ error: "Strategy review rate limit exceeded" }, 429);
        const runId = decodeURIComponent(strategyReviewMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        const input = await requestJson(request);
        let parsed: ReturnType<typeof parseStrategyReview>;
        try { parsed = parseStrategyReview(input, actor, run.status); }
        catch (error) { throw new ClientError(error instanceof Error ? error.message : "Invalid strategy review", 400); }
        let config = withStrategyReviewConfig(run.config, parsed.review);
        if (parsed.action === "retire") {
          const approval = config.paperApproval && typeof config.paperApproval === "object" && !Array.isArray(config.paperApproval) ? config.paperApproval : {};
          config = { ...config, paperApproval: { ...approval, killSwitch: { activatedAt: parsed.review.reviewedAt, reason: parsed.note } } };
        }
        store.updateStrategyRunConfig(runId, config, await strategyConfigHash(config));
        store.updateStrategyRunStatus(runId, parsed.status, `${parsed.action}: ${parsed.note}`);
        recordStrategyAudit(actor, "reviewed", "strategy_review", run, store.getStrategyRun(runId), { action: parsed.action, status: parsed.status, note: parsed.note });
        store.strategyNote(runId, actor, `${parsed.action.toUpperCase()}: ${parsed.note}`);
        store.event("strategy.run.reviewed", actor, { runId, action: parsed.action, status: parsed.status });
        return json({ runId, ...store.getStrategyRun(runId) });
      }
      const strategyReportMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/report$/);
      if (strategyReportMatch && request.method === "GET") {
        const runId = decodeURIComponent(strategyReportMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        const orders = await reconciledStrategyOrders(runId);
        const decisions = store.strategyDecisions(runId, 500);
        const traces = decisions.map(decision => store.getStrategyDecisionTrace(decision.traceId)).filter(Boolean);
        const attribution = await buildStrategyAttributionForRun(run, orders);
        const performance = await buildStrategyPerformanceForRun(run, orders);
        const report = buildStrategyExperimentReport({
          run,
          decisions,
          traces: traces as any[],
          orders,
          metrics: store.strategyMetrics(runId) as any[],
          notes: store.strategyNotes(runId) as any[],
          attribution,
          performance,
          executionReplay: (attribution as any).executionReplay,
          auditTrail: store.strategyAuditTrail(runId),
          auditVerification: store.verifyStrategyAuditTrail(runId),
        });
        return json(report);
      }
      const strategyAuditMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/audit$/);
      if (strategyAuditMatch && request.method === "GET") {
        const runId = decodeURIComponent(strategyAuditMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        return json({ runId, auditTrail: store.strategyAuditTrail(runId), verification: store.verifyStrategyAuditTrail(runId), asOf: new Date().toISOString() });
      }
      const strategyDashboardMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/dashboard$/);
      if (strategyDashboardMatch && request.method === "GET") {
        const runId = decodeURIComponent(strategyDashboardMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        const orders = await reconciledStrategyOrders(runId);
        const decisions = store.strategyDecisions(runId, 500);
        const traces = decisions.map(decision => store.getStrategyDecisionTrace(decision.traceId)).filter(Boolean);
        return json(buildStrategyDashboard({
          run,
          decisions,
          traces: traces as any[],
          orders,
        }));
      }
      const strategyAttributionMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/attribution$/);
      if (strategyAttributionMatch && request.method === "GET") {
        const runId = decodeURIComponent(strategyAttributionMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        return json(await buildStrategyAttributionForRun(run, await reconciledStrategyOrders(runId)));
      }
      const strategyPerformanceMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/performance$/);
      if (strategyPerformanceMatch && request.method === "GET") {
        const runId = decodeURIComponent(strategyPerformanceMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        return json(await buildStrategyPerformanceForRun(run, await reconciledStrategyOrders(runId)));
      }
      const strategyAlertsMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/alerts$/);
      if (strategyAlertsMatch && request.method === "GET") {
        const runId = decodeURIComponent(strategyAlertsMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        return json(await buildStrategyAlertsForRun(run));
      }
      const strategyRunDecisionMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/decisions$/);
      if (strategyRunDecisionMatch && request.method === "GET") {
        const runId = decodeURIComponent(strategyRunDecisionMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const decision = url.searchParams.get("decision") as any;
        const filters = {
          symbol: url.searchParams.get("symbol"),
          decision: decision || null,
          strategyVersion: url.searchParams.get("strategyVersion"),
          blockReason: url.searchParams.get("blockReason"),
          orderOutcome: url.searchParams.get("orderOutcome"),
        };
        return json({ runId, filters, decisions: store.strategyDecisions(runId, limit, filters), asOf: new Date().toISOString() });
      }
      const strategyRunTickMatch = url.pathname.match(/^\/api\/strategy\/runs\/([^/]+)\/tick$/);
      if (strategyRunTickMatch && request.method === "POST") {
        if (!allow(`${actor}:strategy-tick`, 30)) return json({ error: "Strategy tick rate limit exceeded" }, 429);
        const runId = decodeURIComponent(strategyRunTickMatch[1]!);
        const run = store.getStrategyRun(runId);
        if (!run) return json({ error: "Strategy run not found" }, 404);
        return json(await evaluateStrategyRun(run, actor, "manual"));
      }
      const strategyTraceMatch = url.pathname.match(/^\/api\/strategy\/decision-traces\/([^/]+)$/);
      if (strategyTraceMatch && request.method === "GET") {
        const trace = store.getStrategyDecisionTrace(decodeURIComponent(strategyTraceMatch[1]!));
        return trace ? json(trace) : json({ error: "Strategy decision trace not found" }, 404);
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
      if (url.pathname === "/api/portfolio/exposure" && request.method === "GET") {
        return json((await currentPortfolioExposure()).report);
      }
      if (url.pathname === "/api/portfolio/optimizer" && request.method === "GET") {
        const parsed = PortfolioOptimizerRequest.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Invalid optimizer request" }, 400);
        const optimizerRequest = parsed.data;
        const [account, positions] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
        ]);
        if (account.equity === undefined) throw new Error("Account optimizer data unavailable");
        const equityPositions = positions.filter(position => position.assetClass === "us_equity" && Number(position.qty) > 0 && Number(position.marketValue) > 0).slice(0, 50);
        const start = new Date(Date.now() - Math.max(90, optimizerRequest.minObservations * 3) * 86_400_000);
        const positionData = await Promise.all(equityPositions.map(async position => {
          const bars = await alpaca.marketData.getStockBarsFor(position.symbol, { timeframe: TimeFrame.Day, start, feed: "iex" });
          return { symbol: position.symbol, marketValue: Number(position.marketValue), closes: bars.map(bar => Number(bar.close)).filter(value => Number.isFinite(value) && value > 0) };
        }));
        const report = buildPortfolioOptimizerReport({ equity: Number(account.equity), positions: positionData, request: optimizerRequest, asOf: new Date().toISOString() });
        const omittedNonEquity = positions.length - equityPositions.length;
        const warnings = omittedNonEquity > 0 ? [...report.warnings, `${omittedNonEquity} non-long-US-equity or non-positive position${omittedNonEquity === 1 ? " was" : "s were"} omitted from optimizer proposals.`] : report.warnings;
        store.event("portfolio.optimizer.generated", actor, { proposals: report.proposals.map(proposal => proposal.id), constraints: report.constraints, optimizedSymbols: report.coverage.optimizedSymbols });
        return json({ ...report, warnings });
      }
      if (url.pathname === "/api/portfolio/scenarios" && (request.method === "GET" || request.method === "POST")) {
        let custom;
        if (request.method === "POST") {
          if (!allow(`${actor}:portfolio-scenarios`, 30)) return json({ error: "Portfolio scenario rate limit exceeded" }, 429);
          const input = await requestJson(request);
          const parsed = CustomPortfolioScenario.safeParse(typeof input === "object" && input !== null ? (input as { custom?: unknown }).custom : undefined);
          if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Invalid custom scenario" }, 400);
          custom = parsed.data;
        }
        const exposure = await currentPortfolioExposure();
        return json(buildPortfolioScenarioReport({
          equity: exposure.equity,
          asOf: exposure.report.asOf,
          custom,
          positions: exposure.report.positions.map(position => ({ symbol: position.symbol, marketValue: position.marketValue, assetClass: position.assetClass, sector: position.sector, sic: position.sic, volatility20dPercent: position.factors.volatility20dPercent })),
        }));
      }
      if (url.pathname === "/api/portfolio/rebalance-plan" && request.method === "POST") {
        if (!allow(`${actor}:portfolio-rebalance-plan`, 20)) return json({ error: "Rebalance planner rate limit exceeded" }, 429);
        const parsed = ConstrainedRebalancePlanRequest.safeParse(await requestJson(request));
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Invalid rebalance plan request" }, 400);
        const plannerRequest = parsed.data;
        const targetSymbols = [...new Set(plannerRequest.targets.map(target => target.symbol))];
        const [sync, account, positions, recentOrders, marketRows] = await Promise.all([
          syncAccountActivities(),
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
          Promise.all(targetSymbols.map(async symbol => {
            const [asset, price] = await Promise.all([
              alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol }),
              alpaca.marketData.getLatestPrice(symbol),
            ]);
            return { symbol, asset, price };
          })),
        ]);
        if (account.equity === undefined || account.cash === undefined) throw new Error("Account risk data unavailable");
        if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
        const short = positions.find(position => Number(position.qty) < -1e-8 || Number(position.marketValue) < -1e-8);
        if (short) return json({ error: `Current short positions are not supported by this planner (${short.symbol})` }, 400);
        for (const row of marketRows) {
          if (!row.asset.tradable || row.asset._class !== "us_equity") return json({ error: `${row.symbol} is not a tradable US stock or ETF` }, 400);
          if (typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0) return json({ error: `No valid current price for ${row.symbol}` }, 400);
        }
        const market = marketRows.map(row => ({ symbol: row.symbol, price: row.price as number, fractionable: Boolean(row.asset.fractionable) }));
        const marketBySymbol = new Map(market.map(row => [row.symbol, row]));
        const ledger = ledgerSummary(store.activities(5_000), sync.truncated);
        const taxLotsComplete = !ledger.activityHistoryTruncated && ledger.unmatchedSellQuantity <= 1e-8 && ledger.unresolvedCorporateActions.length === 0;
        const plan = buildConstrainedRebalancePlan({
          request: plannerRequest,
          account: { equity: Number(account.equity), cash: Number(account.cash) },
          positions: positions.map(position => {
            const symbol = String(position.symbol).toUpperCase();
            const currentPrice = Number(position.currentPrice);
            return { symbol, qty: Number(position.qty), marketValue: Number(position.marketValue), price: Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : undefined, fractionable: marketBySymbol.get(symbol)?.fractionable };
          }),
          market,
          openLots: ledger.openLots,
          taxLotsComplete,
          taxEvidenceWarnings: ledger.warnings,
          currentTurnoverNotional: rollingTurnover(recentOrders),
          policyMaxTurnoverPercent: store.operationsPolicy().maxDailyTurnoverPercent,
          asOf: new Date().toISOString(),
        });
        store.event("portfolio.rebalance_plan.created", actor, { targets: plannerRequest.targets, withinConstraints: plan.withinConstraints, legs: plan.legs, bindingConstraints: plan.bindingConstraints, taxEvidenceStatus: plan.tax.evidenceStatus });
        return json(plan);
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
        const benchmarkData = points.length
          ? await getStockBarsWithFallback(alpaca.marketData, benchmarkSymbol, { timeframe: TimeFrame.Day, start: new Date(points[0].timestamp - 3 * 86_400_000), end: new Date(points.at(-1)!.timestamp + 2 * 86_400_000) })
          : { bars: [], source: null };
        const benchmarkBars = benchmarkData.bars;
        const benchmark = benchmarkAttribution(points, benchmarkBars, benchmarkSymbol);
        const attribution = positions.map(position => ({ symbol: position.symbol, marketValue: Number(position.marketValue), unrealizedProfitLoss: Number(position.unrealizedPl), unrealizedReturnPercent: Number(position.unrealizedPlpc) * 100 }))
          .filter(item => Object.values(item).every(value => typeof value === "string" || Number.isFinite(value)))
          .sort((a, b) => b.unrealizedProfitLoss - a.unrealizedProfitLoss);
        return json({ period, summary: performanceSummary(points), benchmark: { ...benchmark, source: benchmarkData.source }, points, attribution, quality: { cashflowAdjusted: true, benchmarkCoverage: benchmark.quality, benchmarkSource: benchmarkData.source }, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/agent/plans" && request.method === "POST") {
        if (!allow(`${actor}:agent`, 10)) return json({ error: "Agent rate limit exceeded" }, 429);
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable the agent" }, 503);
        const parsed = Intent.safeParse((await requestJson(request)).intent);
        if (!parsed.success) return json({ error: "Intent must be reduce_concentration, balanced_growth, or preserve_capital" }, 400);
        const planId = crypto.randomUUID();
        const output = await runPortfolioCopilot(alpaca, parsed.data);
        store.plan(planId, parsed.data, output, actor);
        const auditHash = store.decisionAuditTrail(planId).at(-1)?.entryHash ?? null;
        store.event("agent.plan.created", actor, { planId, intent: parsed.data, ideas: output.ideas.length, actionableIdeas: output.ideas.filter(idea => idea.actionable).length, auditHash });
        return json({ planId, intent: parsed.data, auditHash, ...output });
      }
      if (url.pathname === "/api/agent/questions" && request.method === "POST") {
        if (!allow(`${actor}:portfolio-question`, 20)) return json({ error: "Portfolio Q&A rate limit exceeded" }, 429);
        if (!process.env.OPENAI_API_KEY) return json({ error: "Add OPENAI_API_KEY to .env to enable portfolio Q&A" }, 503);
        const parsed = PortfolioQuestion.safeParse((await requestJson(request)).question);
        if (!parsed.success) return json({ error: "Question must be between 3 and 500 characters" }, 400);
        const output = await runPortfolioQuestion(alpaca, parsed.data);
        store.event("agent.portfolio_question.answered", actor, { evidence: [...new Set(output.claims.flatMap(claim => claim.evidence))], claims: output.claims.length });
        return json({ question: parsed.data, ...output, asOf: new Date().toISOString() });
      }
      if (url.pathname.startsWith("/api/agent/plans/") && request.method === "GET") {
        const plan = store.getPlan(url.pathname.split("/").pop() ?? "");
        return plan ? json(plan) : json({ error: "Plan not found" }, 404);
      }
      if (url.pathname === "/api/trade-journal" && request.method === "GET") {
        const entries = store.tradeJournalEntries();
        const journaledReceipts = new Set(entries.map(entry => entry.receiptId));
        const eligibleReceipts = store.receipts(100)
          .map(receipt => journalCandidateFromReceipt(receipt.id, receipt))
          .filter(candidate => candidate !== null && !journaledReceipts.has(candidate.receiptId));
        return json({ entries, eligibleReceipts, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/trade-journal" && request.method === "POST") {
        if (!allow(`${actor}:trade-journal-create`, 30)) return json({ error: "Trade journal rate limit exceeded" }, 429);
        const parsed = TradeJournalCreateInput.safeParse(await requestJson(request));
        if (!parsed.success) return json({ error: "Receipt, thesis, and invalidation are required" }, 400);
        if (store.tradeJournalEntryForReceipt(parsed.data.receiptId)) return json({ error: "This receipt already has a journal entry" }, 409);
        const receipt = store.getReceipt(parsed.data.receiptId);
        if (!receipt) return json({ error: "Receipt not found" }, 404);
        const candidate = journalCandidateFromReceipt(parsed.data.receiptId, receipt);
        if (!candidate) return json({ error: "Only standard stock-order receipts can start a trade journal entry" }, 400);
        const entry = createTradeJournalEntry(candidate, parsed.data, actor);
        store.addTradeJournalEntry(entry, actor);
        store.event("trade_journal.created", actor, { journalId: entry.id, receiptId: entry.receiptId, orderId: entry.orderId, symbol: entry.symbol, side: entry.side });
        return json({ entry }, 201);
      }
      const tradeJournalReviewMatch = url.pathname.match(/^\/api\/trade-journal\/([^/]+)\/reviews$/);
      if (tradeJournalReviewMatch && request.method === "POST") {
        if (!allow(`${actor}:trade-journal-review`, 60)) return json({ error: "Trade journal review rate limit exceeded" }, 429);
        const journalId = decodeURIComponent(tradeJournalReviewMatch[1]!);
        const current = store.getTradeJournalEntry(journalId);
        if (!current) return json({ error: "Trade journal entry not found" }, 404);
        const parsed = TradeJournalReviewInput.safeParse(await requestJson(request));
        if (!parsed.success) return json({ error: "A thesis status and review note are required" }, 400);
        if (current.status === "closed") return json({ error: "Closed journal entries cannot be reviewed again" }, 409);
        const [currentPrice, positions] = await Promise.all([
          alpaca.marketData.getLatestPrice(current.symbol),
          alpaca.trading.positions.getAllOpenPositions(),
        ]);
        if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice) || currentPrice <= 0) return json({ error: "No valid current price is available for this review" }, 502);
        const rawPosition = positions.find(position => position.symbol === current.symbol);
        const numberOrNull = (value: unknown) => { const number = Number(value); return Number.isFinite(number) ? number : null; };
        const position = rawPosition ? {
          qty: numberOrNull(rawPosition.qty),
          averageEntryPrice: numberOrNull(rawPosition.avgEntryPrice),
          currentPrice: numberOrNull(rawPosition.currentPrice),
          marketValue: numberOrNull(rawPosition.marketValue),
          unrealizedProfitLoss: numberOrNull(rawPosition.unrealizedPl),
          unrealizedReturnPercent: numberOrNull(rawPosition.unrealizedPlpc) === null ? null : numberOrNull(rawPosition.unrealizedPlpc)! * 100,
        } : null;
        const receipt = store.getReceipt(current.receiptId);
        const observedAt = new Date().toISOString();
        const entry = appendTradeJournalReview(current, parsed.data, { currentPrice, observedAt, receiptStatus: String(receipt?.status ?? "unknown"), position }, actor, observedAt);
        store.updateTradeJournalEntry(entry, actor);
        store.event("trade_journal.reviewed", actor, { journalId: entry.id, receiptId: entry.receiptId, symbol: entry.symbol, status: entry.status, reviewId: entry.reviews.at(-1)!.id });
        return json({ entry });
      }
      if (url.pathname === "/api/research/sec" && request.method === "GET") {
        if (!allow(`${actor}:sec-research`, 30)) return json({ error: "SEC research rate limit exceeded" }, 429);
        const symbol = String(url.searchParams.get("symbol") ?? "").trim().toUpperCase();
        if (!/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "A valid stock symbol is required" }, 400);
        return json(await getCompanySecEvidence(symbol));
      }
      if (url.pathname === "/api/research/macro" && request.method === "GET") {
        if (!allow(`${actor}:macro-research`, 30)) return json({ error: "Macro research rate limit exceeded" }, 429);
        return json(await getOfficialMacroContext());
      }
      if (url.pathname === "/api/research/fixed-income" && request.method === "GET") return json(buildFixedIncomeResearchStatus());
      if (url.pathname === "/api/research/gdelt" && request.method === "GET") {
        if (!allow(`${actor}:gdelt-research`, 20)) return json({ error: "GDELT research rate limit exceeded" }, 429);
        const symbol = String(url.searchParams.get("symbol") ?? "").trim().toUpperCase();
        if (!/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "A valid stock symbol is required" }, 400);
        const asset = await alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol });
        return json(await getGdeltCompanySignals(symbol, asset.name ?? symbol));
      }
      if (url.pathname === "/api/research/finnhub" && request.method === "GET") {
        if (!allow(`${actor}:finnhub-research`, 30)) return json({ error: "Finnhub research rate limit exceeded" }, 429);
        const symbol = String(url.searchParams.get("symbol") ?? "").trim().toUpperCase();
        if (!/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "A valid stock symbol is required" }, 400);
        return json(await getFinnhubCompanyEnrichment(symbol));
      }
      if (url.pathname === "/api/research/openfigi" && request.method === "GET") {
        if (!allow(`${actor}:openfigi-research`, 30)) return json({ error: "OpenFIGI research rate limit exceeded" }, 429);
        const symbol = String(url.searchParams.get("symbol") ?? "").trim().toUpperCase();
        if (!/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "A valid stock symbol is required" }, 400);
        const asset = await alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol });
        return json(await getOpenFigiIdentity(symbol, asset.name ?? symbol));
      }
      if (url.pathname === "/api/research/comparables" && request.method === "GET") {
        if (!allow(`${actor}:comparable-research`, 12)) return json({ error: "Comparable valuation rate limit exceeded" }, 429);
        const symbol = String(url.searchParams.get("symbol") ?? "");
        const peers = String(url.searchParams.get("peers") ?? "");
        try { return json(await getComparableValuations(alpaca, symbol, peers)); }
        catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid comparable valuation request" }, 400); }
      }
      if (url.pathname === "/api/research/scenarios" && request.method === "POST") {
        if (!allow(`${actor}:scenario-research`, 12)) return json({ error: "Scenario valuation rate limit exceeded" }, 429);
        const input = await requestJson(request);
        try { return json(await getValuationScenarios(alpaca, String(input.symbol ?? ""), input.scenarios)); }
        catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid scenario valuation request" }, 400); }
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
        const [account, positions, recentOrders, marketData] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
          optionOrderMarketData(symbols),
        ]);
        const requiredLevel = ticket.kind === "vertical" ? 3 : 2;
        if (Number(account.optionsTradingLevel ?? 0) < requiredLevel) return json({ error: `Options trading level ${requiredLevel} is required` }, 400);
        const risk = optionOrderRisk(ticket, marketData.contracts, marketData.snapshots);
        const equity = Number(account.equity), buyingPower = Number(account.optionsBuyingPower ?? 0), maxOrderRisk = Math.min(2_500, equity * .025);
        if (!Number.isFinite(equity) || !Number.isFinite(buyingPower)) throw new Error("Option risk data is unavailable");
        if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
        if (risk.maxLoss > maxOrderRisk || risk.maxLoss > buyingPower) return json({ error: `Maximum option loss exceeds the $${maxOrderRisk.toFixed(2)} order-risk or buying-power limit` }, 422);
        const operationalPolicy = evaluateOperationsPolicy({ policy: store.operationsPolicy(), order: { assetClass: "option", symbol: risk.legs[0]?.underlying ?? risk.legs[0]?.symbol ?? "OPTIONS", side: "buy", notional: risk.maxLoss }, account, positions, dailyTurnover: rollingTurnover(recentOrders) });
        if (!operationalPolicy.allowed) return operationalPolicyBlocked(operationalPolicy, { referenceDebit: risk.referenceDebit });
        const expiresAt = Date.now() + 120_000;
        const preview = { kind: ticket.kind, legs: risk.legs, qty: ticket.qty, type: ticket.type, limitPrice: ticket.limitPrice, maxLoss: risk.maxLoss, maxProfit: risk.maxProfit, exerciseCost: risk.exerciseCost, assignmentNotional: risk.assignmentNotional, expiresAt };
        store.event("option.order.preview", actor, { preview, operationalPolicy, referenceDebit: risk.referenceDebit });
        return json({ allowed: true, preview, operationalPolicy, referenceDebit: risk.referenceDebit, previewToken: signOptionOrderPreview(preview, previewSecret) });
      }
      if (url.pathname === "/api/options/orders" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const { previewToken, idempotencyKey } = await requestJson(request);
        if (typeof previewToken !== "string" || typeof idempotencyKey !== "string" || !/^[\w-]{8,80}$/.test(idempotencyKey)) return json({ error: "Valid option preview token and idempotency key are required" }, 400);
        const previous = store.submission(idempotencyKey);
        if (previous) return previous.pending ? json({ error: "Option order is already processing" }, 409) : json(previous);
        if (!store.reserveSubmission(idempotencyKey)) return json({ error: "Option order is already processing" }, 409);
        let preview, reservation, operationalPolicy: OperationsPolicyEvaluation | null = null;
        try {
          preview = verifyOptionOrderPreview(previewToken, previewSecret);
          const ticket = OptionOrderTicket.parse({ kind: preview.kind, legs: preview.legs.map(leg => ({ symbol: leg.symbol, side: leg.side, positionIntent: leg.positionIntent })), qty: preview.qty, type: preview.type, limitPrice: preview.limitPrice });
          const [account, positions, recentOrders, marketData] = await Promise.all([
            alpaca.trading.account.getAccount(),
            alpaca.trading.positions.getAllOpenPositions(),
            alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
            optionOrderMarketData(ticket.legs.map(leg => leg.symbol)),
          ]);
          const requiredLevel = ticket.kind === "vertical" ? 3 : 2;
          if (Number(account.optionsTradingLevel ?? 0) < requiredLevel) throw new ClientError("Options permission changed; review the order again", 409);
          const freshRisk = optionOrderRisk(ticket, marketData.contracts, marketData.snapshots), equity = Number(account.equity), buyingPower = Number(account.optionsBuyingPower ?? 0), maxOrderRisk = Math.min(2_500, equity * .025);
          if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
          if (ticket.type === "market" && freshRisk.maxLoss > preview.maxLoss * 1.1) throw new ClientError("Option ask moved more than 10%; review the order again", 409);
          if (freshRisk.maxLoss > maxOrderRisk || freshRisk.maxLoss > buyingPower) throw new ClientError("Option risk or buying power changed; review the order again", 409);
          operationalPolicy = evaluateOperationsPolicy({ policy: store.operationsPolicy(), order: { assetClass: "option", symbol: freshRisk.legs[0]?.underlying ?? freshRisk.legs[0]?.symbol ?? "OPTIONS", side: "buy", notional: freshRisk.maxLoss }, account, positions, dailyTurnover: rollingTurnover(recentOrders) });
          if (!operationalPolicy.allowed) {
            store.releaseSubmission(idempotencyKey);
            return operationalPolicyBlocked(operationalPolicy, { referenceDebit: freshRisk.referenceDebit });
          }
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
        const riskStatus = riskReservationStatusForBrokerStatus(order.status);
        if (riskStatus) store.finishRiskReservation(idempotencyKey, riskStatus);
        orderTracker.update(order);
        const receiptId = crypto.randomUUID(), response = { ...managedOrderDto(order), receiptId };
        store.completeSubmission(idempotencyKey, order.id, response);
        store.receipt(receiptId, { advisor: actor, kind: "option_order", preview: { ...preview, risk: reservation.validation, operationalPolicy }, idempotencyKey, orderId: order.id, status: order.status, createdAt: new Date().toISOString() });
        store.event("option.order.submitted", actor, { orderId: order.id, receiptId, kind: preview.kind, operationalPolicy });
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
        const dailyTurnover = rollingTurnover(recentOrders);
        const operationalPolicies = pricedLegs.map((leg, index) => evaluateOperationsPolicy({
          policy: store.operationsPolicy(),
          order: { assetClass: "basket", symbol: leg.symbol, side: leg.side, qty: leg.qty, price: leg.price },
          account,
          positions,
          dailyTurnover,
          pendingOrders: [...brokerPending, ...pricedLegs.filter((_, legIndex) => legIndex !== index)],
        }));
        const liquidity = marketLegs.map(leg => ({ symbol: leg.symbol, ...liquidityPreview(leg.marketSnapshot, leg.qty, leg.price as number, "market") }));
        store.event("order.basket.preview", actor, { legs: pricedLegs, simulation, operationalPolicies, liquidity });
        if (!simulation.allowed) return json({ allowed: false, simulation, liquidity }, 422);
        if (operationalPolicies.some(policy => !policy.allowed)) return json({ allowed: false, simulation, operationalPolicies, reasons: [...new Set(operationalPolicies.flatMap(policy => policy.reasons))], runbook: [...new Set(operationalPolicies.flatMap(policy => policy.runbook))], liquidity }, 422);
        const expiresAt = Date.now() + 120_000;
        return json({ allowed: true, simulation, operationalPolicies, liquidity, session: orderSessionGuidance(clock), expiresAt, previewToken: signRebalanceBasketPreview({ legs: pricedLegs, timeInForce: basket.timeInForce, expiresAt }, previewSecret) });
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
        let freshOperationalPolicies: OperationsPolicyEvaluation[] = [];
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
          const dailyTurnover = rollingTurnover(recentOrders);
          freshOperationalPolicies = freshLegs.map((leg, index) => evaluateOperationsPolicy({
            policy: store.operationsPolicy(),
            order: { assetClass: "basket", symbol: leg.symbol, side: leg.side, qty: leg.qty, price: leg.price },
            account,
            positions,
            dailyTurnover,
            pendingOrders: [...brokerPending, ...freshLegs.filter((_, legIndex) => legIndex !== index)],
          }));
          if (freshOperationalPolicies.some(policy => !policy.allowed)) {
            store.releaseSubmission(idempotencyKey);
            return json({ allowed: false, operationalPolicies: freshOperationalPolicies, reasons: [...new Set(freshOperationalPolicies.flatMap(policy => policy.reasons))], runbook: [...new Set(freshOperationalPolicies.flatMap(policy => policy.runbook))] }, 422);
          }
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
        store.event("order.basket.confirmed", actor, { legs: freshLegs, simulation: freshSimulation, operationalPolicies: freshOperationalPolicies, idempotencyKey });
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
            const riskStatus = riskReservationStatusForBrokerStatus(order.status);
            if (riskStatus) store.finishRiskReservation(reservationKeys[index]!, riskStatus);
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
        store.receipt(receiptId, { advisor: actor, kind: "rebalance_basket", preview: { ...preview, legs: freshLegs, simulation: freshSimulation, operationalPolicies: freshOperationalPolicies }, idempotencyKey, orderIds: results.flatMap(result => result.orderId ? [result.orderId] : []), status: response.status, results, createdAt: new Date().toISOString() });
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
        const storedPlan = typeof planId === "string" ? store.getPlan(planId) : null;
        if (planId !== undefined && !storedPlan) return json({ error: "Valid stored plan id is required" }, 400);
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
        if (storedPlan && !reviewedPlanAllowsOrder(storedPlan, { symbol, side, qty, amountType: ticket.amountType, type: ticket.type, orderClass: ticket.orderClass, timeInForce: ticket.timeInForce, extendedHours: ticket.extendedHours, allowShort: ticket.allowShort })) return json({ error: "Order must exactly match a risk-approved plan draft" }, 400);
        if (!asset.fractionable && !Number.isInteger(qty)) return json({ error: "This asset does not support fractional or dollar-notional orders" }, 400);
        const shortError = ticket.allowShort ? shortCapabilityError(account, asset) : null;
        if (shortError) return json({ error: shortError }, 400);
        const linkedError = linkedOrderError(ticket, price);
        if (linkedError) return json({ error: linkedError }, 400);
        const riskPrice = ticketRiskPrice(ticket, price);
        const simulation = simulateTrade({ snapshot: riskSnapshot(account.equity, account.cash, positions), positions, symbol, side, qty, price: riskPrice, dailyTurnover: rollingTurnover(recentOrders), allowShort: ticket.allowShort });
        const operationalPolicy = evaluateOperationsPolicy({ policy: store.operationsPolicy(), order: { assetClass: "equity", symbol, side, qty, price: riskPrice }, account, positions, dailyTurnover: rollingTurnover(recentOrders) });
        const liquidity = liquidityPreview(marketSnapshot, qty, price, ticket.type);
        store.event("order.preview", actor, { symbol, side, qty, type: ticket.type, simulation, operationalPolicy, liquidity });
        if (!simulation.allowed) return json({ allowed: false, simulation, liquidity }, 422);
        if (!operationalPolicy.allowed) return operationalPolicyBlocked(operationalPolicy, { simulation, liquidity });
        const expiresAt = Date.now() + 120_000;
        const preview: Preview = { symbol, side, qty, ...(ticket.notional ? { notional: ticket.notional } : {}), amountType: ticket.amountType, type: ticket.type, orderClass: ticket.orderClass, limitPrice: ticket.limitPrice, stopPrice: ticket.stopPrice, trailPercent: ticket.trailPercent, takeProfitPrice: ticket.takeProfitPrice, stopLossPrice: ticket.stopLossPrice, stopLossLimitPrice: ticket.stopLossLimitPrice, timeInForce: ticket.timeInForce, extendedHours: ticket.extendedHours, allowShort: ticket.allowShort, price, expiresAt, ...(planId ? { planId } : {}), simulation };
        return json({ allowed: true, simulation, operationalPolicy, liquidity, session: orderSessionGuidance(clock), order: { type: ticket.type, orderClass: ticket.orderClass, amountType: ticket.amountType, qty, notional: ticket.notional ?? null, limitPrice: ticket.limitPrice, stopPrice: ticket.stopPrice, trailPercent: ticket.trailPercent, takeProfitPrice: ticket.takeProfitPrice, stopLossPrice: ticket.stopLossPrice, stopLossLimitPrice: ticket.stopLossLimitPrice, timeInForce: ticket.timeInForce, extendedHours: ticket.extendedHours, allowShort: ticket.allowShort }, expiresAt, previewToken: signPreview(preview, previewSecret) });
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
        let freshOperationalPolicy: OperationsPolicyEvaluation | null = null;
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
            const riskPrice = ticketRiskPrice(intent, price);
            const operationalPolicy = evaluateOperationsPolicy({ policy: store.operationsPolicy(), order: { assetClass: "equity", symbol: intent.symbol, side: intent.side, qty, price: riskPrice }, account, positions, dailyTurnover: rollingTurnover(recentOrders), pendingOrders: brokerPending });
            return { account, positions, price, qty, riskPrice, recentOrders, brokerPending, operationalPolicy };
          });
          preview = fresh.preview;
          freshPrice = fresh.validation.price;
          freshQty = fresh.validation.qty;
          freshRiskPrice = fresh.validation.riskPrice;
          freshOperationalPolicy = fresh.validation.operationalPolicy;
          if (!freshOperationalPolicy.allowed) {
            store.releaseSubmission(idempotencyKey);
            return operationalPolicyBlocked(freshOperationalPolicy);
          }
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
        store.event("order.confirmed", actor, { symbol: preview.symbol, side: preview.side, qty: freshQty, notional: preview.notional, type: preview.type, price: freshPrice, riskPrice: freshRiskPrice, simulation: freshSimulation, operationalPolicy: freshOperationalPolicy, idempotencyKey });
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
        const riskStatus = riskReservationStatusForBrokerStatus(order.status);
        if (riskStatus) store.finishRiskReservation(idempotencyKey, riskStatus);
        const receiptId = crypto.randomUUID();
        const response = { ...managedOrderDto(order), receiptId };
        store.completeSubmission(idempotencyKey, order.id, response);
        store.receipt(receiptId, { advisor: actor, plan: preview.planId ? store.getPlan(preview.planId) : null, preview: { ...preview, qty: freshQty, price: freshPrice, simulation: freshSimulation, operationalPolicy: freshOperationalPolicy }, idempotencyKey, orderId: order.id, status: order.status, createdAt: new Date().toISOString() });
        store.event("order.submitted", actor, { orderId: order.id, receiptId, idempotencyKey, type: preview.type });
        return json(response);
      }
      const receiptAuditMatch = request.method === "GET" && url.pathname.match(/^\/api\/receipts\/([^/]+)\/audit$/);
      if (receiptAuditMatch) {
        const receiptId = decodeURIComponent(receiptAuditMatch[1]!);
        const receipt = store.getReceipt(receiptId);
        if (!receipt) return json({ error: "Receipt not found" }, 404);
        return json({ receiptId, auditTrail: store.decisionAuditTrail(receiptId), verification: store.verifyDecisionAuditTrail(), asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/decision-audit" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) return json({ error: "Decision audit limit must be between 1 and 1000" }, 400);
        return json({ auditTrail: store.decisionAuditTrail(undefined, limit), verification: store.verifyDecisionAuditTrail(), asOf: new Date().toISOString() });
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
if (process.env.STRATEGY_SCHEDULER_DISABLED !== "1") {
  const pollMs = Number(process.env.STRATEGY_SCHEDULER_POLL_MS ?? 60_000);
  if (Number.isFinite(pollMs) && pollMs >= 10_000) setInterval(() => void pollStrategyScheduler(), pollMs);
}
setInterval(() => {
  for (const [id, subscriber] of streamSubscribers) {
    try { subscriber.controller.enqueue(streamEncoder.encode(": heartbeat\n\n")); }
    catch { removeStreamSubscriber(id); }
  }
}, 20_000);
