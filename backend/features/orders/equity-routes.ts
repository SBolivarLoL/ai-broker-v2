import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { ClientError, json, requestJson } from "../../http/http";
import type { createStore } from "../../persistence/store";
import { orderSessionGuidance } from "../markets/market-workspace";
import {
  evaluateOperationsPolicy,
  type OperationsPolicyEvaluation,
} from "../operations/operations-policy";
import { blockedOperationsPolicyResponse } from "../operations/policy-response";
import {
  riskSnapshot,
  rollingTurnover,
  simulateTrade,
} from "../portfolio/risk";
import {
  auctionSubmissionError,
  linkedOrderError,
  liquidityPreview,
  OrderTicket,
  ticketQuantity,
  ticketRiskPrice,
} from "./order-ticket";
import { managedOrderDto } from "./order-management";
import { signPreview, verifyPreviewFresh, type Preview } from "./orders";
import type { createOrderRuntime } from "./runtime";

type Store = ReturnType<typeof createStore>;
type OrderRuntime = ReturnType<typeof createOrderRuntime>;
type RateLimit = (key: string, maximum: number) => boolean;

type EquityRouteDependencies = {
  alpaca: Alpaca;
  store: Store;
  runtime: OrderRuntime;
  allow: RateLimit;
  previewSecret: string;
  getMarketClock: () => Promise<any>;
};

function shortCapabilityError(account: any, asset: any) {
  if (!account.shortingEnabled || Number(account.multiplier ?? 1) <= 1) {
    return "This paper account is not enabled for margin short selling";
  }
  if (!asset.shortable || !asset.easyToBorrow || !asset.marginable) {
    return "This asset is not currently marginable and easy-to-borrow for a paper short";
  }
  return null;
}

