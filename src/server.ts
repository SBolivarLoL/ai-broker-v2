import { Alpaca, TimeFrame } from "@alpacahq/alpaca-ts-alpha";
import { benchmarkAttribution, diversificationScore, performancePoints, performanceSummary, stressTests, valueAtRisk95 } from "./analytics";
import { companyMarketSnapshot } from "./company-market";
import { Intent, runPortfolioCopilot } from "./copilot";
import { ledgerSummary, normalizeActivity, type LedgerCategory } from "./ledger";
import { buildReplacementPreview, canCancelOrder, managedOrderDto, OrderTracker, ReplacementInput, signReplacementPreview, verifyReplacementPreview } from "./order-management";
import { signPreview, verifyPreviewFresh, type Preview } from "./orders";
import { buildPortfolioSnapshot } from "./portfolio-snapshot";
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
const orderDto = managedOrderDto;
const allow = rateLimiter();
let assetCatalog: { expiresAt: number; assets: SearchableAsset[] } | null = null;
let assetCatalogRequest: Promise<SearchableAsset[]> | null = null;
let activitySync: { expiresAt: number; imported: number; truncated: boolean } | null = null;
let activitySyncRequest: Promise<{ imported: number; truncated: boolean }> | null = null;
const orderTracker = new OrderTracker();
let orderRecoveryRequest: Promise<void> | null = null;
let portfolioCaptureRequest: Promise<ReturnType<typeof buildPortfolioSnapshot>> | null = null;
const companyMarketCache = new Map<string, { expiresAt: number; value: ReturnType<typeof companyMarketSnapshot> }>();

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

