/**
 * Application composition root.
 *
 * Feature modules own their routes and business rules; this file wires them to
 * shared broker, persistence, authentication, and lifecycle dependencies.
 */
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { normalizeActivity } from "./features/portfolio/ledger";
import { createPortfolioExposureService } from "./features/portfolio/exposure-service";
import { accountStateDto } from "./features/portfolio/account-state";
import { createMarketService } from "./features/markets/service";
import { createOrderRoutes } from "./features/orders/routes";
import { createOrderRuntime } from "./features/orders/runtime";
import {
  handleOperationsRequest,
  secIdentityConfigured,
} from "./features/operations/routes";
import { createReconciliationService } from "./features/operations/reconciliation";
import {
  createRetentionService,
  retentionPolicyFromEnv,
} from "./features/operations/retention";
import { buildPortfolioSnapshot } from "./features/portfolio/portfolio-snapshot";
import { handlePortfolioRequest } from "./features/portfolio/routes";
import { riskSnapshot } from "./shared/risk";
import { handleResearchRequest } from "./features/research/routes";
import {
  authContextFor,
  rateLimiter,
  securityReady,
  validMutationOrigin,
  type AuthContext,
} from "./shared/security";
import type { createStore } from "./persistence/store";
import { authorizeRoute } from "./http/authorize-route";
import { ClientError, json, securityHeaders } from "./http/http";
import { handleStrategyRequest } from "./features/strategies/routes";
import { createStrategyRuntime } from "./features/strategies/runtime";
import type { CodeIdentity } from "./features/strategies/strategy-provenance";

type AppEnvironment = Record<string, string | undefined>;
type AppStore = ReturnType<typeof createStore>;
export type AppDependencies = {
  alpaca: Alpaca;
  store: AppStore;
  codeIdentity: CodeIdentity;
  env?: AppEnvironment;
  indexPath?: string;
  setIntervalFn?: (callback: () => void, milliseconds: number) => unknown;
  now?: () => Date;
};

