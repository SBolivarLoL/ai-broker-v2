import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { ClientError, json, requestJson } from "../../http/http";
import type { createStore } from "../../persistence/store";
import {
  evaluateOperationsPolicy,
  type OperationsPolicyEvaluation,
} from "../operations/operations-policy";
import { blockedOperationsPolicyResponse } from "../operations/policy-response";
import {
  buildCryptoOrderPreview,
  cryptoOrderMarketFromSnapshot,
  CryptoOrderTicket,
  signCryptoOrderPreview,
  verifyCryptoOrderPreview,
  type CryptoOrderPreview,
} from "../orders/crypto-order-ticket";
import { managedOrderDto } from "../orders/order-management";
import type { createOrderRuntime } from "../orders/runtime";
import { rollingTurnover } from "../portfolio/risk";
import { riskReservationStatusForBrokerStatus } from "../../shared/broker-status";
import {
  parseStrategyParams,
  runBacktest,
  strategyFunctionFromPlugin,
  strategyPluginFromId,
  walkForwardWindows,
} from "./strategy-backtest";
import {
  cryptoBarsDto,
  cryptoSnapshotDto,
  parseCryptoLookbackDays,
  parseCryptoSymbols,
  parseCryptoTimeframe,
} from "./crypto-strategy-data";
import { buildStrategyDashboard } from "./strategy-dashboard";
import {
  parseStrategyPaperApproval,
  type StrategyPaperApproval,
} from "./strategy-paper";
import { buildStrategyExperimentReport } from "./strategy-report";
import {
  parseStrategyReview,
  withStrategyReviewConfig,
} from "./strategy-review";
import { parseStrategyIntervalMinutes } from "./strategy-scheduler";
import {
  canonicalHash,
  STRATEGY_BACKTEST_POLICY_VERSION,
  STRATEGY_FEATURE_SCHEMA_VERSION,
} from "./strategy-provenance";
import type { createStrategyRuntime } from "./runtime";

type Store = ReturnType<typeof createStore>;
type StrategyRuntime = ReturnType<typeof createStrategyRuntime>;
type OrderRuntime = ReturnType<typeof createOrderRuntime>;
type RateLimit = (key: string, maximum: number) => boolean;

type StrategyRouteContext = {
  alpaca: Alpaca;
  store: Store;
  runtime: StrategyRuntime;
  orderRuntime: OrderRuntime;
  actor: string;
  allow: RateLimit;
  previewSecret: string;
};

async function placePreviewedCryptoOrder(
  alpaca: Alpaca,
  preview: CryptoOrderPreview,
  clientOrderId: string,
) {
  const common = {
    symbol: preview.symbol,
    side: preview.side,
    timeInForce: preview.timeInForce,
    clientOrderId,
  };
  if (preview.type === "market") {
    return preview.amountType === "notional"
      ? alpaca.trading.orders.market({ ...common, notional: preview.notional! })
      : alpaca.trading.orders.market({ ...common, qty: preview.estimatedQty });
  }
  if (preview.type === "limit") {
    return alpaca.trading.orders.limit({
      ...common,
      qty: preview.estimatedQty,
      limitPrice: preview.limitPrice!,
    });
  }
  return alpaca.trading.orders.stopLimit({
    ...common,
    qty: preview.estimatedQty,
    stopPrice: preview.stopPrice!,
    limitPrice: preview.limitPrice!,
  });
}

