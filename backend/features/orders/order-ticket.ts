import { z } from "zod";

export const OrderTicket = z
  .object({
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z.]{1,10}$/),
    side: z.enum(["buy", "sell"]),
    type: z
      .enum(["market", "limit", "stop", "stop_limit", "trailing_stop"])
      .default("market"),
    orderClass: z.enum(["simple", "bracket", "oco", "oto"]).default("simple"),
    amountType: z.enum(["quantity", "notional"]).default("quantity"),
    qty: z.coerce.number().positive().finite().optional(),
    notional: z.coerce.number().positive().finite().optional(),
    limitPrice: z.coerce.number().positive().finite().nullable().default(null),
    stopPrice: z.coerce.number().positive().finite().nullable().default(null),
    trailPercent: z.coerce
      .number()
      .positive()
      .max(100)
      .finite()
      .nullable()
      .default(null),
    takeProfitPrice: z.coerce
      .number()
      .positive()
      .finite()
      .nullable()
      .default(null),
    stopLossPrice: z.coerce
      .number()
      .positive()
      .finite()
      .nullable()
      .default(null),
    stopLossLimitPrice: z.coerce
      .number()
      .positive()
      .finite()
      .nullable()
      .default(null),
    timeInForce: z.enum(["day", "gtc", "opg", "cls"]).default("day"),
    extendedHours: z.boolean().default(false),
    allowShort: z.boolean().default(false),
    planId: z.string().uuid().optional(),
  })
  .superRefine((ticket, context) => {
    if (ticket.amountType === "quantity" && !ticket.qty)
      context.addIssue({
        code: "custom",
        message: "A positive quantity is required",
      });
    if (ticket.amountType === "notional" && !ticket.notional)
      context.addIssue({
        code: "custom",
        message: "A positive dollar amount is required",
      });
    if (
      ticket.amountType === "notional" &&
      (ticket.type !== "market" || ticket.orderClass !== "simple")
    )
      context.addIssue({
        code: "custom",
        message: "Dollar-notional orders must use a simple market order",
      });
    if (
      ticket.type === "limit" &&
      ticket.orderClass !== "oco" &&
      !ticket.limitPrice
    )
      context.addIssue({
        code: "custom",
        message: "A limit price is required",
      });
    if (ticket.type === "stop" && !ticket.stopPrice)
      context.addIssue({ code: "custom", message: "A stop price is required" });
    if (
      ticket.type === "stop_limit" &&
      (!ticket.stopPrice || !ticket.limitPrice)
    )
      context.addIssue({
        code: "custom",
        message: "Stop and limit prices are required",
      });
    if (ticket.type === "trailing_stop" && !ticket.trailPercent)
      context.addIssue({
        code: "custom",
        message: "A trailing percent is required",
      });
    if (
      ticket.extendedHours &&
      (ticket.type !== "limit" || ticket.timeInForce !== "day")
    )
      context.addIssue({
        code: "custom",
        message: "Extended hours requires a DAY limit order",
      });
    if (
      ticket.orderClass !== "simple" &&
      !["market", "limit"].includes(ticket.type)
    )
      context.addIssue({
        code: "custom",
        message: "Linked orders require a market or limit entry",
      });
    if (ticket.orderClass !== "simple" && ticket.extendedHours)
      context.addIssue({
        code: "custom",
        message: "Linked orders do not support extended hours",
      });
    if (
      ticket.orderClass === "bracket" &&
      (ticket.side !== "buy" ||
        !ticket.takeProfitPrice ||
        !ticket.stopLossPrice)
    )
      context.addIssue({
        code: "custom",
        message: "A buy bracket requires take-profit and stop-loss prices",
      });
    if (
      ticket.orderClass === "oco" &&
      (ticket.side !== "sell" ||
        !ticket.takeProfitPrice ||
        !ticket.stopLossPrice)
    )
      context.addIssue({
        code: "custom",
        message:
          "An OCO exit requires sell side, take-profit and stop-loss prices",
      });
    if (
      ticket.orderClass === "oto" &&
      (ticket.side !== "buy" ||
        Number(Boolean(ticket.takeProfitPrice)) +
          Number(Boolean(ticket.stopLossPrice)) !==
          1)
    )
      context.addIssue({
        code: "custom",
        message:
          "A buy OTO requires exactly one take-profit or stop-loss price",
      });
    if (
      ["opg", "cls"].includes(ticket.timeInForce) &&
      (ticket.orderClass !== "simple" ||
        ticket.amountType !== "quantity" ||
        !Number.isInteger(ticket.qty) ||
        !["market", "limit"].includes(ticket.type))
    )
      context.addIssue({
        code: "custom",
        message:
          "Auction orders require a simple whole-share market or limit order",
      });
    if (
      ticket.allowShort &&
      (ticket.side !== "sell" ||
        ticket.orderClass !== "simple" ||
        ticket.amountType !== "quantity" ||
        !["market", "limit"].includes(ticket.type) ||
        ticket.timeInForce !== "day" ||
        ticket.extendedHours)
    )
      context.addIssue({
        code: "custom",
        message:
          "Paper shorts require an explicit simple DAY market or limit sell by quantity",
      });
  });

