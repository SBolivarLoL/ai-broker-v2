import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { ClientError, json, requestJson } from "../../http/http";
import {
  evaluateOperationsPolicy,
  type OperationsPolicyEvaluation,
} from "../../shared/operations-policy";
import { blockedOperationsPolicyResponse } from "../../shared/policy-response";
import {
  buildCryptoOrderPreview,
  cryptoOrderMarketFromSnapshot,
  CryptoOrderTicket,
  signCryptoOrderPreview,
  verifyCryptoOrderPreview,
  type CryptoOrderPreview,
} from "../orders/crypto-order-ticket";
import { managedOrderDto } from "../orders/order-management";
import { rollingTurnover } from "../../shared/risk";
import { riskReservationStatusForBrokerStatus } from "../../shared/broker-status";
import {
  cryptoBarsDto,
  cryptoSnapshotDto,
  parseCryptoLookbackDays,
  parseCryptoSymbols,
  parseCryptoTimeframe,
} from "./crypto-strategy-data";
import { canonicalHash } from "./strategy-provenance";
import type { StrategyRouteContext } from "./strategy-route-context";

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

/** Owns crypto market-data ingest and the signed-preview paper-execution pipeline. */
export async function handleStrategyExecutionRequest(
  request: Request,
  url: URL,
  context: StrategyRouteContext,
): Promise<Response | null> {
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

  return null;
}