/** Handles signed equity previews and fresh-state paper submissions. */
export function createEquityRoutes({
  alpaca,
  store,
  runtime,
  allow,
  previewSecret,
  getMarketClock,
}: EquityRouteDependencies) {
  return async function handleEquityRequest(
    request: Request,
    url: URL,
    actor: string,
  ): Promise<Response | null> {
    if (
      url.pathname !== "/api/orders" &&
      url.pathname !== "/api/orders/preview"
    ) {
      return null;
    }

    if (url.pathname === "/api/orders/preview" && request.method === "POST") {
      if (!allow(`${actor}:orders`, 30))
        return json({ error: "Order rate limit exceeded" }, 429);
      const parsedTicket = OrderTicket.safeParse(await requestJson(request));
      if (!parsedTicket.success)
        return json(
          {
            error:
              parsedTicket.error.issues[0]?.message ?? "Invalid order ticket",
          },
          400,
        );
      const ticket = parsedTicket.data;
      const { symbol, side, planId } = ticket;
      const auctionError = auctionSubmissionError(ticket.timeInForce);
      if (auctionError) return json({ error: auctionError }, 400);
      if (
        planId !== undefined &&
        (typeof planId !== "string" || !store.getPlan(planId))
      )
        return json({ error: "Valid stored plan id is required" }, 400);
      const [
        account,
        positions,
        asset,
        price,
        recentOrders,
        clock,
        marketSnapshot,
      ] = await Promise.all([
        alpaca.trading.account.getAccount(),
        alpaca.trading.positions.getAllOpenPositions(),
        alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
          symbolOrAssetId: symbol,
        }),
        alpaca.marketData.getLatestPrice(symbol),
        alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
        getMarketClock(),
        alpaca.marketData.stocks.stockSnapshotSingle({ symbol, feed: "iex" }),
      ]);
      if (!asset.tradable || asset._class !== "us_equity")
        return json(
          { error: "Only tradable US stocks and ETFs are supported" },
          400,
        );
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0)
        return json({ error: "No valid current price" }, 400);
      if (account.equity === undefined || account.cash === undefined)
        return json({ error: "Account risk data unavailable" }, 502);
      const qty = ticketQuantity(ticket, price);
      if (!asset.fractionable && !Number.isInteger(qty))
        return json(
          {
            error:
              "This asset does not support fractional or dollar-notional orders",
          },
          400,
        );
      const shortError = ticket.allowShort
        ? shortCapabilityError(account, asset)
        : null;
      if (shortError) return json({ error: shortError }, 400);
      const linkedError = linkedOrderError(ticket, price);
      if (linkedError) return json({ error: linkedError }, 400);
      const riskPrice = ticketRiskPrice(ticket, price);
      const simulation = simulateTrade({
        snapshot: riskSnapshot(account.equity, account.cash, positions),
        positions,
        symbol,
        side,
        qty,
        price: riskPrice,
        dailyTurnover: rollingTurnover(recentOrders),
        allowShort: ticket.allowShort,
      });
      const operationalPolicy = evaluateOperationsPolicy({
        policy: store.operationsPolicy(),
        order: { assetClass: "equity", symbol, side, qty, price: riskPrice },
        account,
        positions,
        dailyTurnover: rollingTurnover(recentOrders),
      });
      const liquidity = liquidityPreview(
        marketSnapshot,
        qty,
        price,
        ticket.type,
      );
      store.event("order.preview", actor, {
        symbol,
        side,
        qty,
        type: ticket.type,
        simulation,
        operationalPolicy,
        liquidity,
      });
      if (!simulation.allowed)
        return json({ allowed: false, simulation, liquidity }, 422);
      if (!operationalPolicy.allowed)
        return blockedOperationsPolicyResponse(operationalPolicy, {
          simulation,
          liquidity,
        });
      const expiresAt = Date.now() + 120_000;
      const preview: Preview = {
        symbol,
        side,
        qty,
        ...(ticket.notional ? { notional: ticket.notional } : {}),
        amountType: ticket.amountType,
        type: ticket.type,
        orderClass: ticket.orderClass,
        limitPrice: ticket.limitPrice,
        stopPrice: ticket.stopPrice,
        trailPercent: ticket.trailPercent,
        takeProfitPrice: ticket.takeProfitPrice,
        stopLossPrice: ticket.stopLossPrice,
        stopLossLimitPrice: ticket.stopLossLimitPrice,
        timeInForce: ticket.timeInForce,
        extendedHours: ticket.extendedHours,
        allowShort: ticket.allowShort,
        price,
        expiresAt,
        ...(planId ? { planId } : {}),
        simulation,
      };
      return json({
        allowed: true,
        simulation,
        operationalPolicy,
        liquidity,
        session: orderSessionGuidance(clock),
        order: {
          type: ticket.type,
          orderClass: ticket.orderClass,
          amountType: ticket.amountType,
          qty,
          notional: ticket.notional ?? null,
          limitPrice: ticket.limitPrice,
          stopPrice: ticket.stopPrice,
          trailPercent: ticket.trailPercent,
          takeProfitPrice: ticket.takeProfitPrice,
          stopLossPrice: ticket.stopLossPrice,
          stopLossLimitPrice: ticket.stopLossLimitPrice,
          timeInForce: ticket.timeInForce,
          extendedHours: ticket.extendedHours,
          allowShort: ticket.allowShort,
        },
        expiresAt,
        previewToken: signPreview(preview, previewSecret),
      });
    }
    if (url.pathname === "/api/orders" && request.method === "POST") {
      if (!allow(`${actor}:orders`, 30))
        return json({ error: "Order rate limit exceeded" }, 429);
      const { previewToken, idempotencyKey } = await requestJson(request);
      if (
        typeof previewToken !== "string" ||
        typeof idempotencyKey !== "string" ||
        !/^[\w-]{8,100}$/.test(idempotencyKey)
      )
        return json(
          { error: "Valid preview token and idempotency key are required" },
          400,
        );
      const previous = store.submission(idempotencyKey);
      if (previous)
        return previous.pending
          ? json({ error: "Order submission is already processing" }, 409)
          : json(previous);
      if (!store.reserveSubmission(idempotencyKey))
        return json({ error: "Order submission is already processing" }, 409);
      let preview: Preview;
      let freshPrice = 0;
      let freshQty = 0;
      let freshRiskPrice = 0;
      let freshSimulation;
      let freshOperationalPolicy: OperationsPolicyEvaluation | null = null;
      try {
        const fresh = await verifyPreviewFresh(
          previewToken,
          previewSecret,
          async (intent) => {
            const auctionError = auctionSubmissionError(intent.timeInForce);
            if (auctionError)
              throw new ClientError(
                `${auctionError}; review the order again`,
                409,
              );
            const [account, positions, asset, price, recentOrders] =
              await Promise.all([
                alpaca.trading.account.getAccount(),
                alpaca.trading.positions.getAllOpenPositions(),
                alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
                  symbolOrAssetId: intent.symbol,
                }),
                alpaca.marketData.getLatestPrice(intent.symbol),
                alpaca.trading.orders.getAllOrders({
                  status: "all",
                  limit: 500,
                }),
              ]);
            if (!asset.tradable || asset._class !== "us_equity")
              throw new ClientError("The asset is no longer tradable", 409);
            if (
              account.equity === undefined ||
              account.cash === undefined ||
              typeof price !== "number" ||
              !Number.isFinite(price) ||
              price <= 0
            )
              throw new Error("Fresh trade validation data is unavailable");
            const qty =
              intent.amountType === "notional"
                ? intent.notional! / price
                : intent.qty;
            if (!asset.fractionable && !Number.isInteger(qty))
              throw new ClientError(
                "This asset does not support fractional or dollar-notional orders",
                409,
              );
            const shortError = intent.allowShort
              ? shortCapabilityError(account, asset)
              : null;
            if (shortError)
              throw new ClientError(
                `${shortError}; review the order again`,
                409,
              );
            if (recentOrders.length >= 500)
              throw new Error(
                "The complete order window could not be verified",
              );
            if (Math.abs(price / intent.price - 1) > 0.01)
              throw new ClientError(
                "The price moved more than 1%; review the order again",
                409,
              );
            const linkedError = linkedOrderError(intent, price);
            if (linkedError)
              throw new ClientError(
                `${linkedError}; review the linked order again`,
                409,
              );
            const brokerPending = await runtime.pendingBrokerOrders(
              recentOrders,
              new Map([[intent.symbol, price]]),
            );
            const riskPrice = ticketRiskPrice(intent, price);
            const operationalPolicy = evaluateOperationsPolicy({
              policy: store.operationsPolicy(),
              order: {
                assetClass: "equity",
                symbol: intent.symbol,
                side: intent.side,
                qty,
                price: riskPrice,
              },
              account,
              positions,
              dailyTurnover: rollingTurnover(recentOrders),
              pendingOrders: brokerPending,
            });
            return {
              account,
              positions,
              price,
              qty,
              riskPrice,
              recentOrders,
              brokerPending,
              operationalPolicy,
            };
          },
        );
        preview = fresh.preview;
        freshPrice = fresh.validation.price;
        freshQty = fresh.validation.qty;
        freshRiskPrice = fresh.validation.riskPrice;
        freshOperationalPolicy = fresh.validation.operationalPolicy;
        if (!freshOperationalPolicy.allowed) {
          store.releaseSubmission(idempotencyKey);
          return blockedOperationsPolicyResponse(freshOperationalPolicy);
        }
        const reservation = store.reserveRisk(
          idempotencyKey,
          {
            symbol: preview.symbol,
            side: preview.side,
            qty: freshQty,
            price: freshRiskPrice,
          },
          (active) => {
            const brokerIds = new Set(
              fresh.validation.brokerPending.map((order) => order.orderId),
            );
            const localPending = active.filter(
              (order) => !order.orderId || !brokerIds.has(order.orderId),
            );
            const simulation = simulateTrade({
              snapshot: riskSnapshot(
                Number(fresh.validation.account.equity),
                Number(fresh.validation.account.cash),
                fresh.validation.positions,
              ),
              positions: fresh.validation.positions,
              symbol: preview.symbol,
              side: preview.side,
              qty: freshQty,
              price: freshRiskPrice,
              dailyTurnover: rollingTurnover(fresh.validation.recentOrders),
              pendingOrders: [
                ...fresh.validation.brokerPending,
                ...localPending,
              ],
              allowShort: preview.allowShort,
            });
            return { allowed: simulation.allowed, value: simulation };
          },
        );
        if (!reservation.reserved) {
          store.releaseSubmission(idempotencyKey);
          if (reservation.reason === "risk")
            return json(
              { allowed: false, simulation: reservation.validation },
              422,
            );
          return json({ error: "Order submission is already processing" }, 409);
        }
        freshSimulation = reservation.validation;
      } catch (error) {
        store.releaseSubmission(idempotencyKey);
        if (error instanceof ClientError) throw error;
        if (
          error instanceof Error &&
          ["Invalid preview token", "Preview expired"].includes(error.message)
        )
          throw new ClientError(error.message, 400);
        throw error;
      }
      store.event("order.confirmed", actor, {
        symbol: preview.symbol,
        side: preview.side,
        qty: freshQty,
        notional: preview.notional,
        type: preview.type,
        price: freshPrice,
        riskPrice: freshRiskPrice,
        simulation: freshSimulation,
        operationalPolicy: freshOperationalPolicy,
        idempotencyKey,
      });
      // Alpaca also enforces this key, covering a lost response after acceptance.
      let order;
      try {
        order = await runtime.placePreviewedOrder(preview, idempotencyKey);
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
        throw new Error("Alpaca returned an order without an id");
      }
      if (!store.markRiskSubmitted(idempotencyKey, order.id))
        console.error("risk reservation transition failed", {
          idempotencyKey,
          orderId: order.id,
        });
      if (order.status === "filled")
        store.finishRiskReservation(idempotencyKey, "filled");
      else if (order.status === "rejected")
        store.finishRiskReservation(idempotencyKey, "rejected");
      const receiptId = crypto.randomUUID();
      const response = { ...managedOrderDto(order), receiptId };
      store.completeSubmission(idempotencyKey, order.id, response);
      store.receipt(receiptId, {
        advisor: actor,
        plan: preview.planId ? store.getPlan(preview.planId) : null,
        preview: {
          ...preview,
          qty: freshQty,
          price: freshPrice,
          simulation: freshSimulation,
          operationalPolicy: freshOperationalPolicy,
        },
        idempotencyKey,
        orderId: order.id,
        status: order.status,
        createdAt: new Date().toISOString(),
      });
      store.event("order.submitted", actor, {
        orderId: order.id,
        receiptId,
        idempotencyKey,
        type: preview.type,
      });
      return json(response);
    }
    return null;
  };
}