export type OrderTicket = z.infer<typeof OrderTicket>;

export function ticketRiskPrice(
  ticket: Pick<OrderTicket, "type" | "side" | "limitPrice" | "stopPrice">,
  currentPrice: number,
) {
  if (ticket.type === "limit" || ticket.type === "stop_limit")
    return ticket.limitPrice!;
  if (ticket.type === "stop" && ticket.stopPrice)
    return ticket.side === "buy"
      ? Math.max(currentPrice, ticket.stopPrice)
      : currentPrice;
  return currentPrice;
}

export function ticketQuantity(
  ticket: Pick<OrderTicket, "amountType" | "qty" | "notional">,
  currentPrice: number,
) {
  return ticket.amountType === "notional"
    ? ticket.notional! / currentPrice
    : ticket.qty!;
}

export function liquidityPreview(
  snapshot: any,
  quantity: number,
  currentPrice: number,
  type: OrderTicket["type"],
) {
  const bid = Number(snapshot?.latestQuote?.bp),
    ask = Number(snapshot?.latestQuote?.ap);
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const spread = midpoint && ask >= bid ? ask - bid : null;
  const spreadBps =
    spread !== null && midpoint ? (spread / midpoint) * 10_000 : null;
  const dailyVolume = Number(snapshot?.dailyBar?.v);
  const participationPercent =
    dailyVolume > 0 ? (quantity / dailyVolume) * 100 : null;
  const estimatedSpreadCost =
    spread !== null && ["market", "stop", "trailing_stop"].includes(type)
      ? (quantity * spread) / 2
      : 0;
  const warnings: string[] = [];
  if (spreadBps !== null && spreadBps > 50)
    warnings.push("The current bid–ask spread is wider than 50 bps.");
  if (participationPercent !== null && participationPercent > 1)
    warnings.push(
      "This order exceeds 1% of the current session's displayed volume.",
    );
  if (!midpoint)
    warnings.push(
      "No valid two-sided IEX quote is available; spread cost cannot be estimated.",
    );
  return {
    bid: bid > 0 ? bid : null,
    ask: ask > 0 ? ask : null,
    midpoint,
    spreadBps,
    dailyVolume: dailyVolume >= 0 ? dailyVolume : null,
    participationPercent,
    estimatedSpreadCost,
    referencePrice: currentPrice,
    warnings,
  };
}

export function linkedOrderError(
  ticket: Pick<
    OrderTicket,
    | "orderClass"
    | "type"
    | "limitPrice"
    | "takeProfitPrice"
    | "stopLossPrice"
    | "stopLossLimitPrice"
  >,
  currentPrice: number,
) {
  if (ticket.orderClass === "simple") return null;
  const entry =
    ticket.orderClass === "oco"
      ? currentPrice
      : ticket.type === "limit"
        ? ticket.limitPrice!
        : currentPrice;
  if (ticket.takeProfitPrice !== null && ticket.takeProfitPrice <= entry)
    return "Take-profit price must be above the current or entry price";
  if (ticket.stopLossPrice !== null && ticket.stopLossPrice >= entry)
    return "Stop-loss price must be below the current or entry price";
  if (
    ticket.stopLossLimitPrice !== null &&
    (ticket.stopLossPrice === null ||
      ticket.stopLossLimitPrice > ticket.stopLossPrice)
  )
    return "A sell stop-loss limit must not exceed its stop price";
  return null;
}

/** Alpaca rejects auction orders during exchange-specific cutoff windows. */
export function auctionSubmissionError(
  timeInForce: OrderTicket["timeInForce"],
  now = new Date(),
) {
  if (!["opg", "cls"].includes(timeInForce)) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const cutoff = timeInForce === "opg" ? 9 * 60 + 28 : 15 * 60 + 50;
  if (minute >= cutoff && minute < 19 * 60)
    return `${timeInForce.toUpperCase()} orders are rejected by Alpaca between ${timeInForce === "opg" ? "9:28 AM" : "3:50 PM"} and 7:00 PM ET`;
  return null;
}
