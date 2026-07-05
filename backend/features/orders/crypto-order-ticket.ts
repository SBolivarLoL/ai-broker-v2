import { z } from "zod";
import { signToken, verifyToken } from "./orders";

export const CRYPTO_ORDER_SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"] as const;
export const CRYPTO_ORDER_MAX_NOTIONAL = 2_500;

const cryptoSymbol = z.preprocess(
  (value) =>
    String(value ?? "")
      .trim()
      .toUpperCase(),
  z.enum(CRYPTO_ORDER_SYMBOLS),
);
const positiveNumber = z.coerce.number().positive().finite();
const optionalPositive = z.preprocess(
  (value) =>
    value === "" || value === null || value === undefined ? undefined : value,
  positiveNumber.optional(),
);
const nullablePositive = z
  .preprocess(
    (value) =>
      value === "" || value === null || value === undefined ? null : value,
    positiveNumber.nullable(),
  )
  .default(null);

export const CryptoOrderTicket = z
  .object({
    symbol: cryptoSymbol,
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit", "stop_limit"]).default("market"),
    amountType: z.enum(["notional", "quantity"]).default("notional"),
    qty: optionalPositive,
    notional: optionalPositive,
    limitPrice: nullablePositive,
    stopPrice: nullablePositive,
    timeInForce: z.enum(["gtc", "ioc"]).default("gtc"),
  })
  .superRefine((ticket, context) => {
    if (ticket.amountType === "quantity" && !ticket.qty)
      context.addIssue({
        code: "custom",
        message: "A positive crypto quantity is required",
      });
    if (ticket.amountType === "notional" && !ticket.notional)
      context.addIssue({
        code: "custom",
        message: "A positive dollar amount is required",
      });
    if (
      ticket.amountType === "notional" &&
      (ticket.side !== "buy" || ticket.type !== "market")
    )
      context.addIssue({
        code: "custom",
        message: "Dollar-notional crypto orders are limited to market buys",
      });
    if (ticket.type !== "market" && ticket.amountType !== "quantity")
      context.addIssue({
        code: "custom",
        message: "Limit and stop-limit crypto orders require a quantity",
      });
    if (ticket.type === "limit" && !ticket.limitPrice)
      context.addIssue({
        code: "custom",
        message: "A limit price is required",
      });
    if (
      ticket.type === "stop_limit" &&
      (!ticket.stopPrice || !ticket.limitPrice)
    )
      context.addIssue({
        code: "custom",
        message: "Stop and limit prices are required",
      });
  });
export type CryptoOrderTicket = z.infer<typeof CryptoOrderTicket>;

export const CryptoOrderPreview = z
  .object({
    symbol: cryptoSymbol,
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit", "stop_limit"]),
    amountType: z.enum(["notional", "quantity"]),
    qty: z.number().positive().finite().optional(),
    notional: z.number().positive().finite().optional(),
    limitPrice: z.number().positive().finite().nullable().default(null),
    stopPrice: z.number().positive().finite().nullable().default(null),
    timeInForce: z.enum(["gtc", "ioc"]),
    referencePrice: z.number().positive().finite(),
    spreadBps: z.number().nonnegative().finite().nullable(),
    estimatedQty: z.number().positive().finite(),
    estimatedNotional: z.number().positive().finite(),
    maxOrderNotional: z.number().positive().finite(),
    warnings: z.array(z.string()),
    expiresAt: z.number().int(),
  })
  .superRefine((preview, context) => {
    if (
      preview.amountType === "notional" &&
      (preview.side !== "buy" || preview.type !== "market" || !preview.notional)
    )
      context.addIssue({
        code: "custom",
        message: "Dollar-notional crypto previews must be market buys",
      });
    if (preview.amountType === "quantity" && !preview.qty)
      context.addIssue({
        code: "custom",
        message: "Crypto quantity is required",
      });
    if (preview.type === "limit" && !preview.limitPrice)
      context.addIssue({ code: "custom", message: "Limit price is required" });
    if (
      preview.type === "stop_limit" &&
      (!preview.limitPrice || !preview.stopPrice)
    )
      context.addIssue({
        code: "custom",
        message: "Stop and limit prices are required",
      });
  });
export type CryptoOrderPreview = z.infer<typeof CryptoOrderPreview>;

export type CryptoOrderMarket = {
  bid: number | null;
  ask: number | null;
  referencePrice: number | null;
  spreadBps: number | null;
};

