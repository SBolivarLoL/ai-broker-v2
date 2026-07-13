import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import {
  ClientError,
  conflict,
  conflictResponse,
  json,
  requestJson,
} from "../../http/http";
import type { createStore } from "../../persistence/store";
import {
  evaluateOperationsPolicy,
  type OperationsPolicyEvaluation,
} from "../../shared/operations-policy";
import { blockedOperationsPolicyResponse } from "../../shared/policy-response";
import { rollingTurnover } from "../../shared/risk";
import { managedOrderDto } from "./order-management";
import {
  OptionOrderTicket,
  optionOrderRisk,
  signOptionOrderPreview,
  signOptionPositionAction,
  verifyOptionOrderPreview,
  verifyOptionPositionAction,
} from "./option-order";
import {
  OptionChainQuery,
  optionChainDto,
  optionPortfolioGreeks,
} from "./options-workspace";
import type { createOrderRuntime } from "./runtime";

type Store = ReturnType<typeof createStore>;
type OrderRuntime = ReturnType<typeof createOrderRuntime>;
type RateLimit = (key: string, maximum: number) => boolean;

type OptionRouteDependencies = {
  alpaca: Alpaca;
  store: Store;
  runtime: OrderRuntime;
  allow: RateLimit;
  previewSecret: string;
};
type OptionChainSource = {
  contracts: any[];
  snapshots: Record<string, any>;
  underlyingPrice: number;
  account: any;
  expirations: string[];
  retrievedAt: string;
};

