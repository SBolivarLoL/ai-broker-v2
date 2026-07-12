import { TimeFrame, type Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { json, requestJson } from "../../http/http";
import { getStockBarsWithFallback } from "../../integrations/alpaca/market-data";
import type { createStore } from "../../persistence/store";
import {
  performancePoints,
  portfolioPerformanceDto,
} from "./analytics";
import type { CurrentPortfolioExposure } from "./exposure-service";
import { ledgerSummary, type LedgerCategory } from "./ledger";
import {
  buildPortfolioOptimizerReport,
  PortfolioOptimizerRequest,
} from "./portfolio-optimizer";
import {
  buildPortfolioScenarioReport,
  CustomPortfolioScenario,
} from "./portfolio-scenarios";
import type { buildPortfolioSnapshot } from "./portfolio-snapshot";
import {
  buildConstrainedRebalancePlan,
  ConstrainedRebalancePlanRequest,
} from "./rebalance-planner";
import {
  riskSnapshot,
  rollingTurnover,
} from "../../shared/risk";
import { portfolioRiskDto } from "./risk-response";
import { portfolioSnapshotsDto } from "./snapshot-response";
import { accountActivitiesDto } from "./activity-response";
import {
  normalizeOptimizerHistory,
  optimizerHistoryUsable,
  portfolioOptimizerDto,
} from "./optimizer-response";

type Env = Record<string, string | undefined>;
type Store = ReturnType<typeof createStore>;
type RateLimit = (key: string, maximum: number) => boolean;

type PortfolioContext = {
  alpaca: Alpaca;
  store: Store;
  actor: string;
  allow: RateLimit;
  syncAccountActivities: () => Promise<{
    imported: number;
    truncated: boolean;
    retrievedAt: string;
    cacheHit: boolean;
  }>;
  currentPortfolioExposure: () => Promise<CurrentPortfolioExposure>;
  capturePortfolioSnapshot: () => Promise<
    ReturnType<typeof buildPortfolioSnapshot>
  >;
  env?: Env;
  now?: () => Date;
};

/** Handles account-ledger and portfolio-analysis endpoints. */
export async function handlePortfolioRequest(
  request: Request,
  url: URL,
  context: PortfolioContext,
): Promise<Response | null> {
  const { alpaca, store, actor, allow } = context;
  const env = context.env ?? process.env;
  const now = context.now ?? (() => new Date());

  if (url.pathname === "/api/account/activities" && request.method === "GET") {
    const allowedCategories = new Set<LedgerCategory>([
      "trade",
      "dividend",
      "interest",
      "fee",
      "transfer",
      "corporate_action",
      "option",
      "other",
    ]);
    const rawCategory = url.searchParams.get("category") ?? "";
    const category = rawCategory ? (rawCategory as LedgerCategory) : undefined;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (
      (category && !allowedCategories.has(category)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      return json(
        {
          error: "Valid activity category and limit from 1 to 200 are required",
        },
        400,
      );
    }
    const sync = await context.syncAccountActivities();
    const allActivities = store.activities(5_000);
    return json(accountActivitiesDto({
      activities: store.activities(limit, category),
      allActivities,
      imported: sync.imported,
      truncated: sync.truncated,
      cacheHit: sync.cacheHit,
      retrievedAt: sync.retrievedAt,
      serverRespondedAt: now(),
    }));
  }

  if (url.pathname === "/api/portfolio/risk") {
    const requestedAt = now();
    const [account, positions] = await Promise.all([
      alpaca.trading.account.getAccount(),
      alpaca.trading.positions.getAllOpenPositions(),
    ]);
    const accountRetrievedAt = now();
    if (account.equity === undefined || account.cash === undefined) {
      return json({ error: "Account risk data unavailable" }, 502);
    }
    const start = new Date(requestedAt.getTime() - 90 * 86_400_000);
    const [positionData, benchmarkData] = await Promise.all([
      Promise.all(
        positions.map(async (position) => {
          const [barData, marketSnapshot] = await Promise.all([
            getStockBarsWithFallback(alpaca.marketData, position.symbol, {
              timeframe: TimeFrame.Day,
              start,
              end: requestedAt,
              now: requestedAt,
            }),
            alpaca.marketData.stocks.stockSnapshotSingle({
              symbol: position.symbol,
              feed: "iex",
            }),
          ]);
          return {
            position,
            bars: barData.bars.slice(-90),
            barSource: barData.source,
            marketSnapshot,
          };
        }),
      ),
      getStockBarsWithFallback(alpaca.marketData, "SPY", {
        timeframe: TimeFrame.Day,
        start,
        end: requestedAt,
        now: requestedAt,
      }),
    ]);
    const marketRetrievedAt = now();
    return json(
      portfolioRiskDto({
        account: { equity: account.equity, cash: account.cash },
        positions,
        positionData,
        benchmarkBars: benchmarkData.bars.slice(-90),
        benchmarkSource: benchmarkData.source,
        accountRetrievedAt,
        marketRetrievedAt,
        serverRespondedAt: now(),
      }),
    );
  }

  if (url.pathname === "/api/portfolio/exposure" && request.method === "GET") {
    return json((await context.currentPortfolioExposure()).report);
  }

  if (url.pathname === "/api/portfolio/optimizer" && request.method === "GET") {
    const requestedAt = now();
    const parsed = PortfolioOptimizerRequest.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsed.success) {
      return json(
        {
          error: parsed.error.issues[0]?.message ?? "Invalid optimizer request",
        },
        400,
      );
    }
    const optimizerRequest = parsed.data;
    const [account, positions] = await Promise.all([
      alpaca.trading.account.getAccount(),
      alpaca.trading.positions.getAllOpenPositions(),
    ]);
    const accountRetrievedAt = now();
    if (account.equity === undefined) {
      throw new Error("Account optimizer data unavailable");
    }
    const equityPositions = positions
      .filter(
        (position) =>
          position.assetClass === "us_equity" &&
          Number(position.qty) > 0 &&
          Number(position.marketValue) > 0,
      )
      .slice(0, 50);
    const start = new Date(
      requestedAt.getTime() -
        Math.max(90, optimizerRequest.minObservations * 3) * 86_400_000,
    );
    const rawPositionData = await Promise.all(
      equityPositions.map(async (position) => {
        const bars = await alpaca.marketData.getStockBarsFor(position.symbol, {
          timeframe: TimeFrame.Day,
          start,
          end: requestedAt,
          feed: "iex",
        });
        return {
          symbol: position.symbol,
          marketValue: Number(position.marketValue),
          bars,
        };
      }),
    );
    const marketRetrievedAt = now();
    const histories = rawPositionData.map((position) =>
      normalizeOptimizerHistory({
        symbol: position.symbol,
        marketValue: position.marketValue,
        rawBars: position.bars,
        retrievedAt: marketRetrievedAt,
      }),
    );
    const report = buildPortfolioOptimizerReport({
      equity: Number(account.equity),
      positions: histories.map((history) => ({
        symbol: history.symbol,
        marketValue: history.marketValue,
        closes: optimizerHistoryUsable(
          history,
          optimizerRequest.minObservations,
          marketRetrievedAt,
        )
          ? history.bars.map((bar) => bar.close)
          : [],
      })),
      request: optimizerRequest,
      asOf: marketRetrievedAt.toISOString(),
    });
    const omittedNonEquity = positions.length - equityPositions.length;
    const warnings =
      omittedNonEquity > 0
        ? [
            ...report.warnings,
            `${omittedNonEquity} non-long-US-equity or non-positive position${omittedNonEquity === 1 ? " was" : "s were"} omitted from optimizer proposals.`,
          ]
        : report.warnings;
    store.event("portfolio.optimizer.generated", actor, {
      proposals: report.proposals.map((proposal) => proposal.id),
      constraints: report.constraints,
      optimizedSymbols: report.coverage.optimizedSymbols,
    });
    return json(
      portfolioOptimizerDto({
        report: { ...report, warnings },
        histories,
        totalPositionCount: positions.length,
        omittedPositionCount: omittedNonEquity,
        minObservations: optimizerRequest.minObservations,
        accountRetrievedAt,
        evaluatedAt: marketRetrievedAt,
        serverRespondedAt: now(),
      }),
    );
  }

  if (
    url.pathname === "/api/portfolio/scenarios" &&
    (request.method === "GET" || request.method === "POST")
  ) {
    let custom;
    if (request.method === "POST") {
      if (!allow(`${actor}:portfolio-scenarios`, 30)) {
        return json({ error: "Portfolio scenario rate limit exceeded" }, 429);
      }
      const input = await requestJson(request);
      const parsed = CustomPortfolioScenario.safeParse(
        typeof input === "object" && input !== null
          ? (input as { custom?: unknown }).custom
          : undefined,
      );
      if (!parsed.success) {
        return json(
          {
            error: parsed.error.issues[0]?.message ?? "Invalid custom scenario",
          },
          400,
        );
      }
      custom = parsed.data;
    }
    const exposure = await context.currentPortfolioExposure();
    return json(
      buildPortfolioScenarioReport({
        equity: exposure.equity,
        asOf: exposure.report.asOf,
        custom,
        positions: exposure.report.positions.map((position) => ({
          symbol: position.symbol,
          marketValue: position.marketValue,
          assetClass: position.assetClass,
          sector: position.sector,
          sic: position.sic,
          volatility20dPercent: position.factors.volatility20dPercent,
        })),
      }),
    );
  }

  if (
    url.pathname === "/api/portfolio/rebalance-plan" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:portfolio-rebalance-plan`, 20)) {
      return json({ error: "Rebalance planner rate limit exceeded" }, 429);
    }
    const parsed = ConstrainedRebalancePlanRequest.safeParse(
      await requestJson(request),
    );
    if (!parsed.success) {
      return json(
        {
          error:
            parsed.error.issues[0]?.message ?? "Invalid rebalance plan request",
        },
        400,
      );
    }
    const plannerRequest = parsed.data;
    const targetSymbols = [
      ...new Set(plannerRequest.targets.map((target) => target.symbol)),
    ];
    const [sync, account, positions, recentOrders, marketRows] =
      await Promise.all([
        context.syncAccountActivities(),
        alpaca.trading.account.getAccount(),
        alpaca.trading.positions.getAllOpenPositions(),
        alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
        Promise.all(
          targetSymbols.map(async (symbol) => {
            const [asset, price] = await Promise.all([
              alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
                symbolOrAssetId: symbol,
              }),
              alpaca.marketData.getLatestPrice(symbol),
            ]);
            return { symbol, asset, price };
          }),
        ),
      ]);
    if (account.equity === undefined || account.cash === undefined) {
      throw new Error("Account risk data unavailable");
    }
    if (recentOrders.length >= 500) {
      throw new Error("The complete order window could not be verified");
    }
    const short = positions.find(
      (position) =>
        Number(position.qty) < -1e-8 || Number(position.marketValue) < -1e-8,
    );
    if (short) {
      return json(
        {
          error: `Current short positions are not supported by this planner (${short.symbol})`,
        },
        400,
      );
    }
    for (const row of marketRows) {
      if (!row.asset.tradable || row.asset._class !== "us_equity") {
        return json(
          { error: `${row.symbol} is not a tradable US stock or ETF` },
          400,
        );
      }
      if (
        typeof row.price !== "number" ||
        !Number.isFinite(row.price) ||
        row.price <= 0
      ) {
        return json({ error: `No valid current price for ${row.symbol}` }, 400);
      }
    }
    const market = marketRows.map((row) => ({
      symbol: row.symbol,
      price: row.price as number,
      fractionable: Boolean(row.asset.fractionable),
    }));
    const marketBySymbol = new Map(
      market.map((row) => [row.symbol, row] as const),
    );
    const ledger = ledgerSummary(store.activities(5_000), sync.truncated);
    const taxLotsComplete =
      !ledger.activityHistoryTruncated &&
      ledger.unmatchedSellQuantity <= 1e-8 &&
      ledger.unresolvedCorporateActions.length === 0;
    const plan = buildConstrainedRebalancePlan({
      request: plannerRequest,
      account: {
        equity: Number(account.equity),
        cash: Number(account.cash),
      },
      positions: positions.map((position) => {
        const symbol = String(position.symbol).toUpperCase();
        const currentPrice = Number(position.currentPrice);
        return {
          symbol,
          qty: Number(position.qty),
          marketValue: Number(position.marketValue),
          price:
            Number.isFinite(currentPrice) && currentPrice > 0
              ? currentPrice
              : undefined,
          fractionable: marketBySymbol.get(symbol)?.fractionable,
        };
      }),
      market,
      openLots: ledger.openLots,
      taxLotsComplete,
      taxEvidenceWarnings: ledger.warnings,
      currentTurnoverNotional: rollingTurnover(recentOrders),
      policyMaxTurnoverPercent:
        store.operationsPolicy().maxDailyTurnoverPercent,
      asOf: new Date().toISOString(),
    });
    store.event("portfolio.rebalance_plan.created", actor, {
      targets: plannerRequest.targets,
      withinConstraints: plan.withinConstraints,
      legs: plan.legs,
      bindingConstraints: plan.bindingConstraints,
      taxEvidenceStatus: plan.tax.evidenceStatus,
    });
    return json(plan);
  }

  if (url.pathname === "/api/portfolio/snapshots" && request.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 366) {
      return json({ error: "Snapshot limit must be 1 to 366" }, 400);
    }
    const current = await context.capturePortfolioSnapshot();
    return json(
      portfolioSnapshotsDto({
        current,
        history: store.portfolioSnapshots(limit),
        serverRespondedAt: now(),
      }),
    );
  }

  if (url.pathname === "/api/portfolio/performance") {
    const periods: Record<string, string> = {
      "1M": "1M",
      "3M": "3M",
      "6M": "6M",
      "1Y": "1A",
    };
    const period = url.searchParams.get("period") ?? "3M";
    if (!periods[period])
      return json({ error: "Period must be 1M, 3M, 6M, or 1Y" }, 400);
    const benchmarkSymbol = (env.PORTFOLIO_BENCHMARK ?? "SPY")
      .trim()
      .toUpperCase();
    if (!/^[A-Z.]{1,10}$/.test(benchmarkSymbol)) {
      return json({ error: "PORTFOLIO_BENCHMARK must be a valid symbol" }, 500);
    }
    const [history, positions] = await Promise.all([
      alpaca.trading.portfolioHistory.getAccountPortfolioHistory({
        period: periods[period],
        timeframe: "1D",
        pnlReset: "no_reset",
        cashflowTypes: "CSD,CSW,JNLC",
      }),
      alpaca.trading.positions.getAllOpenPositions(),
    ]);
    const portfolioRetrievedAt = now();
    const points = performancePoints(history);
    let benchmarkData: {
      bars: Awaited<ReturnType<typeof getStockBarsWithFallback>>["bars"];
      source:
        | Awaited<ReturnType<typeof getStockBarsWithFallback>>["source"]
        | null;
    } = {
      bars: [],
      source: null,
    };
    let benchmarkRetrievedAt: Date | null = null;
    if (points.length) {
      benchmarkData = await getStockBarsWithFallback(
        alpaca.marketData,
        benchmarkSymbol,
        {
          timeframe: TimeFrame.Day,
          start: new Date(points[0]!.timestamp - 3 * 86_400_000),
          end: new Date(points.at(-1)!.timestamp + 2 * 86_400_000),
        },
      );
      benchmarkRetrievedAt = now();
    }
    return json(
      portfolioPerformanceDto({
        period,
        points,
        benchmarkBars: benchmarkData.bars,
        benchmarkSymbol,
        benchmarkSource: benchmarkData.source,
        positions,
        portfolioRetrievedAt,
        benchmarkRetrievedAt,
        serverRespondedAt: now(),
      }),
    );
  }

  return null;
}