const finitePositive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export function cryptoOrderMarketFromSnapshot(payload: any): CryptoOrderMarket {
  const bestBid = finitePositive(
    payload?.quote?.bid ??
      payload?.latestQuote?.bp ??
      payload?.orderbook?.b?.[0]?.p,
  );
  const bestAsk = finitePositive(
    payload?.quote?.ask ??
      payload?.latestQuote?.ap ??
      payload?.orderbook?.a?.[0]?.p,
  );
  const midpoint =
    bestBid !== null && bestAsk !== null && bestAsk >= bestBid
      ? (bestBid + bestAsk) / 2
      : null;
  const spreadBps =
    midpoint !== null ? ((bestAsk! - bestBid!) / midpoint) * 10_000 : null;
  const tradePrice = finitePositive(
    payload?.trade?.price ?? payload?.latestTrade?.p,
  );
  const barClose = finitePositive(
    payload?.bar?.close ?? payload?.latestBar?.c ?? payload?.minuteBar?.c,
  );
  return {
    bid: bestBid,
    ask: bestAsk,
    referencePrice: midpoint ?? tradePrice ?? barClose,
    spreadBps,
  };
}

export function buildCryptoOrderPreview(input: {
  ticket: CryptoOrderTicket;
  market: CryptoOrderMarket;
  cash: number;
  heldQty: number;
  maxOrderNotional?: number;
  maxMarketSpreadBps?: number;
  now?: number;
}) {
  const maxOrderNotional = input.maxOrderNotional ?? CRYPTO_ORDER_MAX_NOTIONAL;
  const maxMarketSpreadBps = input.maxMarketSpreadBps ?? 200;
  const referencePrice = input.market.referencePrice;
  const priceBasis =
    input.ticket.type === "market" ? referencePrice : input.ticket.limitPrice;
  const reasons: string[] = [];
  if (
    referencePrice === null ||
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0
  )
    reasons.push("invalid_reference_price");
  if (input.ticket.type === "market") {
    if (
      input.market.spreadBps === null ||
      !Number.isFinite(input.market.spreadBps)
    )
      reasons.push("spread_unavailable");
    else if (input.market.spreadBps > maxMarketSpreadBps)
      reasons.push("spread_limit");
  }
  if (priceBasis === null || !Number.isFinite(priceBasis) || priceBasis <= 0)
    reasons.push("invalid_order_price");

  const estimatedQty =
    input.ticket.amountType === "notional" && referencePrice
      ? input.ticket.notional! / referencePrice
      : (input.ticket.qty ?? 0);
  const estimatedNotional =
    input.ticket.amountType === "notional"
      ? (input.ticket.notional ?? 0)
      : estimatedQty * (priceBasis ?? 0);

  if (
    !Number.isFinite(estimatedQty) ||
    estimatedQty <= 0 ||
    !Number.isFinite(estimatedNotional) ||
    estimatedNotional <= 0
  )
    reasons.push("invalid_order_size");
  if (estimatedNotional > maxOrderNotional) reasons.push("max_order_notional");
  if (
    input.ticket.side === "buy" &&
    estimatedNotional > Math.max(0, input.cash)
  )
    reasons.push("cash_limit");
  if (
    input.ticket.side === "sell" &&
    estimatedQty > Math.max(0, input.heldQty) + 1e-12
  )
    reasons.push("position_limit");

  const warnings: string[] = [];
  if (
    input.ticket.type !== "market" &&
    input.market.spreadBps !== null &&
    input.market.spreadBps > maxMarketSpreadBps
  )
    warnings.push(
      "Current crypto spread is wider than the market-order guardrail.",
    );
  if (referencePrice !== null && input.ticket.limitPrice) {
    const distancePercent =
      Math.abs(input.ticket.limitPrice / referencePrice - 1) * 100;
    if (distancePercent > 10)
      warnings.push(
        "Limit price is more than 10% away from the current crypto reference price.",
      );
  }

  if (reasons.length)
    return {
      allowed: false as const,
      reasons: [...new Set(reasons)],
      market: input.market,
    };
  const preview: CryptoOrderPreview = {
    symbol: input.ticket.symbol,
    side: input.ticket.side,
    type: input.ticket.type,
    amountType: input.ticket.amountType,
    ...(input.ticket.qty ? { qty: input.ticket.qty } : {}),
    ...(input.ticket.notional ? { notional: input.ticket.notional } : {}),
    limitPrice: input.ticket.limitPrice,
    stopPrice: input.ticket.stopPrice,
    timeInForce: input.ticket.timeInForce,
    referencePrice: referencePrice!,
    spreadBps: input.market.spreadBps,
    estimatedQty,
    estimatedNotional,
    maxOrderNotional,
    warnings,
    expiresAt: (input.now ?? Date.now()) + 120_000,
  };
  return {
    allowed: true as const,
    reasons: [] as string[],
    preview: CryptoOrderPreview.parse(preview),
    market: input.market,
  };
}

export function signCryptoOrderPreview(
  preview: CryptoOrderPreview,
  secret: string,
) {
  return signToken(CryptoOrderPreview.parse(preview), secret);
}

export function verifyCryptoOrderPreview(
  token: string,
  secret: string,
  now = Date.now(),
) {
  const preview = CryptoOrderPreview.parse(
    verifyToken(token, secret, "Invalid crypto order preview token"),
  );
  if (preview.expiresAt < now) throw new Error("Crypto order preview expired");
  return preview;
}