/** Translates strategy HTTP requests into runtime operations. */
export async function handleStrategyRequest(
  request: Request,
  url: URL,
  context: StrategyRouteContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/strategy/")) return null;
  const { alpaca, store, runtime, orderRuntime, actor, allow, previewSecret } =
    context;
  if (
    url.pathname === "/api/strategy/crypto/bars" &&
    request.method === "GET"
  ) {
    let symbols: string[], timeframe: string, days: number;
    try {
      symbols = parseCryptoSymbols(url.searchParams.get("symbols"));
      timeframe = parseCryptoTimeframe(url.searchParams.get("timeframe"));
      days = parseCryptoLookbackDays(url.searchParams.get("days"));
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid crypto bar query",
        400,
      );
    }
    const end = new Date(),
      start = new Date(end.getTime() - days * 86_400_000);
    const bars = await alpaca.marketData.getCryptoBars({
      loc: "us",
      symbols,
      timeframe,
      start,
      end,
      limit: 10_000,
    } as any);
    return json(cryptoBarsDto({ symbols, timeframe, start, end, bars }));
  }
  if (
    url.pathname === "/api/strategy/crypto/snapshots" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:strategy-crypto-ingest`, 20))
      return json(
        { error: "Crypto strategy ingestion rate limit exceeded" },
        429,
      );
    const input = await requestJson(request);
    const runId = String(input.runId ?? "").trim();
    if (!runId) return json({ error: "runId is required" }, 400);
    let symbols: string[];
    try {
      symbols = parseCryptoSymbols(input.symbols);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid crypto symbols",
        400,
      );
    }
    const requested = symbols.join(",");
    const receivedAt = new Date();
    const ingestStartedAt = Date.now();
    const traceId = crypto.randomUUID();
    const [snapshots, orderbooks] = await Promise.all([
      alpaca.marketData.crypto
        .cryptoSnapshots({ loc: "us", symbols: requested })
        .then((result) => result.snapshots ?? {}),
      alpaca.marketData.crypto
        .cryptoLatestOrderbooks({ loc: "us", symbols: requested })
        .then((result) => result.orderbooks ?? {})
        .catch(() => ({})),
    ]);
    const result = cryptoSnapshotDto({
      symbols,
      snapshots,
      orderbooks,
      receivedAt,
    });
    for (const record of result.records) {
      const { id: _id, ...content } = record;
      store.strategyDataSnapshot({
        ...record,
        runId,
        datasetHash: canonicalHash(content),
      });
    }
    runtime.recordMetricRows([
      {
        runId,
        name: "strategy_snapshot_ingested_count",
        value: result.records.length,
        unit: "count",
        asOf: result.asOf,
      },
      {
        runId,
        name: "strategy_stale_snapshot_count",
        value: result.records.filter((record) => record.stale).length,
        unit: "count",
        asOf: result.asOf,
      },
      {
        runId,
        name: "strategy_stale_data_rate",
        value: result.records.length
          ? result.records.filter((record) => record.stale).length /
            result.records.length
          : 0,
        unit: "ratio",
        asOf: result.asOf,
      },
    ]);
    runtime.recordSpan(actor, {
      traceId,
      name: "strategy.market_data.ingest",
      startedAt: ingestStartedAt,
      endedAt: Date.now(),
      attributes: {
        runId,
        symbols,
        snapshotCount: result.records.length,
        staleSnapshotCount: result.records.filter((record) => record.stale)
          .length,
      },
    });
    store.event("strategy.crypto.snapshots.ingested", actor, {
      runId,
      symbols,
      count: result.records.length,
      stale: result.records.filter((record) => record.stale).length,
    });
    return json({ runId, ...result });
  }
  if (
    url.pathname === "/api/strategy/crypto/order-preview" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:strategy-crypto-order-preview`, 20))
      return json({ error: "Crypto order preview rate limit exceeded" }, 429);
    const parsedTicket = CryptoOrderTicket.safeParse(
      await requestJson(request),
    );
    if (!parsedTicket.success)
      return json(
        {
          error:
            parsedTicket.error.issues[0]?.message ??
            "Invalid crypto order ticket",
        },
        400,
      );
    const ticket = parsedTicket.data;
    const [account, positions, recentOrders, latest] = await Promise.all([
      alpaca.trading.account.getAccount(),
      alpaca.trading.positions.getAllOpenPositions(),
      alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
      runtime.latestCryptoOrderMarket(ticket.symbol),
    ]);
    const cash = Number(account.cash);
    if (!Number.isFinite(cash))
      return json({ error: "Account cash data unavailable" }, 502);
    if (recentOrders.length >= 500)
      throw new Error("The complete order window could not be verified");
    if (latest.record.stale) {
      store.event("strategy.crypto.order.preview", actor, {
        symbol: ticket.symbol,
        side: ticket.side,
        type: ticket.type,
        allowed: false,
        reasons: ["stale_data"],
        market: latest.market,
      });
      return json(
        {
          allowed: false,
          reasons: ["stale_data"],
          market: latest.market,
          snapshot: latest.record,
        },
        422,
      );
    }
    const result = buildCryptoOrderPreview({
      ticket,
      market: latest.market,
      cash,
      heldQty: runtime.cryptoPositionQty(positions, ticket.symbol),
    });
    const operationalPolicy = result.allowed
      ? evaluateOperationsPolicy({
          policy: store.operationsPolicy(),
          order: {
            assetClass: "crypto",
            symbol: ticket.symbol,
            side: ticket.side,
            notional: result.preview.estimatedNotional,
          },
          account,
          positions,
          dailyTurnover: rollingTurnover(recentOrders),
        })
      : null;
    store.event("strategy.crypto.order.preview", actor, {
      symbol: ticket.symbol,
      side: ticket.side,
      type: ticket.type,
      allowed: result.allowed && (operationalPolicy?.allowed ?? true),
      reasons: result.allowed
        ? (operationalPolicy?.reasons ?? [])
        : result.reasons,
      operationalPolicy,
      market: latest.market,
    });
    if (!result.allowed)
      return json(
        {
          allowed: false,
          reasons: result.reasons,
          market: result.market,
          snapshot: latest.record,
        },
        422,
      );
    if (operationalPolicy && !operationalPolicy.allowed)
      return blockedOperationsPolicyResponse(operationalPolicy, {
        market: result.market,
        snapshot: latest.record,
      });
    return json({
      allowed: true,
      preview: result.preview,
      operationalPolicy,
      market: result.market,
      snapshot: latest.record,
      previewToken: signCryptoOrderPreview(result.preview, previewSecret),
    });
  }
  if (
    url.pathname === "/api/strategy/crypto/orders" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:strategy-crypto-orders`, 10))
      return json(
        { error: "Crypto order submission rate limit exceeded" },
        429,
      );
    const { previewToken, idempotencyKey } = await requestJson(request);
    if (
      typeof previewToken !== "string" ||
      typeof idempotencyKey !== "string" ||
      !/^[\w-]{8,100}$/.test(idempotencyKey)
    )
      return json(
        {
          error: "Valid crypto preview token and idempotency key are required",
        },
        400,
      );
    const previous = store.submission(idempotencyKey);
    if (previous)
      return previous.pending
        ? json({ error: "Crypto order submission is already processing" }, 409)
        : json(previous);
    if (!store.reserveSubmission(idempotencyKey))
      return json(
        { error: "Crypto order submission is already processing" },
        409,
      );
    let preview!: CryptoOrderPreview;
    let freshPreview!: CryptoOrderPreview;
    let freshMarket!: ReturnType<typeof cryptoOrderMarketFromSnapshot>;
    let freshSnapshot!: Awaited<
      ReturnType<typeof runtime.latestCryptoOrderMarket>
    >["record"];
    let freshOperationalPolicy: OperationsPolicyEvaluation | null = null;
    let riskReserved = false;
    try {
      preview = verifyCryptoOrderPreview(previewToken, previewSecret);
      const ticket = CryptoOrderTicket.parse({
        symbol: preview.symbol,
        side: preview.side,
        type: preview.type,
        amountType: preview.amountType,
        qty: preview.qty,
        notional: preview.notional,
        limitPrice: preview.limitPrice,
        stopPrice: preview.stopPrice,
        timeInForce: preview.timeInForce,
      });
      const [account, positions, recentOrders, latest] = await Promise.all([
        alpaca.trading.account.getAccount(),
        alpaca.trading.positions.getAllOpenPositions(),
        alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
        runtime.latestCryptoOrderMarket(preview.symbol),
      ]);
      const cash = Number(account.cash);
      if (!Number.isFinite(cash))
        throw new Error("Fresh account cash data unavailable");
      if (recentOrders.length >= 500)
        throw new Error("The complete order window could not be verified");
      if (latest.record.stale)
        throw new ClientError(
          "Crypto market data is stale; review the order again",
          409,
        );
      const fresh = buildCryptoOrderPreview({
        ticket,
        market: latest.market,
        cash,
        heldQty: runtime.cryptoPositionQty(positions, preview.symbol),
        maxOrderNotional: preview.maxOrderNotional,
      });
      if (!fresh.allowed) {
        store.releaseSubmission(idempotencyKey);
        return json(
          {
            allowed: false,
            reasons: fresh.reasons,
            market: fresh.market,
            snapshot: latest.record,
          },
          422,
        );
      }
      const brokerPending = await orderRuntime.pendingBrokerOrders(
        recentOrders,
        new Map([[preview.symbol, fresh.preview.referencePrice]]),
      );
      const riskPrice =
        fresh.preview.estimatedNotional / fresh.preview.estimatedQty;
      const reservation = store.reserveRisk<OperationsPolicyEvaluation>(
        idempotencyKey,
        {
          symbol: preview.symbol,
          side: preview.side,
          qty: fresh.preview.estimatedQty,
          price: riskPrice,
        },
        (active) => {
          const brokerIds = new Set(
            brokerPending.map((order) => order.orderId),
          );
          const localPending = active.filter(
            (order) => !order.orderId || !brokerIds.has(order.orderId),
          );
          const operationalPolicy = evaluateOperationsPolicy({
            policy: store.operationsPolicy(),
            order: {
              assetClass: "crypto",
              symbol: preview.symbol,
              side: preview.side,
              notional: fresh.preview.estimatedNotional,
            },
            account,
            positions,
            dailyTurnover: rollingTurnover(recentOrders),
            pendingOrders: [...brokerPending, ...localPending],
          });
          return {
            allowed: operationalPolicy.allowed,
            value: operationalPolicy,
          };
        },
      );
      if (!reservation.reserved) {
        store.releaseSubmission(idempotencyKey);
        if (reservation.reason === "risk")
          return blockedOperationsPolicyResponse(reservation.validation, {
            market: fresh.market,
            snapshot: latest.record,
          });
        return json(
          { error: "Crypto order submission is already processing" },
          409,
        );
      }
      riskReserved = true;
      freshOperationalPolicy = reservation.validation;
      if (
        Math.abs(fresh.preview.referencePrice / preview.referencePrice - 1) >
        0.01
      )
        throw new ClientError(
          "Crypto reference price moved more than 1%; review the order again",
          409,
        );
      freshPreview = fresh.preview;
      freshMarket = fresh.market;
      freshSnapshot = latest.record;
    } catch (error) {
      if (riskReserved) store.finishRiskReservation(idempotencyKey, "released");
      store.releaseSubmission(idempotencyKey);
      if (error instanceof ClientError) throw error;
      if (
        error instanceof Error &&
        [
          "Invalid crypto order preview token",
          "Crypto order preview expired",
        ].includes(error.message)
      )
        throw new ClientError(error.message, 400);
      throw error;
    }
    store.event("strategy.crypto.order.confirmed", actor, {
      symbol: freshPreview.symbol,
      side: freshPreview.side,
      qty: freshPreview.estimatedQty,
      notional: freshPreview.notional,
      type: freshPreview.type,
      estimatedNotional: freshPreview.estimatedNotional,
      operationalPolicy: freshOperationalPolicy,
      idempotencyKey,
    });
    let order;
    try {
      order = await placePreviewedCryptoOrder(
        alpaca,
        freshPreview,
        idempotencyKey,
      );
    } catch (placementError) {
      try {
        order = await alpaca.trading.orders.getOrderByClientOrderId({
          clientOrderId: idempotencyKey,
        });
      } catch {
        store.finishRiskReservation(idempotencyKey, "released");
        store.releaseSubmission(idempotencyKey);
        throw placementError;
      }
    }
    if (!order.id) {
      store.finishRiskReservation(idempotencyKey, "released");
      store.releaseSubmission(idempotencyKey);
      throw new Error("Alpaca returned a crypto order without an id");
    }
    if (!store.markRiskSubmitted(idempotencyKey, order.id))
      console.error("crypto risk reservation transition failed", {
        idempotencyKey,
        orderId: order.id,
      });
    const riskStatus = riskReservationStatusForBrokerStatus(order.status);
    if (riskStatus) store.finishRiskReservation(idempotencyKey, riskStatus);
    const receiptId = crypto.randomUUID();
    const response = { ...managedOrderDto(order), receiptId };
    store.completeSubmission(idempotencyKey, order.id, response);
    store.receipt(receiptId, {
      advisor: actor,
      kind: "crypto_order",
      preview: { ...freshPreview, operationalPolicy: freshOperationalPolicy },
      originalPreview: preview,
      market: freshMarket,
      snapshotId: freshSnapshot.id,
      idempotencyKey,
      orderId: order.id,
      status: order.status,
      createdAt: new Date().toISOString(),
    });
    store.event("strategy.crypto.order.submitted", actor, {
      orderId: order.id,
      receiptId,
      idempotencyKey,
      symbol: freshPreview.symbol,
      side: freshPreview.side,
      type: freshPreview.type,
      status: order.status,
    });
    return json(response);
  }
  if (url.pathname === "/api/strategy/backtests" && request.method === "POST") {
    if (!allow(`${actor}:strategy-backtest`, 20))
      return json({ error: "Strategy backtest rate limit exceeded" }, 429);
    const input = await requestJson(request);
    const strategyId = String(input.strategyId ?? "buy-and-hold");
    let symbols: string[],
      params: Record<string, unknown>,
      timeframe: string,
      days: number,
      strategyPlugin;
    try {
      symbols = runtime.normalizeSymbols(strategyId, input.symbols);
      params = parseStrategyParams(strategyId, input.params ?? {});
      strategyPlugin = strategyPluginFromId(strategyId, params);
      timeframe = parseCryptoTimeframe(input.timeframe);
      days = parseCryptoLookbackDays(input.days);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid backtest input",
        400,
      );
    }
    const initialCash = Number(input.initialCash ?? 10_000),
      feeBps = Number(input.feeBps ?? 0),
      slippageBps = Number(input.slippageBps ?? 5);
    const end = new Date(),
      start = new Date(end.getTime() - days * 86_400_000);
    const symbol = symbols[0]!;
    const providerBars = await alpaca.marketData.getCryptoBars({
      loc: "us",
      symbols,
      timeframe,
      start,
      end,
      limit: 10_000,
    } as any);
    const dataset = cryptoBarsDto({
      symbols,
      timeframe,
      start,
      end,
      bars: providerBars,
    });
    const barsBySymbol = dataset.bars;
    const bars = barsBySymbol[symbol] ?? [];
    const strategy = strategyFunctionFromPlugin(
      strategyPlugin,
      { histories: barsBySymbol },
      symbol,
    );
    const result = runBacktest({
      strategyId,
      bars,
      strategy,
      initialCash,
      feeBps,
      slippageBps,
    });
    const baselines = {
      cash: runBacktest({
        strategyId: "cash",
        bars,
        strategy: strategyFunctionFromPlugin(
          strategyPluginFromId("cash"),
          { histories: barsBySymbol },
          symbol,
        ),
        initialCash,
        feeBps,
        slippageBps,
      }),
      buyAndHold: runBacktest({
        strategyId: "buy-and-hold",
        bars,
        strategy: strategyFunctionFromPlugin(
          strategyPluginFromId("buy-and-hold"),
          { histories: barsBySymbol },
          symbol,
        ),
        initialCash,
        feeBps,
        slippageBps,
      }),
    };
    const trainSize = Number(input.trainSize ?? 0),
      testSize = Number(input.testSize ?? 0);
    const walkForward =
      trainSize && testSize
        ? walkForwardWindows(bars, trainSize, testSize).map((window) => ({
            trainStart: window.trainStart,
            testStart: window.testStart,
            trainBars: window.train.length,
            testBars: window.test.length,
          }))
        : [];
    const definition = runtime.definition(
      symbols,
      strategyId,
      params,
      timeframe,
      days,
    );
    const definitionHash = canonicalHash(definition);
    const provenance = runtime.provenance({
      pluginVersion: strategyPlugin.version,
      policyVersion: STRATEGY_BACKTEST_POLICY_VERSION,
      definitionHash,
      start,
      end,
      timeframe,
      symbols,
      datasetHash: canonicalHash(runtime.withoutAsOf(dataset)),
    });
    const backtestId = crypto.randomUUID();
    const output = {
      source: dataset.source,
      feed: dataset.feed,
      symbol,
      symbols,
      timeframe,
      start: dataset.start,
      end: dataset.end,
      result,
      baselines,
      walkForward,
      asOf: dataset.asOf,
    };
    store.strategyBacktest({
      id: backtestId,
      actor,
      strategyId,
      definitionHash,
      provenance,
      request: {
        ...definition,
        initialCash,
        feeBps,
        slippageBps,
        trainSize,
        testSize,
      },
      result: output,
    });
    store.event("strategy.backtest.completed", actor, {
      backtestId,
      strategyId,
      symbol,
      timeframe,
      days,
      datasetHash: provenance.datasetHash,
      totalReturnPercent: result.totalReturnPercent,
      bars: bars.length,
    });
    return json({ backtestId, provenance, ...output }, 201);
  }
  const strategyBacktestMatch =
    request.method === "GET" &&
    url.pathname.match(/^\/api\/strategy\/backtests\/([^/]+)$/);
  if (strategyBacktestMatch) {
    const backtest = store.getStrategyBacktest(
      decodeURIComponent(strategyBacktestMatch[1]!),
    );
    return backtest && backtest.actor === actor
      ? json(backtest)
      : json({ error: "Strategy backtest not found" }, 404);
  }
  if (url.pathname === "/api/strategy/runs" && request.method === "GET")
    return json({ runs: store.strategyRuns(), asOf: new Date().toISOString() });
  if (url.pathname === "/api/strategy/runs" && request.method === "POST") {
    if (!allow(`${actor}:strategy-runs`, 10))
      return json({ error: "Strategy run rate limit exceeded" }, 429);
    const input = await requestJson(request);
    const strategyId = String(input.strategyId ?? "");
    let symbols: string[],
      params: Record<string, unknown>,
      timeframe: string,
      days: number,
      strategyPlugin;
    try {
      symbols = runtime.normalizeSymbols(strategyId, input.symbols);
      params = parseStrategyParams(strategyId, input.params ?? {});
      strategyPlugin = strategyPluginFromId(strategyId, params);
      timeframe = parseCryptoTimeframe(input.timeframe);
      days = parseCryptoLookbackDays(input.days);
    } catch (error) {
      throw new ClientError(
        error instanceof Error
          ? error.message
          : "Invalid strategy run configuration",
        400,
      );
    }
    let intervalMinutes: number | null;
    try {
      intervalMinutes = parseStrategyIntervalMinutes(
        input.intervalMinutes ?? input.schedule?.intervalMinutes,
      );
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid strategy schedule",
        400,
      );
    }
    const backtestId = String(input.backtestId ?? "").trim();
    if (!backtestId)
      throw new ClientError("A reviewed backtestId is required", 400);
    const backtest = store.getStrategyBacktest(backtestId);
    if (!backtest || backtest.actor !== actor)
      throw new ClientError("Strategy backtest not found", 404);
    if (!backtest.comparable)
      throw new ClientError(
        "Backtests from a dirty working tree cannot seed a comparable strategy run",
        409,
      );
    const definitionHash = canonicalHash(
      runtime.definition(symbols, strategyId, params, timeframe, days),
    );
    if (
      backtest.definitionHash !== definitionHash ||
      backtest.provenance.pluginVersion !== strategyPlugin.version ||
      backtest.provenance.gitCommit !== runtime.codeIdentity.gitCommit ||
      backtest.provenance.featureSchemaVersion !==
        STRATEGY_FEATURE_SCHEMA_VERSION
    )
      throw new ClientError(
        "Strategy run code or configuration does not match the reviewed backtest",
        409,
      );
    const runId = crypto.randomUUID();
    const schedule = intervalMinutes
      ? { enabled: true, intervalMinutes, nextRunAt: new Date().toISOString() }
      : undefined;
    const config = {
      symbols,
      strategyId,
      params,
      timeframe,
      days,
      mode: "shadow",
      backtestId,
      ...(schedule ? { schedule } : {}),
    };
    const configHash = await runtime.configHash(config);
    const provenance = runtime.provenance({
      pluginVersion: strategyPlugin.version,
      policyVersion: "crypto-shadow-v1",
      definitionHash,
      start: new Date(backtest.provenance.query.start),
      end: new Date(backtest.provenance.query.end),
      timeframe,
      symbols,
      datasetHash: backtest.provenance.datasetHash,
    });
    store.createStrategyRun({
      id: runId,
      backtestId,
      strategyId,
      strategyVersion: strategyPlugin.version,
      status: "shadow",
      configHash,
      policyVersion: "crypto-shadow-v1",
      symbols,
      budget: 0,
      config,
      provenance,
      notes: String(input.notes ?? "") || null,
    });
    runtime.recordAudit(
      actor,
      "run_created",
      "strategy_run",
      null,
      store.getStrategyRun(runId),
      {
        mode: "shadow",
        intervalMinutes,
        pluginVersion: strategyPlugin.version,
        backtestId,
        datasetHash: provenance.datasetHash,
      },
    );
    store.event("strategy.run.created", actor, {
      runId,
      backtestId,
      strategyId,
      symbols,
      mode: "shadow",
      intervalMinutes,
      datasetHash: provenance.datasetHash,
    });
    return json({ runId, ...store.getStrategyRun(runId) }, 201);
  }
  if (
    url.pathname === "/api/strategy/scheduler/tick" &&
    request.method === "POST"
  ) {
    if (!allow(`${actor}:strategy-scheduler`, 10))
      return json({ error: "Strategy scheduler rate limit exceeded" }, 429);
    return json(await runtime.evaluateDue(actor));
  }
  const strategyPaperApprovalMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/paper-approval$/,
  );
  if (strategyPaperApprovalMatch && request.method === "POST") {
    if (!allow(`${actor}:strategy-paper-approval`, 5))
      return json(
        { error: "Strategy paper approval rate limit exceeded" },
        429,
      );
    const runId = decodeURIComponent(strategyPaperApprovalMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    if (!["shadow", "paused"].includes(run.status))
      return json(
        {
          error:
            "Only shadow or paused runs can be approved for paper automation",
        },
        409,
      );
    const input = await requestJson(request);
    let approval: StrategyPaperApproval;
    try {
      approval = parseStrategyPaperApproval(input, actor);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid paper approval",
        400,
      );
    }
    const config = {
      ...(run.config as Record<string, unknown>),
      mode: "paper",
      paperApproval: approval,
    };
    const configHash = await runtime.configHash(config);
    if (
      !store.approveStrategyRunPaper(runId, approval.budget, config, configHash)
    )
      return json({ error: "Strategy run could not be approved" }, 409);
    runtime.recordAudit(
      actor,
      "paper_approved",
      "paper_approval",
      run,
      store.getStrategyRun(runId),
      {
        expiresAt: approval.expiresAt,
        budget: approval.budget,
        riskPolicy: approval.riskPolicy,
      },
    );
    store.strategyNote(
      runId,
      actor,
      `Approved paper automation until ${approval.expiresAt} with budget ${approval.budget}.`,
    );
    store.event("strategy.paper.approved", actor, {
      runId,
      approval: { ...approval, approvedBy: actor },
    });
    return json({ runId, ...store.getStrategyRun(runId) });
  }
  const strategyPauseMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/pause$/,
  );
  if (strategyPauseMatch && request.method === "POST") {
    const runId = decodeURIComponent(strategyPauseMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const input = await requestJson(request).catch(() => ({}));
    const reason = String(input.reason ?? "Paused from Strategy Lab").slice(
      0,
      200,
    );
    store.updateStrategyRunStatus(runId, "paused", reason);
    runtime.recordAudit(
      actor,
      "status_changed",
      "strategy_status",
      run,
      store.getStrategyRun(runId),
      { reason, status: "paused" },
    );
    store.strategyNote(runId, actor, reason);
    store.event("strategy.run.paused", actor, { runId, reason });
    return json({ runId, ...store.getStrategyRun(runId) });
  }
  const strategyKillMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/kill$/,
  );
  if (strategyKillMatch && request.method === "POST") {
    const runId = decodeURIComponent(strategyKillMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const input = await requestJson(request).catch(() => ({}));
    const reason = String(
      input.reason ?? "Kill switch activated from Strategy Lab",
    ).slice(0, 200);
    const config = {
      ...(run.config as Record<string, unknown>),
      paperApproval: {
        ...((run.config as { paperApproval?: Record<string, unknown> })
          .paperApproval ?? {}),
        killSwitch: { activatedAt: new Date().toISOString(), reason },
      },
    };
    store.updateStrategyRunConfig(
      runId,
      config,
      await runtime.configHash(config),
    );
    store.updateStrategyRunStatus(runId, "retired", reason);
    runtime.recordAudit(
      actor,
      "kill_switch",
      "strategy_config",
      run,
      store.getStrategyRun(runId),
      { reason, status: "retired" },
    );
    store.strategyNote(runId, actor, reason);
    store.event("strategy.run.kill_switch", actor, { runId, reason });
    return json({ runId, ...store.getStrategyRun(runId) });
  }
  const strategyReviewMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/review$/,
  );
  if (strategyReviewMatch && request.method === "POST") {
    if (!allow(`${actor}:strategy-review`, 10))
      return json({ error: "Strategy review rate limit exceeded" }, 429);
    const runId = decodeURIComponent(strategyReviewMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const input = await requestJson(request);
    let parsed: ReturnType<typeof parseStrategyReview>;
    try {
      parsed = parseStrategyReview(input, actor, run.status);
    } catch (error) {
      throw new ClientError(
        error instanceof Error ? error.message : "Invalid strategy review",
        400,
      );
    }
    let config = withStrategyReviewConfig(run.config, parsed.review);
    if (parsed.action === "retire") {
      const approval =
        config.paperApproval &&
        typeof config.paperApproval === "object" &&
        !Array.isArray(config.paperApproval)
          ? config.paperApproval
          : {};
      config = {
        ...config,
        paperApproval: {
          ...approval,
          killSwitch: {
            activatedAt: parsed.review.reviewedAt,
            reason: parsed.note,
          },
        },
      };
    }
    store.updateStrategyRunConfig(
      runId,
      config,
      await runtime.configHash(config),
    );
    store.updateStrategyRunStatus(
      runId,
      parsed.status,
      `${parsed.action}: ${parsed.note}`,
    );
    runtime.recordAudit(
      actor,
      "reviewed",
      "strategy_review",
      run,
      store.getStrategyRun(runId),
      { action: parsed.action, status: parsed.status, note: parsed.note },
    );
    store.strategyNote(
      runId,
      actor,
      `${parsed.action.toUpperCase()}: ${parsed.note}`,
    );
    store.event("strategy.run.reviewed", actor, {
      runId,
      action: parsed.action,
      status: parsed.status,
    });
    return json({ runId, ...store.getStrategyRun(runId) });
  }
  const strategyReportMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/report$/,
  );
  if (strategyReportMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyReportMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const orders = await runtime.reconcileOrders(runId);
    const decisions = store.strategyDecisions(runId, 500);
    const traces = decisions
      .map((decision) => store.getStrategyDecisionTrace(decision.traceId))
      .filter(Boolean);
    const attribution = await runtime.buildAttribution(run, orders);
    const performance = await runtime.buildPerformance(run, orders);
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
  const strategyAuditMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/audit$/,
  );
  if (strategyAuditMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyAuditMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json({
      runId,
      auditTrail: store.strategyAuditTrail(runId),
      verification: store.verifyStrategyAuditTrail(runId),
      asOf: new Date().toISOString(),
    });
  }
  const strategyDashboardMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/dashboard$/,
  );
  if (strategyDashboardMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyDashboardMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    const orders = await runtime.reconcileOrders(runId);
    const decisions = store.strategyDecisions(runId, 500);
    const traces = decisions
      .map((decision) => store.getStrategyDecisionTrace(decision.traceId))
      .filter(Boolean);
    return json(
      buildStrategyDashboard({
        run,
        decisions,
        traces: traces as any[],
        orders,
      }),
    );
  }
  const strategyAttributionMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/attribution$/,
  );
  if (strategyAttributionMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyAttributionMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json(
      await runtime.buildAttribution(run, await runtime.reconcileOrders(runId)),
    );
  }
  const strategyPerformanceMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/performance$/,
  );
  if (strategyPerformanceMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyPerformanceMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json(
      await runtime.buildPerformance(run, await runtime.reconcileOrders(runId)),
    );
  }
  const strategyAlertsMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/alerts$/,
  );
  if (strategyAlertsMatch && request.method === "GET") {
    const runId = decodeURIComponent(strategyAlertsMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json(await runtime.buildAlerts(run));
  }
  const strategyRunDecisionMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/decisions$/,
  );
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
    return json({
      runId,
      filters,
      decisions: store.strategyDecisions(runId, limit, filters),
      asOf: new Date().toISOString(),
    });
  }
  const strategyRunTickMatch = url.pathname.match(
    /^\/api\/strategy\/runs\/([^/]+)\/tick$/,
  );
  if (strategyRunTickMatch && request.method === "POST") {
    if (!allow(`${actor}:strategy-tick`, 30))
      return json({ error: "Strategy tick rate limit exceeded" }, 429);
    const runId = decodeURIComponent(strategyRunTickMatch[1]!);
    const run = store.getStrategyRun(runId);
    if (!run) return json({ error: "Strategy run not found" }, 404);
    return json(await runtime.evaluateRun(run, actor, "manual"));
  }
  const strategyTraceMatch = url.pathname.match(
    /^\/api\/strategy\/decision-traces\/([^/]+)$/,
  );
  if (strategyTraceMatch && request.method === "GET") {
    const trace = store.getStrategyDecisionTrace(
      decodeURIComponent(strategyTraceMatch[1]!),
    );
    return trace
      ? json(trace)
      : json({ error: "Strategy decision trace not found" }, 404);
  }

  return null;
}