/** Handles option discovery, position actions, previews, and submissions. */
export function createOptionRoutes({
  alpaca,
  store,
  runtime,
  allow,
  previewSecret,
}: OptionRouteDependencies) {
  const optionChainCache = new Map<
    string,
    {
      expiresAt: number;
      source: OptionChainSource;
    }
  >();

  return async function handleOptionRequest(
    request: Request,
    url: URL,
    actor: string,
  ): Promise<Response | null> {
    if (!url.pathname.startsWith("/api/options/")) return null;

    if (url.pathname === "/api/options/chain" && request.method === "GET") {
      const parsed = OptionChainQuery.safeParse({
        symbol: url.searchParams.get("symbol"),
        expiration: url.searchParams.get("expiration") || undefined,
      });
      if (!parsed.success)
        return json(
          {
            error:
              parsed.error.issues[0]?.message ?? "Invalid option chain query",
          },
          400,
        );
      const cacheKey = `${parsed.data.symbol}:${parsed.data.expiration ?? "nearest"}`,
        cached = optionChainCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const source = cached.source;
        const value = optionChainDto(
          source.contracts,
          source.snapshots,
          source.underlyingPrice,
          source.account,
          source.retrievedAt,
          new Date(),
        );
        value.expirations = source.expirations;
        return json(value);
      }
      const start = new Date(),
        end = new Date(Date.now() + 60 * 86_400_000);
      const [account, underlyingPrice, contractResponse] = await Promise.all([
        alpaca.trading.account.getAccount(),
        alpaca.marketData.getLatestPrice(parsed.data.symbol),
        alpaca.trading.assets.getOptionsContracts({
          underlyingSymbols: parsed.data.symbol,
          status: "active",
          expirationDateGte: start,
          expirationDateLte: end,
          limit: 500,
        }),
      ]);
      if (
        typeof underlyingPrice !== "number" ||
        !Number.isFinite(underlyingPrice) ||
        underlyingPrice <= 0
      )
        return json({ error: "No valid underlying price" }, 400);
      const allContracts = contractResponse.optionContracts ?? [];
      const expirations = [
        ...new Set(
          allContracts.map((contract) =>
            new Date(contract.expirationDate).toISOString().slice(0, 10),
          ),
        ),
      ].sort();
      const expiration = parsed.data.expiration ?? expirations[0];
      if (!expiration || !expirations.includes(expiration))
        return json(
          {
            error:
              "No active option contracts are available for that expiration",
          },
          404,
        );
      const contracts = allContracts.filter(
        (contract) =>
          new Date(contract.expirationDate).toISOString().slice(0, 10) ===
          expiration,
      );
      const chainResponse = await alpaca.marketData.options.optionChain({
        underlyingSymbol: parsed.data.symbol,
        expirationDate: new Date(`${expiration}T00:00:00Z`),
        limit: 500,
      });
      const retrievedAt = new Date().toISOString();
      const value = optionChainDto(
        contracts,
        chainResponse.snapshots ?? {},
        underlyingPrice,
        account,
        retrievedAt,
        retrievedAt,
      );
      value.expirations = expirations;
      optionChainCache.set(cacheKey, {
        expiresAt: Date.now() + 30_000,
        source: {
          contracts,
          snapshots: chainResponse.snapshots ?? {},
          underlyingPrice,
          account,
          expirations,
          retrievedAt,
        },
      });
      return json(value);
    }
    if (url.pathname === "/api/options/portfolio" && request.method === "GET") {
      const positions = (await alpaca.trading.positions.getAllOpenPositions())
        .filter((position) => position.assetClass === "us_option")
        .slice(0, 50);
      if (!positions.length) {
        const retrievedAt = new Date().toISOString();
        return json(
          optionPortfolioGreeks([], {}, [], {}, retrievedAt, retrievedAt),
        );
      }
      const symbols = positions.map((position) => String(position.symbol));
      const [snapshotResponse, contracts] = await Promise.all([
        alpaca.marketData.options.optionSnapshots({
          symbols: symbols.join(","),
        }),
        Promise.all(
          symbols.map((symbol) =>
            alpaca.trading.assets.getOptionContractSymbolOrId({
              symbolOrId: symbol,
            }),
          ),
        ),
      ]);
      const underlyings = [
        ...new Set(
          contracts.map((contract) => String(contract.underlyingSymbol)),
        ),
      ];
      const underlyingPrices = Object.fromEntries(
        await Promise.all(
          underlyings.map(async (symbol) => [
            symbol,
            await alpaca.marketData.getLatestPrice(symbol),
          ]),
        ),
      );
      const retrievedAt = new Date().toISOString();
      return json(
        optionPortfolioGreeks(
          positions,
          snapshotResponse.snapshots ?? {},
          contracts,
          underlyingPrices,
          retrievedAt,
          retrievedAt,
        ),
      );
    }
    const optionActionPreviewMatch =
      request.method === "GET" &&
      url.pathname.match(
        /^\/api\/options\/positions\/([^/]+)\/action-preview$/,
      );
    if (optionActionPreviewMatch) {
      const symbol = decodeURIComponent(optionActionPreviewMatch[1]!),
        action = url.searchParams.get("action");
      if (!["exercise", "do_not_exercise"].includes(action ?? ""))
        return json({ error: "Valid option action is required" }, 400);
      const [position, contract] = await Promise.all([
        alpaca.trading.positions.getOpenPosition({ symbolOrAssetId: symbol }),
        alpaca.trading.assets.getOptionContractSymbolOrId({
          symbolOrId: symbol,
        }),
      ]);
      const qty = Number(position.qty),
        strike = Number(contract.strikePrice),
        multiplier = Number(contract.multiplier);
      if (!(qty > 0) || ![qty, strike, multiplier].every(Number.isFinite))
        return json(
          { error: "Only exact long option positions can use this workflow" },
          400,
        );
      const expiresAt = Date.now() + 60_000,
        preview = {
          symbol,
          action: action as "exercise" | "do_not_exercise",
          qty,
          strike,
          multiplier,
          optionType: contract.type,
          expiration: new Date(contract.expirationDate)
            .toISOString()
            .slice(0, 10),
          exerciseCost:
            contract.type === "call" ? strike * multiplier * qty : 0,
          expiresAt,
        };
      return json({
        preview,
        previewToken: signOptionPositionAction(preview, previewSecret),
      });
    }
    const optionActionMatch =
      request.method === "POST" &&
      url.pathname.match(/^\/api\/options\/positions\/([^/]+)\/action$/);
    if (optionActionMatch) {
      const symbol = decodeURIComponent(optionActionMatch[1]!),
        { previewToken } = await requestJson(request);
      if (typeof previewToken !== "string")
        return json({ error: "Option action preview token is required" }, 400);
      let preview;
      try {
        preview = verifyOptionPositionAction(previewToken, previewSecret);
      } catch (error) {
        throw new ClientError(
          error instanceof Error
            ? error.message
            : "Invalid option action token",
          400,
        );
      }
      if (preview.symbol !== symbol)
        return conflictResponse(
          "Option position changed after preview",
          "option_position_changed",
          true,
          "refresh_preview",
        );
      const position = await alpaca.trading.positions.getOpenPosition({
        symbolOrAssetId: symbol,
      });
      if (Number(position.qty) !== preview.qty)
        return conflictResponse(
          "Option position quantity changed after preview",
          "option_position_changed",
          true,
          "refresh_preview",
        );
      if (preview.action === "exercise")
        await alpaca.trading.positions.optionExercise({
          symbolOrContractId: symbol,
        });
      else
        await alpaca.trading.positions.optionDoNotExercise({
          symbolOrContractId: symbol,
        });
      store.event(`option.position.${preview.action}`, actor, preview);
      return json({
        accepted: true,
        action: preview.action,
        symbol,
        qty: preview.qty,
      });
    }
    if (
      url.pathname === "/api/options/orders/preview" &&
      request.method === "POST"
    ) {
      if (!allow(`${actor}:orders`, 30))
        return json({ error: "Order rate limit exceeded" }, 429);
      const parsed = OptionOrderTicket.safeParse(await requestJson(request));
      if (!parsed.success)
        return json(
          { error: parsed.error.issues[0]?.message ?? "Invalid option ticket" },
          400,
        );
      const ticket = parsed.data,
        symbols = ticket.legs.map((leg) => leg.symbol);
      const [account, positions, recentOrders, marketData] = await Promise.all([
        alpaca.trading.account.getAccount(),
        alpaca.trading.positions.getAllOpenPositions(),
        alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
        runtime.optionOrderMarketData(symbols),
      ]);
      const requiredLevel = ticket.kind === "vertical" ? 3 : 2;
      if (Number(account.optionsTradingLevel ?? 0) < requiredLevel)
        return json(
          { error: `Options trading level ${requiredLevel} is required` },
          400,
        );
      const risk = optionOrderRisk(
        ticket,
        marketData.contracts,
        marketData.snapshots,
      );
      const equity = Number(account.equity),
        buyingPower = Number(account.optionsBuyingPower ?? 0),
        maxOrderRisk = Math.min(2_500, equity * 0.025);
      if (!Number.isFinite(equity) || !Number.isFinite(buyingPower))
        throw new Error("Option risk data is unavailable");
      if (recentOrders.length >= 500)
        throw new Error("The complete order window could not be verified");
      if (risk.maxLoss > maxOrderRisk || risk.maxLoss > buyingPower)
        return json(
          {
            error: `Maximum option loss exceeds the $${maxOrderRisk.toFixed(2)} order-risk or buying-power limit`,
          },
          422,
        );
      const operationalPolicy = evaluateOperationsPolicy({
        policy: store.operationsPolicy(),
        order: {
          assetClass: "option",
          symbol: risk.legs[0]?.underlying ?? risk.legs[0]?.symbol ?? "OPTIONS",
          side: "buy",
          notional: risk.maxLoss,
        },
        account,
        positions,
        dailyTurnover: rollingTurnover(recentOrders),
      });
      if (!operationalPolicy.allowed)
        return blockedOperationsPolicyResponse(operationalPolicy, {
          referenceDebit: risk.referenceDebit,
        });
      const expiresAt = Date.now() + 120_000;
      const preview = {
        kind: ticket.kind,
        legs: risk.legs,
        qty: ticket.qty,
        type: ticket.type,
        limitPrice: ticket.limitPrice,
        maxLoss: risk.maxLoss,
        maxProfit: risk.maxProfit,
        exerciseCost: risk.exerciseCost,
        assignmentNotional: risk.assignmentNotional,
        expiresAt,
      };
      store.event("option.order.preview", actor, {
        preview,
        operationalPolicy,
        referenceDebit: risk.referenceDebit,
      });
      return json({
        allowed: true,
        preview,
        operationalPolicy,
        referenceDebit: risk.referenceDebit,
        previewToken: signOptionOrderPreview(preview, previewSecret),
      });
    }
    if (url.pathname === "/api/options/orders" && request.method === "POST") {
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
              "Valid option preview token and idempotency key are required",
          },
          400,
        );
      const previous = store.submission(idempotencyKey);
      if (previous)
        return previous.pending
          ? conflictResponse(
              "Option order is already processing",
              "submission_in_progress",
              true,
              "wait_for_submission",
            )
          : json(previous);
      if (!store.reserveSubmission(idempotencyKey))
        return conflictResponse(
          "Option order is already processing",
          "submission_in_progress",
          true,
          "wait_for_submission",
        );
      let preview,
        reservation,
        operationalPolicy: OperationsPolicyEvaluation | null = null;
      try {
        preview = verifyOptionOrderPreview(previewToken, previewSecret);
        const ticket = OptionOrderTicket.parse({
          kind: preview.kind,
          legs: preview.legs.map((leg) => ({
            symbol: leg.symbol,
            side: leg.side,
            positionIntent: leg.positionIntent,
          })),
          qty: preview.qty,
          type: preview.type,
          limitPrice: preview.limitPrice,
        });
        const [account, positions, recentOrders, marketData] =
          await Promise.all([
            alpaca.trading.account.getAccount(),
            alpaca.trading.positions.getAllOpenPositions(),
            alpaca.trading.orders.getAllOrders({ status: "all", limit: 500 }),
            runtime.optionOrderMarketData(ticket.legs.map((leg) => leg.symbol)),
          ]);
        const requiredLevel = ticket.kind === "vertical" ? 3 : 2;
        if (Number(account.optionsTradingLevel ?? 0) < requiredLevel)
          throw conflict(
            "Options permission changed; review the order again",
            "account_capability_changed",
            true,
            "refresh_preview",
          );
        const freshRisk = optionOrderRisk(
            ticket,
            marketData.contracts,
            marketData.snapshots,
          ),
          equity = Number(account.equity),
          buyingPower = Number(account.optionsBuyingPower ?? 0),
          maxOrderRisk = Math.min(2_500, equity * 0.025);
        if (recentOrders.length >= 500)
          throw new Error("The complete order window could not be verified");
        if (
          ticket.type === "market" &&
          freshRisk.maxLoss > preview.maxLoss * 1.1
        )
          throw conflict(
            "Option ask moved more than 10%; review the order again",
            "market_price_changed",
            true,
            "refresh_preview",
          );
        if (freshRisk.maxLoss > maxOrderRisk || freshRisk.maxLoss > buyingPower)
          throw conflict(
            "Option risk or buying power changed; review the order again",
            "account_state_changed",
            true,
            "refresh_preview",
          );
        operationalPolicy = evaluateOperationsPolicy({
          policy: store.operationsPolicy(),
          order: {
            assetClass: "option",
            symbol:
              freshRisk.legs[0]?.underlying ??
              freshRisk.legs[0]?.symbol ??
              "OPTIONS",
            side: "buy",
            notional: freshRisk.maxLoss,
          },
          account,
          positions,
          dailyTurnover: rollingTurnover(recentOrders),
        });
        if (!operationalPolicy.allowed) {
          store.releaseSubmission(idempotencyKey);
          return blockedOperationsPolicyResponse(operationalPolicy, {
            referenceDebit: freshRisk.referenceDebit,
          });
        }
        reservation = store.reserveRisk(
          idempotencyKey,
          {
            symbol: "OPTIONS_RISK",
            side: "buy",
            qty: 1,
            price: freshRisk.maxLoss,
          },
          (active) => {
            const reserved = active
              .filter((item) => item.symbol === "OPTIONS_RISK")
              .reduce((sum, item) => sum + item.qty * item.price, 0);
            const allowed =
              reserved + freshRisk.maxLoss <=
              Math.min(buyingPower, equity * 0.05);
            return {
              allowed,
              value: {
                ...freshRisk,
                portfolioReservedRisk: reserved + freshRisk.maxLoss,
              },
            };
          },
        );
        if (!reservation.reserved) {
          store.releaseSubmission(idempotencyKey);
          if (reservation.reason === "risk")
            return json(
              {
                error: "Concurrent option risk exceeds the 5% portfolio cap",
                risk: reservation.validation,
              },
              422,
            );
          return conflictResponse(
            "Option order is already processing",
            "submission_in_progress",
            true,
            "wait_for_submission",
          );
        }
      } catch (error) {
        store.releaseSubmission(idempotencyKey);
        if (error instanceof ClientError) throw error;
        if (
          error instanceof Error &&
          ["Invalid option preview token", "Option preview expired"].includes(
            error.message,
          )
        )
          throw new ClientError(error.message, 400);
        throw error;
      }
      let order;
      try {
        if (preview.kind === "single") {
          const leg = preview.legs[0]!,
            common = {
              symbol: leg.symbol,
              side: "buy" as const,
              qty: preview.qty,
              timeInForce: "day" as const,
              positionIntent: "buy_to_open" as const,
              clientOrderId: idempotencyKey,
            };
          order =
            preview.type === "market"
              ? await alpaca.trading.orders.market(common)
              : await alpaca.trading.orders.limit({
                  ...common,
                  limitPrice: preview.limitPrice!,
                });
        } else {
          order = await alpaca.trading.orders.submit({
            type: "limit",
            orderClass: "mleg",
            qty: preview.qty,
            limitPrice: preview.limitPrice!,
            timeInForce: "day",
            clientOrderId: idempotencyKey,
            legs: preview.legs.map((leg) => ({
              symbol: leg.symbol,
              side: leg.side,
              positionIntent: leg.positionIntent,
              ratioQty: "1",
            })),
          });
        }
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
        throw new Error("Alpaca returned an option order without an id");
      }
      store.markRiskSubmitted(idempotencyKey, order.id);
      if (order.status === "filled")
        store.finishRiskReservation(idempotencyKey, "filled");
      else if (order.status === "rejected")
        store.finishRiskReservation(idempotencyKey, "rejected");
      runtime.tracker.update(order);
      const receiptId = crypto.randomUUID(),
        response = { ...managedOrderDto(order), receiptId };
      store.completeSubmission(idempotencyKey, order.id, response);
      store.receipt(receiptId, {
        advisor: actor,
        kind: "option_order",
        preview: {
          ...preview,
          risk: reservation.validation,
          operationalPolicy,
        },
        idempotencyKey,
        orderId: order.id,
        status: order.status,
        createdAt: new Date().toISOString(),
      });
      store.event("option.order.submitted", actor, {
        orderId: order.id,
        receiptId,
        kind: preview.kind,
        operationalPolicy,
      });
      return json(response);
    }
    return null;
  };
}
