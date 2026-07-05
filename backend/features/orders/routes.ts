import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { ClientError, json, requestJson } from "../../http/http";
import type { createStore } from "../../persistence/store";
import {
  buildReplacementPreview,
  canCancelOrder,
  managedOrderDto,
  ReplacementInput,
  signCancelAllPreview,
  signReplacementPreview,
  verifyCancelAllPreview,
  verifyReplacementPreview,
} from "./order-management";
import { createBasketRoutes } from "./basket-routes";
import { createEquityRoutes } from "./equity-routes";
import { createOptionRoutes } from "./options-routes";
import type { createOrderRuntime } from "./runtime";

type Store = ReturnType<typeof createStore>;
type OrderRuntime = ReturnType<typeof createOrderRuntime>;
type RateLimit = (key: string, maximum: number) => boolean;

type OrderRouteDependencies = {
  alpaca: Alpaca;
  store: Store;
  runtime: OrderRuntime;
  allow: RateLimit;
  previewSecret: string;
  getMarketClock: () => Promise<any>;
};

/** Builds order-management, receipt, and audit routes and composes execution routes. */
export function createOrderRoutes({
  alpaca,
  store,
  runtime,
  allow,
  previewSecret,
  getMarketClock,
}: OrderRouteDependencies) {
  const optionRoutes = createOptionRoutes({
    alpaca,
    store,
    runtime,
    allow,
    previewSecret,
  });
  const basketRoutes = createBasketRoutes({
    alpaca,
    store,
    runtime,
    allow,
    previewSecret,
    getMarketClock,
  });
  const equityRoutes = createEquityRoutes({
    alpaca,
    store,
    runtime,
    allow,
    previewSecret,
    getMarketClock,
  });

  return async function handleOrderRequest(
    request: Request,
    url: URL,
    actor: string,
  ): Promise<Response | null> {
    const optionResponse = await optionRoutes(request, url, actor);
    if (optionResponse) return optionResponse;
    const basketResponse = await basketRoutes(request, url, actor);
    if (basketResponse) return basketResponse;
    const equityResponse = await equityRoutes(request, url, actor);
    if (equityResponse) return equityResponse;

    if (
      !url.pathname.startsWith("/api/orders") &&
      !url.pathname.startsWith("/api/receipts") &&
      url.pathname !== "/api/decision-audit"
    ) {
      return null;
    }
    if (url.pathname === "/api/orders" && request.method === "GET") {
      const status = url.searchParams.get("status") ?? "all";
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (
        !["open", "closed", "all"].includes(status) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        return json(
          {
            error:
              "Status must be open, closed, or all and limit must be 1 to 100",
          },
          400,
        );
      await runtime.recover();
      const orders = runtime.tracker.list(
        status as "open" | "closed" | "all",
        limit,
      );
      return json({
        status,
        orders: orders.map(managedOrderDto),
        sync: runtime.tracker.metadata(),
        asOf: new Date().toISOString(),
      });
    }
    if (
      url.pathname === "/api/orders/cancel-all-preview" &&
      request.method === "GET"
    ) {
      const orders = (
        await alpaca.trading.orders.getAllOrders({
          status: "open",
          limit: 100,
          nested: true,
        })
      ).filter((order) => order.id && canCancelOrder(order.status));
      if (!orders.length)
        return json({ error: "There are no cancelable working orders" }, 409);
      const expiresAt = Date.now() + 60_000,
        orderIds = orders.map((order) => order.id!);
      return json({
        orders: orders.map(managedOrderDto),
        expiresAt,
        previewToken: signCancelAllPreview(
          { orderIds, expiresAt },
          previewSecret,
        ),
      });
    }
    if (url.pathname === "/api/orders" && request.method === "DELETE") {
      if (!allow(`${actor}:order-cancel-all`, 5))
        return json({ error: "Cancel-all rate limit exceeded" }, 429);
      const { previewToken } = await requestJson(request);
      if (typeof previewToken !== "string")
        return json({ error: "A cancel-all preview token is required" }, 400);
      let preview;
      try {
        preview = verifyCancelAllPreview(previewToken, previewSecret);
      } catch (error) {
        throw new ClientError(
          error instanceof Error ? error.message : "Invalid cancel-all preview",
          400,
        );
      }
      const results = await Promise.all(
        preview.orderIds.map(async (orderId) => {
          try {
            const order = await alpaca.trading.orders.getOrderByOrderID({
              orderId,
              nested: true,
            });
            if (!canCancelOrder(order.status))
              return {
                orderId,
                status: "not_cancelable",
                brokerStatus: order.status,
              };
            await alpaca.trading.orders.deleteOrderByOrderID({ orderId });
            return { orderId, status: "cancel_requested" };
          } catch {
            return { orderId, status: "state_changed" };
          }
        }),
      );
      store.event("orders.cancel_all.requested", actor, {
        reviewedOrderIds: preview.orderIds,
        results,
      });
      return json({ results, requestedAt: new Date().toISOString() }, 202);
    }
    const cancelOrderMatch =
      request.method === "DELETE" &&
      url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/i);
    if (cancelOrderMatch) {
      if (!allow(`${actor}:order-cancel`, 20))
        return json({ error: "Order cancellation rate limit exceeded" }, 429);
      const orderId = cancelOrderMatch[1]!;
      const order = await alpaca.trading.orders.getOrderByOrderID({
        orderId,
        nested: true,
      });
      if (!order.id || !canCancelOrder(order.status))
        return json(
          {
            error: `Order is no longer cancelable (${order.status ?? "unknown"})`,
          },
          409,
        );
      try {
        await alpaca.trading.orders.deleteOrderByOrderID({ orderId });
      } catch {
        throw new ClientError(
          "Alpaca could not accept the cancellation because the order state changed. Refresh the blotter.",
          409,
        );
      }
      store.event("order.cancel.requested", actor, {
        orderId,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        priorStatus: order.status,
      });
      return json(
        {
          orderId,
          status: "cancel_requested",
          requestedAt: new Date().toISOString(),
        },
        202,
      );
    }
    const replacementPreviewMatch =
      request.method === "POST" &&
      url.pathname.match(
        /^\/api\/orders\/([0-9a-f-]{36})\/replacement-preview$/i,
      );
    if (replacementPreviewMatch) {
      if (!allow(`${actor}:order-replace`, 20))
        return json({ error: "Order replacement rate limit exceeded" }, 429);
      const body = await requestJson(request);
      const replacement = ReplacementInput.safeParse({
        qty: Number(body.qty),
        limitPrice: body.limitPrice === null ? null : Number(body.limitPrice),
        stopPrice: body.stopPrice === null ? null : Number(body.stopPrice),
      });
      if (!replacement.success)
        return json(
          {
            error:
              "Valid whole-share quantity and required prices are required",
          },
          400,
        );
      const order = await alpaca.trading.orders.getOrderByOrderID({
        orderId: replacementPreviewMatch[1]!,
        nested: true,
      });
      let preview;
      try {
        preview = buildReplacementPreview(
          order,
          replacement.data,
          Date.now() + 120_000,
        );
      } catch (error) {
        throw new ClientError(
          error instanceof Error ? error.message : "Invalid replacement",
          422,
        );
      }
      store.event("order.replace.preview", actor, {
        orderId: order.id,
        symbol: order.symbol,
        original: preview.original,
        replacement: preview.replacement,
      });
      return json({
        preview,
        previewToken: signReplacementPreview(preview, previewSecret),
      });
    }
    const replaceOrderMatch =
      request.method === "PATCH" &&
      url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/i);
    if (replaceOrderMatch) {
      if (!allow(`${actor}:order-replace`, 20))
        return json({ error: "Order replacement rate limit exceeded" }, 429);
      const { previewToken, idempotencyKey } = await requestJson(request);
      if (
        typeof previewToken !== "string" ||
        typeof idempotencyKey !== "string" ||
        !/^[\w-]{8,100}$/.test(idempotencyKey)
      )
        return json(
          {
            error: "Valid replacement preview and idempotency key are required",
          },
          400,
        );
      const previous = store.submission(idempotencyKey);
      if (previous)
        return previous.pending
          ? json({ error: "Replacement is already processing" }, 409)
          : json(previous);
      let preview;
      try {
        preview = verifyReplacementPreview(previewToken, previewSecret);
      } catch (error) {
        throw new ClientError(
          error instanceof Error
            ? error.message
            : "Invalid replacement preview",
          400,
        );
      }
      if (preview.orderId !== replaceOrderMatch[1])
        return json(
          { error: "Replacement preview does not match this order" },
          400,
        );
      if (!store.reserveSubmission(idempotencyKey))
        return json({ error: "Replacement is already processing" }, 409);
      try {
        const order = await alpaca.trading.orders.getOrderByOrderID({
          orderId: preview.orderId,
          nested: true,
        });
        if (
          (order.updatedAt?.toISOString() ?? null) !== preview.expectedUpdatedAt
        )
          throw new ClientError(
            "The order changed after preview. Refresh and review the replacement again.",
            409,
          );
        buildReplacementPreview(order, preview.replacement, preview.expiresAt);
        let replaced;
        try {
          replaced = await alpaca.trading.orders.patchOrderByOrderId({
            orderId: preview.orderId,
            patchOrderRequest: {
              qty: String(preview.replacement.qty),
              limitPrice:
                preview.replacement.limitPrice === null
                  ? undefined
                  : String(preview.replacement.limitPrice),
              stopPrice:
                preview.replacement.stopPrice === null
                  ? undefined
                  : String(preview.replacement.stopPrice),
              clientOrderId: idempotencyKey,
            },
          });
        } catch (replacementError) {
          try {
            replaced = await alpaca.trading.orders.getOrderByClientOrderId({
              clientOrderId: idempotencyKey,
            });
          } catch {
            throw replacementError;
          }
        }
        if (!replaced.id)
          throw new Error("Alpaca returned a replacement without an id");
        runtime.tracker.update(replaced);
        runtime.reconcile(replaced);
        const response = {
          ...managedOrderDto(replaced),
          replacedOrderId: preview.orderId,
        };
        store.completeSubmission(idempotencyKey, replaced.id, response);
        store.event("order.replace.submitted", actor, {
          orderId: preview.orderId,
          replacementOrderId: replaced.id,
          symbol: preview.symbol,
          replacement: preview.replacement,
        });
        return json(response);
      } catch (error) {
        store.releaseSubmission(idempotencyKey);
        if (error instanceof ClientError) throw error;
        throw new ClientError(
          "Alpaca could not replace the order because its state changed. Refresh the blotter.",
          409,
        );
      }
    }
    const receiptAuditMatch =
      request.method === "GET" &&
      url.pathname.match(/^\/api\/receipts\/([^/]+)\/audit$/);
    if (receiptAuditMatch) {
      const receiptId = decodeURIComponent(receiptAuditMatch[1]!);
      const receipt = store.getReceipt(receiptId);
      if (!receipt) return json({ error: "Receipt not found" }, 404);
      return json({
        receiptId,
        auditTrail: store.decisionAuditTrail(receiptId),
        verification: store.verifyDecisionAuditTrail(),
        asOf: new Date().toISOString(),
      });
    }
    if (url.pathname === "/api/decision-audit" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
        return json(
          { error: "Decision audit limit must be between 1 and 1000" },
          400,
        );
      return json({
        auditTrail: store.decisionAuditTrail(undefined, limit),
        verification: store.verifyDecisionAuditTrail(),
        asOf: new Date().toISOString(),
      });
    }
    if (url.pathname.startsWith("/api/receipts/") && request.method === "GET") {
      const receipt = store.getReceipt(url.pathname.split("/").pop() ?? "");
      return receipt
        ? json(receipt)
        : json({ error: "Receipt not found" }, 404);
    }
    if (url.pathname === "/api/receipts" && request.method === "GET")
      return json(store.receipts());

    return null;
  };
}