export function createApp({
  alpaca,
  store,
  codeIdentity,
  env = process.env,
  indexPath = "frontend/index.html",
  setIntervalFn = setInterval,
  now = () => new Date(),
}: AppDependencies) {
  const previewSecret = env.PREVIEW_SECRET ?? "";
  const allow = rateLimiter();
  const market = createMarketService({ alpaca, store, allow, now });
  const strategies = createStrategyRuntime(alpaca, store, codeIdentity);
  const orderRuntime = createOrderRuntime(alpaca, store, now);
  const reconciliation = createReconciliationService({
    alpaca,
    store,
    orderRuntime,
    now,
  });
  const retention = createRetentionService({
    store,
    policy: retentionPolicyFromEnv(env),
    now,
  });
  const currentPortfolioExposure = createPortfolioExposureService(alpaca, {
    now,
  });
  const orderRoutes = createOrderRoutes({
    alpaca,
    store,
    runtime: orderRuntime,
    allow,
    previewSecret,
    getMarketClock: market.getClock,
    now,
  });

  let activitySync: {
    expiresAt: number;
    imported: number;
    truncated: boolean;
    retrievedAt: string;
  } | null = null;
  let activitySyncRequest: Promise<{
    imported: number;
    truncated: boolean;
    retrievedAt: string;
  }> | null = null;
  let portfolioCaptureRequest: Promise<
    ReturnType<typeof buildPortfolioSnapshot>
  > | null = null;

  async function syncAccountActivities() {
    if (activitySync && activitySync.expiresAt > Date.now())
      return { ...activitySync, cacheHit: true };
    // Share one broker pagination request across concurrent ledger callers.
    activitySyncRequest ??= (async () => {
      const brokerActivities = [];
      const maximum = 1_000;
      for await (const activity of alpaca.trading.iterateActivities({
        direction: "desc",
        pageSize: 100,
      })) {
        brokerActivities.push(activity);
        if (brokerActivities.length >= maximum) break;
      }
      const retrievedAt = now().toISOString();
      const activities = brokerActivities.map((activity) =>
        normalizeActivity(activity, retrievedAt)
      );
      store.syncActivities(activities);
      return {
        imported: activities.length,
        truncated: activities.length >= maximum,
        retrievedAt,
      };
    })().finally(() => {
      activitySyncRequest = null;
    });
    const result = await activitySyncRequest;
    activitySync = { ...result, expiresAt: Date.now() + 30_000 };
    return { ...activitySync, cacheHit: false };
  }

  async function capturePortfolioSnapshot() {
    // Snapshot endpoints and the timer may overlap; persist a single coherent
    // account/position read instead of racing multiple broker requests.
    portfolioCaptureRequest ??= (async () => {
      const [account, positions] = await Promise.all([
        alpaca.trading.account.getAccount(),
        alpaca.trading.positions.getAllOpenPositions(),
      ]);
      if (
        account.equity === undefined ||
        account.cash === undefined ||
        account.buyingPower === undefined
      )
        throw new Error("Account snapshot data unavailable");
      const risk = riskSnapshot(account.equity, account.cash, positions);
      const snapshot = buildPortfolioSnapshot(
        account,
        positions,
        risk,
        orderRuntime.tracker.metadata(),
        now(),
      );
      store.portfolioSnapshot(snapshot);
      return snapshot;
    })().finally(() => {
      portfolioCaptureRequest = null;
    });
    return portfolioCaptureRequest;
  }

  const frontendAssets = new Map<string, readonly [string, string]>([
    ["/styles.css", ["frontend/styles.css", "text/css; charset=utf-8"]],
    ["/core.js", ["frontend/core.js", "text/javascript; charset=utf-8"]],
    [
      "/portfolio.js",
      ["frontend/portfolio.js", "text/javascript; charset=utf-8"],
    ],
    [
      "/strategies.js",
      ["frontend/strategies.js", "text/javascript; charset=utf-8"],
    ],
    [
      "/market-detail.js",
      ["frontend/market-detail.js", "text/javascript; charset=utf-8"],
    ],
    [
      "/research.js",
      ["frontend/research.js", "text/javascript; charset=utf-8"],
    ],
    [
      "/data-quality.js",
      ["frontend/data-quality.js", "text/javascript; charset=utf-8"],
    ],
    ["/app.js", ["frontend/app.js", "text/javascript; charset=utf-8"]],
  ] as const);
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !validMutationOrigin(request, env)
    )
      return json({ error: "Invalid request origin" }, 403);
    let actor = "anonymous",
      auth: AuthContext | null = null;
    if (url.pathname.startsWith("/api/")) {
      try {
        auth = authContextFor(request, env);
        authorizeRoute(auth, url.pathname, request.method);
        actor = auth.actor;
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error && error.message === "Forbidden"
                ? "Forbidden"
                : "Unauthorized",
          },
          error instanceof Error && error.message === "Forbidden" ? 403 : 401,
        );
      }
    }
    try {
      if (url.pathname === "/")
        return new Response(Bun.file(indexPath), {
          headers: { ...securityHeaders, "cache-control": "no-store" },
        });
      const frontendAsset = frontendAssets.get(url.pathname);
      if (frontendAsset)
        return new Response(Bun.file(frontendAsset[0]), {
          headers: {
            ...securityHeaders,
            "cache-control": "no-store",
            "content-type": frontendAsset[1],
          },
        });
      if (url.pathname === "/favicon.ico")
        return new Response(null, {
          status: 204,
          headers: {
            ...securityHeaders,
            "cache-control": "public, max-age=86400",
          },
        });
      if (url.pathname === "/health") return json({ status: "ok" });
      if (url.pathname === "/ready") {
        if (
          previewSecret.length < 32 ||
          !securityReady(env) ||
          !secIdentityConfigured(env)
        )
          return json(
            {
              status: "not_ready",
              error:
                "Security or external-data identity configuration is incomplete",
            },
            503,
          );
        await alpaca.trading.account.getAccount();
        return json({ status: "ready", paper: true });
      }
      if (url.pathname === "/api/account") {
        const [account, positions, orders] = await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "open", limit: 100 }),
        ]);
        const retrievedAt = now();
        return json(
          accountStateDto({
            account,
            positions,
            orders,
            retrievedAt,
            serverRespondedAt: now(),
          }),
        );
      }
      // Handlers return null when a route is outside their feature boundary;
      // the first matching feature owns the response.
      const operationsResponse = await handleOperationsRequest(request, url, {
        store,
        actor,
        allow,
        env,
        runReconciliation: reconciliation.run,
        runRetention: retention.run,
      });
      if (operationsResponse) return operationsResponse;
      const marketResponse = await market.handleRequest(request, url, actor);
      if (marketResponse) return marketResponse;
      const strategyResponse = await handleStrategyRequest(request, url, {
        alpaca,
        store,
        runtime: strategies,
        orderRuntime,
        actor,
        allow,
        previewSecret,
      });
      if (strategyResponse) return strategyResponse;
      const orderResponse = await orderRoutes(request, url, actor);
      if (orderResponse) return orderResponse;
      const portfolioResponse = await handlePortfolioRequest(request, url, {
        alpaca,
        store,
        actor,
        allow,
        syncAccountActivities,
        currentPortfolioExposure,
        capturePortfolioSnapshot,
        env,
        now,
      });
      if (portfolioResponse) return portfolioResponse;
      const researchResponse = await handleResearchRequest(request, url, {
        alpaca,
        store,
        actor,
        allow,
        env,
      });
      if (researchResponse) return researchResponse;
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof ClientError)
        return json({ error: error.message }, error.status);
      console.error("request failed", {
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return json(
        { error: "The broker service could not complete the request" },
        502,
      );
    }
  };
  let started = false;
  function startRuntime() {
    if (started) return;
    started = true;
    // Network streams and timers start explicitly so importing createApp stays
    // side-effect free in tests and command-line tooling.
    market.start();
    void orderRuntime
      .start()
      .then(() => capturePortfolioSnapshot())
      .catch((error) =>
        console.error(
          "startup recovery failed",
          error instanceof Error ? error.message : error,
        ),
      );
    setIntervalFn(
      () =>
        void capturePortfolioSnapshot().catch((error) =>
          console.error(
            "portfolio snapshot failed",
            error instanceof Error ? error.message : error,
          ),
        ),
      15 * 60_000,
    );
    if (env.STRATEGY_SCHEDULER_DISABLED !== "1") {
      const pollMs = Number(env.STRATEGY_SCHEDULER_POLL_MS ?? 60_000);
      if (Number.isFinite(pollMs) && pollMs >= 10_000)
        setIntervalFn(() => void strategies.pollScheduler(), pollMs);
    }
    if (env.RECONCILIATION_DISABLED !== "1") {
      const pollMs = Number(env.RECONCILIATION_POLL_MS ?? 15 * 60_000);
      if (Number.isFinite(pollMs) && pollMs >= 60_000)
        setIntervalFn(
          () =>
            void reconciliation
              .run("scheduler", "reconciliation-scheduler")
              .catch((error) =>
                console.error(
                  "scheduled reconciliation failed",
                  error instanceof Error ? error.message : error,
                ),
              ),
          pollMs,
        );
    }
    if (env.RETENTION_DISABLED !== "1") {
      const pollMs = Number(env.RETENTION_POLL_MS ?? 24 * 60 * 60_000);
      if (Number.isFinite(pollMs) && pollMs >= 60 * 60_000)
        setIntervalFn(
          () =>
            void retention.run("scheduler", "retention-scheduler").catch(
              (error) =>
                console.error(
                  "scheduled retention failed",
                  error instanceof Error ? error.message : error,
                ),
            ),
          pollMs,
        );
    }
  }

  return { fetch, startRuntime };
}