async function pendingBrokerOrders(orders: any[], candidateSymbol: string, candidatePrice: number) {
  const working = orders.filter(order => workingStatuses.has(String(order.status)));
  const symbols = [...new Set(working.map(order => String(order.symbol)))];
  const prices = new Map(await Promise.all(symbols.map(async symbol => [symbol, symbol === candidateSymbol ? candidatePrice : await alpaca.marketData.getLatestPrice(symbol)] as const)));
  return working.map(order => {
    const qty = Number(order.qty) - Number(order.filledQty ?? 0);
    const price = Number(order.limitPrice ?? order.stopPrice ?? prices.get(String(order.symbol)));
    if (!(qty > 0) || !Number.isFinite(price) || price <= 0 || !["buy", "sell"].includes(order.side)) {
      throw new Error("A working order could not be valued safely");
    }
    return { orderId: order.id, symbol: String(order.symbol), side: order.side as "buy" | "sell", qty, price };
  });
}

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !validMutationOrigin(request)) return json({ error: "Invalid request origin" }, 403);
    let actor = "anonymous";
    if (url.pathname.startsWith("/api/")) {
      try { actor = actorFor(request); } catch { return json({ error: "Unauthorized" }, 401); }
    }
    try {
      if (url.pathname === "/") return new Response(Bun.file("src/index.html"), { headers: securityHeaders });
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
        return json({ account: accountDto(account), positions: positions.map(positionDto), orders: orders.map(orderDto) });
      }
      if (url.pathname === "/api/quote") {
        const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
        if (!symbol || !/^[A-Z.]{1,10}$/.test(symbol)) return json({ error: "Valid symbol is required" }, 400);
        const price = await alpaca.marketData.getLatestPrice(symbol);
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return json({ error: "No valid current price" }, 502);
        return json({ symbol, price, asOf: new Date().toISOString() });
      }
      if (url.pathname === "/api/assets/search") {
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (query.length < 1 || query.length > 50) return json({ error: "Search must contain 1 to 50 characters" }, 400);
        return json({ query, results: searchAssets(await getAssetCatalog(), query) });
      }
      if (url.pathname === "/api/company/market" && request.method === "GET") {
        const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
        const period = url.searchParams.get("period") ?? "3M";
        const periodDays: Record<string, number> = { "1M": 35, "3M": 100, "1Y": 370 };
        if (!/^[A-Z.]{1,10}$/.test(symbol) || !periodDays[period]) return json({ error: "Valid symbol and period (1M, 3M, or 1Y) are required" }, 400);
        const cacheKey = `${symbol}:${period}`;
        const cached = companyMarketCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return json(cached.value);
        const start = new Date(Date.now() - periodDays[period] * 86_400_000);
        const [asset, snapshot, bars, news, clock] = await Promise.all([
          alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol }),
          alpaca.marketData.stocks.stockSnapshotSingle({ symbol, feed: "iex" }),
          alpaca.marketData.getStockBarsFor(symbol, { timeframe: TimeFrame.Day, start, feed: "iex" }),
          alpaca.marketData.news.news({ symbols: symbol, limit: 8, sort: "desc" }).then(response => response.news).catch(() => []),
          alpaca.trading.calendar.clock(),
        ]);
        const value = companyMarketSnapshot(asset, snapshot, bars, news, clock, period);
        companyMarketCache.set(cacheKey, { value, expiresAt: Date.now() + 30_000 });
        if (companyMarketCache.size > 60) companyMarketCache.delete(companyMarketCache.keys().next().value!);
        return json(value);
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
        const series = await Promise.all(positions.map(async position => ({ marketValue: Number(position.marketValue), closes: (await alpaca.marketData.getStockBarsFor(position.symbol, { timeframe: TimeFrame.Day, start })).map(bar => bar.close).slice(-90) })));
        const history = portfolioHistory(Number(account.equity), Number(account.cash), series);
        const snapshot = riskSnapshot(account.equity, account.cash, positions);
        return json({ ...snapshot, ...historicalRisk(history), ...valueAtRisk95(snapshot.equity, history), diversification: diversificationScore(snapshot.hhi, snapshot.largestPositionPercent), stressTests: stressTests(snapshot.equity, snapshot.cash, snapshot.weights), asOf: new Date().toISOString() });
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
        return json({ status, orders: orders.map(orderDto), sync: orderTracker.metadata(), asOf: new Date().toISOString() });
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
          const response = { ...orderDto(replaced), replacedOrderId: preview.orderId };
          store.completeSubmission(idempotencyKey, replaced.id, response);
          store.event("order.replace.submitted", actor, { orderId: preview.orderId, replacementOrderId: replaced.id, symbol: preview.symbol, replacement: preview.replacement });
          return json(response);
        } catch (error) {
          store.releaseSubmission(idempotencyKey);
          if (error instanceof ClientError) throw error;
          throw new ClientError("Alpaca could not replace the order because its state changed. Refresh the blotter.", 409);
        }
      }
      if (url.pathname === "/api/orders/preview" && request.method === "POST") {
        if (!allow(`${actor}:orders`, 30)) return json({ error: "Order rate limit exceeded" }, 429);
        const { symbol: rawSymbol, qty: rawQty, side, planId } = await requestJson(request);
        const symbol = String(rawSymbol ?? "").trim().toUpperCase();
        const qty = Number(rawQty);
        if (!/^[A-Z.]{1,10}$/.test(symbol) || !Number.isFinite(qty) || qty <= 0 || !["buy", "sell"].includes(side)) {
          return json({ error: "Valid symbol, quantity, and side are required" }, 400);
        }
        if (planId !== undefined && (typeof planId !== "string" || !store.getPlan(planId))) return json({ error: "Valid stored plan id is required" }, 400);
        const [account, positions, asset, price, recentOrders] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol }),
          alpaca.marketData.getLatestPrice(symbol),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
        ]);
        if (!asset.tradable || asset._class !== "us_equity") return json({ error: "Only tradable US stocks and ETFs are supported" }, 400);
        if (typeof price !== "number") return json({ error: "No valid current price" }, 400);
        if (account.equity === undefined || account.cash === undefined) return json({ error: "Account risk data unavailable" }, 502);
        const simulation = simulateTrade({ snapshot: riskSnapshot(account.equity, account.cash, positions), positions, symbol, side, qty, price, dailyTurnover: rollingTurnover(recentOrders) });
        store.event("order.preview", actor, { symbol, side, qty, simulation });
        if (!simulation.allowed) return json({ allowed: false, simulation }, 422);
        const expiresAt = Date.now() + 120_000;
        return json({ allowed: true, simulation, expiresAt, previewToken: signPreview({ symbol, side, qty, price, expiresAt, planId, simulation }, previewSecret) });
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
        let freshSimulation;
        try {
          const fresh = await verifyPreviewFresh(previewToken, previewSecret, async intent => {
            const [account, positions, asset, price, recentOrders] = await Promise.all([
              alpaca.trading.account.getAccount(),
              alpaca.trading.positions.getAllOpenPositions(),
              alpaca.trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: intent.symbol }),
              alpaca.marketData.getLatestPrice(intent.symbol),
              alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
            ]);
            if (!asset.tradable || asset._class !== "us_equity") throw new ClientError("The asset is no longer tradable", 409);
            if (!asset.fractionable && !Number.isInteger(intent.qty)) throw new ClientError("This asset does not support fractional orders", 409);
            if (account.equity === undefined || account.cash === undefined || typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error("Fresh trade validation data is unavailable");
            if (recentOrders.length >= 500) throw new Error("The complete order window could not be verified");
            if (Math.abs(price / intent.price - 1) > 0.01) throw new ClientError("The price moved more than 1%; review the order again", 409);
            const brokerPending = await pendingBrokerOrders(recentOrders, intent.symbol, price);
            return { account, positions, price, recentOrders, brokerPending };
          });
          preview = fresh.preview;
          freshPrice = fresh.validation.price;
          const reservation = store.reserveRisk(idempotencyKey, { symbol: preview.symbol, side: preview.side, qty: preview.qty, price: freshPrice }, active => {
            const brokerIds = new Set(fresh.validation.brokerPending.map(order => order.orderId));
            const localPending = active.filter(order => !order.orderId || !brokerIds.has(order.orderId));
            const simulation = simulateTrade({
              snapshot: riskSnapshot(Number(fresh.validation.account.equity), Number(fresh.validation.account.cash), fresh.validation.positions),
              positions: fresh.validation.positions,
              symbol: preview.symbol,
              side: preview.side,
              qty: preview.qty,
              price: freshPrice,
              dailyTurnover: rollingTurnover(fresh.validation.recentOrders),
              pendingOrders: [...fresh.validation.brokerPending, ...localPending],
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
        store.event("order.confirmed", actor, { symbol: preview.symbol, side: preview.side, qty: preview.qty, price: freshPrice, simulation: freshSimulation, idempotencyKey });
        // Alpaca also enforces this key, covering a lost response after acceptance.
        let order;
        try {
          order = await alpaca.trading.orders.market({ symbol: preview.symbol, qty: preview.qty, side: preview.side, clientOrderId: idempotencyKey });
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
        const response = { ...orderDto(order), receiptId };
        store.completeSubmission(idempotencyKey, order.id, response);
        store.receipt(receiptId, { advisor: actor, plan: preview.planId ? store.getPlan(preview.planId) : null, preview: { ...preview, price: freshPrice, simulation: freshSimulation }, idempotencyKey, orderId: order.id, status: order.status, createdAt: new Date().toISOString() });
        store.event("order.submitted", actor, { orderId: order.id, receiptId, idempotencyKey });
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

console.log("AI Broker running at http://localhost:3000");
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
void recoverOrders().then(() => capturePortfolioSnapshot()).catch(error => console.error("startup recovery failed", error instanceof Error ? error.message : error));
setInterval(() => void recoverOrders().catch(error => console.error("order recovery failed", error instanceof Error ? error.message : error)), 30_000);
setInterval(() => void capturePortfolioSnapshot().catch(error => console.error("portfolio snapshot failed", error instanceof Error ? error.message : error)), 15 * 60_000);
