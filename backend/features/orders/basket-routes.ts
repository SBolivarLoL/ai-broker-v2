import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { ClientError, json, requestJson } from "../../http/http";
import type { createStore } from "../../persistence/store";
import { orderSessionGuidance } from "../markets/market-workspace";
import {
  evaluateOperationsPolicy,
  type OperationsPolicyEvaluation,
} from "../operations/operations-policy";
import { riskSnapshot, rollingTurnover } from "../portfolio/risk";
import { liquidityPreview } from "./order-ticket";
import {
  RebalanceBasket,
  signRebalanceBasketPreview,
  simulateRebalanceBasket,
  verifyRebalanceBasketPreview,
} from "./rebalance-basket";
import type { createOrderRuntime } from "./runtime";

type Store = ReturnType<typeof createStore>;
type OrderRuntime = ReturnType<typeof createOrderRuntime>;
type RateLimit = (key: string, maximum: number) => boolean;

type BasketRouteDependencies = {
  alpaca: Alpaca;
  store: Store;
  runtime: OrderRuntime;
  allow: RateLimit;
  previewSecret: string;
  getMarketClock: () => Promise<any>;
};

/** Handles atomic basket previews and independent paper-broker leg submissions. */
export function createBasketRoutes({
  alpaca,
  store,
  runtime,
  allow,
  previewSecret,
  getMarketClock,
}: BasketRouteDependencies) {
  return async function handleBasketRequest(
    request: Request,
    url: URL,
    actor: string,
  ): Promise<Response | null> {
    if (!url.pathname.startsWith("/api/orders/basket")) return null;

    if (
      url.pathname === "/api/orders/basket/preview" &&
      request.method === "POST"
    ) {
      if (!allow(`${actor}:orders`, 30))
        return json({ error: "Order rate limit exceeded" }, 429);
      const parsedBasket = RebalanceBasket.safeParse(
        await requestJson(request),
      );
      if (!parsedBasket.success)
        return json(
          {
            error:
              parsedBasket.error.issues[0]?.message ??
              "Invalid rebalance basket",
          },
          400,
        );
      const basket = parsedBasket.data;
      const [account, positions, recentOrders, clock, marketLegs] =
        await Promise.all([
          alpaca.trading.account.getAccount(),
          alpaca.trading.positions.getAllOpenPositions(),
          alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
          getMarketClock(),
          Promise.all(
            basket.legs.map(async (leg) => {
              const [asset, price, marketSnapshot] = await Promise.all([
                alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
                  symbolOrAssetId: leg.symbol,
                }),
                alpaca.marketData.getLatestPrice(leg.symbol),
                alpaca.marketData.stocks.stockSnapshotSingle({
                  symbol: leg.symbol,
                  feed: "iex",
                }),
              ]);
              return { ...leg, asset, price, marketSnapshot };
            }),
          ),
        ]);
      if (account.equity === undefined || account.cash === undefined)
        throw new Error("Account risk data unavailable");
      if (recentOrders.length >= 500)
        throw new Error("The complete order window could not be verified");
      for (const leg of marketLegs) {
        if (!leg.asset.tradable || leg.asset._class !== "us_equity")
          return json(
            { error: `${leg.symbol} is not a tradable US stock or ETF` },
            400,
          );
        if (
          typeof leg.price !== "number" ||
          !Number.isFinite(leg.price) ||
          leg.price <= 0
        )
          return json(
            { error: `No valid current price for ${leg.symbol}` },
            400,
          );
        if (!leg.asset.fractionable && !Number.isInteger(leg.qty))
          return json(
            { error: `${leg.symbol} does not support fractional orders` },
            400,
          );
      }
      const pricedLegs = marketLegs.map(({ symbol, side, qty, price }) => ({
        symbol,
        side,
        qty,
        price: price as number,
      }));
      const brokerPending = await runtime.pendingBrokerOrders(
        recentOrders,
        new Map(pricedLegs.map((leg) => [leg.symbol, leg.price])),
      );
      const simulation = simulateRebalanceBasket({
        snapshot: riskSnapshot(account.equity, account.cash, positions),
        positions,
        legs: pricedLegs,
        dailyTurnover: rollingTurnover(recentOrders),
        pendingOrders: brokerPending,
      });
      const dailyTurnover = rollingTurnover(recentOrders);
      const operationalPolicies = pricedLegs.map((leg, index) =>
        evaluateOperationsPolicy({
          policy: store.operationsPolicy(),
          order: {
            assetClass: "basket",
            symbol: leg.symbol,
            side: leg.side,
            qty: leg.qty,
            price: leg.price,
          },
          account,
          positions,
          dailyTurnover,
          pendingOrders: [
            ...brokerPending,
            ...pricedLegs.filter((_, legIndex) => legIndex !== index),
          ],
        }),
      );
      const liquidity = marketLegs.map((leg) => ({
        symbol: leg.symbol,
        ...liquidityPreview(
          leg.marketSnapshot,
          leg.qty,
          leg.price as number,
          "market",
        ),
      }));
      store.event("order.basket.preview", actor, {
        legs: pricedLegs,
        simulation,
        operationalPolicies,
        liquidity,
      });
      if (!simulation.allowed)
        return json({ allowed: false, simulation, liquidity }, 422);
      if (operationalPolicies.some((policy) => !policy.allowed))
        return json(
          {
            allowed: false,
            simulation,
            operationalPolicies,
            reasons: [
              ...new Set(
                operationalPolicies.flatMap((policy) => policy.reasons),
              ),
            ],
            runbook: [
              ...new Set(
                operationalPolicies.flatMap((policy) => policy.runbook),
              ),
            ],
            liquidity,
          },
          422,
        );
      const expiresAt = Date.now() + 120_000;
      return json({
        allowed: true,
        simulation,
        operationalPolicies,
        liquidity,
        session: orderSessionGuidance(clock),
        expiresAt,
        previewToken: signRebalanceBasketPreview(
          { legs: pricedLegs, timeInForce: basket.timeInForce, expiresAt },
          previewSecret,
        ),
      });
    }
    if (url.pathname === "/api/orders/basket" && request.method === "POST") {
      if (!allow(`${actor}:orders`, 30))
        return json({ error: "Order rate limit exceeded" }, 429);
      const { previewToken, idempotencyKey } = await requestJson(request);
      if (
        typeof previewToken !== "string" ||
        typeof idempotencyKey !== "string" ||
        !/^[\w-]{8,80}$/.test(idempotencyKey)
      )
        return json(
          {
            error:
              "Valid basket preview token and idempotency key are required",
          },
          400,
        );
      const previous = store.submission(idempotencyKey);
      if (previous)
        return previous.pending
          ? json({ error: "Basket submission is already processing" }, 409)
          : json(previous, previous.status === "partial" ? 207 : 200);
      if (!store.reserveSubmission(idempotencyKey))
        return json({ error: "Basket submission is already processing" }, 409);
      let preview;
      let freshLegs: {
        symbol: string;
        side: "buy" | "sell";
        qty: number;
        price: number;
      }[] = [];
      let reservationKeys: string[] = [];
      let freshSimulation;
      let freshOperationalPolicies: OperationsPolicyEvaluation[] = [];
      try {
        preview = verifyRebalanceBasketPreview(previewToken, previewSecret);
        const [account, positions, recentOrders, checkedLegs] =
          await Promise.all([
            alpaca.trading.account.getAccount(),
            alpaca.trading.positions.getAllOpenPositions(),
            alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
            Promise.all(
              preview.legs.map(async (leg) => {
                const [asset, price] = await Promise.all([
                  alpaca.trading.assets.getV2AssetsSymbolOrAssetId({
                    symbolOrAssetId: leg.symbol,
                  }),
                  alpaca.marketData.getLatestPrice(leg.symbol),
                ]);
                if (!asset.tradable || asset._class !== "us_equity")
                  throw new ClientError(
                    `${leg.symbol} is no longer tradable`,
                    409,
                  );
                if (
                  typeof price !== "number" ||
                  !Number.isFinite(price) ||
                  price <= 0
                )
                  throw new Error(`Fresh price unavailable for ${leg.symbol}`);
                if (!asset.fractionable && !Number.isInteger(leg.qty))
                  throw new ClientError(
                    `${leg.symbol} no longer supports this fractional order`,
                    409,
                  );
                if (Math.abs(price / leg.price - 1) > 0.01)
                  throw new ClientError(
                    `${leg.symbol} moved more than 1%; review the basket again`,
                    409,
                  );
                return {
                  symbol: leg.symbol,
                  side: leg.side,
                  qty: leg.qty,
                  price,
                };
              }),
            ),
          ]);
        if (account.equity === undefined || account.cash === undefined)
          throw new Error("Account risk data unavailable");
        if (recentOrders.length >= 500)
          throw new Error("The complete order window could not be verified");
        freshLegs = checkedLegs;
        const brokerPending = await runtime.pendingBrokerOrders(
          recentOrders,
          new Map(freshLegs.map((leg) => [leg.symbol, leg.price])),
        );
        const dailyTurnover = rollingTurnover(recentOrders);
        freshOperationalPolicies = freshLegs.map((leg, index) =>
          evaluateOperationsPolicy({
            policy: store.operationsPolicy(),
            order: {
              assetClass: "basket",
              symbol: leg.symbol,
              side: leg.side,
              qty: leg.qty,
              price: leg.price,
            },
            account,
            positions,
            dailyTurnover,
            pendingOrders: [
              ...brokerPending,
              ...freshLegs.filter((_, legIndex) => legIndex !== index),
            ],
          }),
        );
        if (freshOperationalPolicies.some((policy) => !policy.allowed)) {
          store.releaseSubmission(idempotencyKey);
          return json(
            {
              allowed: false,
              operationalPolicies: freshOperationalPolicies,
              reasons: [
                ...new Set(
                  freshOperationalPolicies.flatMap((policy) => policy.reasons),
                ),
              ],
              runbook: [
                ...new Set(
                  freshOperationalPolicies.flatMap((policy) => policy.runbook),
                ),
              ],
            },
            422,
          );
        }
        const reservation = store.reserveRiskBasket(
          idempotencyKey,
          freshLegs,
          (active) => {
            const brokerIds = new Set(
              brokerPending.map((order) => order.orderId),
            );
            const localPending = active.filter(
              (order) => !order.orderId || !brokerIds.has(order.orderId),
            );
            const simulation = simulateRebalanceBasket({
              snapshot: riskSnapshot(account.equity!, account.cash!, positions),
              positions,
              legs: freshLegs,
              dailyTurnover: rollingTurnover(recentOrders),
              pendingOrders: [...brokerPending, ...localPending],
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
          return json(
            { error: "Basket submission is already processing" },
            409,
          );
        }
        reservationKeys = reservation.keys;
        freshSimulation = reservation.validation;
      } catch (error) {
        store.releaseSubmission(idempotencyKey);
        if (error instanceof ClientError) throw error;
        if (
          error instanceof Error &&
          ["Invalid basket preview token", "Basket preview expired"].includes(
            error.message,
          )
        )
          throw new ClientError(error.message, 400);
        throw error;
      }
      store.event("order.basket.confirmed", actor, {
        legs: freshLegs,
        simulation: freshSimulation,
        operationalPolicies: freshOperationalPolicies,
        idempotencyKey,
      });
      const results: {
        symbol: string;
        side: "buy" | "sell";
        qty: number;
        orderId: string | null;
        status: string;
        error?: string;
      }[] = [];
      for (let index = 0; index < freshLegs.length; index++) {
        const leg = freshLegs[index]!,
          clientOrderId = `${idempotencyKey.slice(0, 40)}-${index}`;
        try {
          let order;
          try {
            order = await alpaca.trading.orders.market({
              symbol: leg.symbol,
              side: leg.side,
              qty: leg.qty,
              timeInForce: preview.timeInForce,
              clientOrderId,
            });
          } catch (placementError) {
            try {
              order = await alpaca.trading.orders.getOrderByClientOrderId({
                clientOrderId,
              });
            } catch {
              throw placementError;
            }
          }
          if (!order.id)
            throw new Error("Alpaca returned an order without an id");
          store.markRiskSubmitted(reservationKeys[index]!, order.id);
          if (order.status === "filled")
            store.finishRiskReservation(reservationKeys[index]!, "filled");
          else if (order.status === "rejected")
            store.finishRiskReservation(reservationKeys[index]!, "rejected");
          runtime.tracker.update(order);
          results.push({
            symbol: leg.symbol,
            side: leg.side,
            qty: leg.qty,
            orderId: order.id,
            status: String(order.status),
          });
        } catch (error) {
          store.finishRiskReservation(reservationKeys[index]!, "released");
          console.error("basket broker submission failed", {
            symbol: leg.symbol,
            error: error instanceof Error ? error.message : String(error),
          });
          results.push({
            symbol: leg.symbol,
            side: leg.side,
            qty: leg.qty,
            orderId: null,
            status: "not_submitted",
            error: "Broker submission failed",
          });
          for (
            let remaining = index + 1;
            remaining < reservationKeys.length;
            remaining++
          )
            store.finishRiskReservation(
              reservationKeys[remaining]!,
              "released",
            );
          break;
        }
      }
      const receiptId = crypto.randomUUID(),
        completed =
          results.length === freshLegs.length &&
          results.every((result) => result.orderId);
      const response = {
        status: completed ? "submitted" : "partial",
        results,
        receiptId,
        warning:
          "Basket legs are independent broker orders and may fill or fail separately.",
      };
      store.completeSubmission(idempotencyKey, `basket:${receiptId}`, response);
      store.receipt(receiptId, {
        advisor: actor,
        kind: "rebalance_basket",
        preview: {
          ...preview,
          legs: freshLegs,
          simulation: freshSimulation,
          operationalPolicies: freshOperationalPolicies,
        },
        idempotencyKey,
        orderIds: results.flatMap((result) =>
          result.orderId ? [result.orderId] : [],
        ),
        status: response.status,
        results,
        createdAt: new Date().toISOString(),
      });
      store.event("order.basket.submitted", actor, {
        receiptId,
        idempotencyKey,
        status: response.status,
        results,
      });
      return json(response, completed ? 200 : 207);
    }
    return null;
  };
}
