/**
 * Defines the supported option-order authority: long single legs and defined-
 * risk debit verticals, each bound to a signed expiring preview.
 */
import { z } from "zod";
import { signToken, verifyToken } from "./orders";

const OptionLeg = z.object({
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,6}\d{6}[CP]\d{8}$/),
  side: z.enum(["buy", "sell"]),
  positionIntent: z.enum(["buy_to_open", "sell_to_open"]),
});

export const OptionOrderTicket = z
  .object({
    kind: z.enum(["single", "vertical"]),
    legs: z.array(OptionLeg).min(1).max(2),
    qty: z.coerce.number().int().min(1).max(10),
    type: z.enum(["market", "limit"]),
    limitPrice: z.coerce.number().positive().finite().nullable().default(null),
  })
  .superRefine((ticket, context) => {
    if (ticket.type === "limit" && !ticket.limitPrice)
      context.addIssue({
        code: "custom",
        message: "A positive option limit price is required",
      });
    if (
      ticket.kind === "single" &&
      (ticket.legs.length !== 1 ||
        ticket.legs[0]?.side !== "buy" ||
        ticket.legs[0]?.positionIntent !== "buy_to_open")
    )
      context.addIssue({
        code: "custom",
        message:
          "Single-leg option tickets support long buy-to-open orders only",
      });
    if (
      ticket.kind === "vertical" &&
      (ticket.legs.length !== 2 ||
        ticket.type !== "limit" ||
        ticket.legs.filter(
          (leg) => leg.positionIntent === "buy_to_open" && leg.side === "buy",
        ).length !== 1 ||
        ticket.legs.filter(
          (leg) => leg.positionIntent === "sell_to_open" && leg.side === "sell",
        ).length !== 1)
    )
      context.addIssue({
        code: "custom",
        message:
          "Verticals require one buy-to-open and one sell-to-open leg with a net-debit limit",
      });
  });

export type OptionOrderTicket = z.infer<typeof OptionOrderTicket>;

const PreviewContract = z.object({
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  positionIntent: z.enum(["buy_to_open", "sell_to_open"]),
  underlying: z.string(),
  expiration: z.string(),
  optionType: z.enum(["call", "put"]),
  strike: z.number(),
  multiplier: z.number(),
  bid: z.number(),
  ask: z.number(),
});
export const OptionOrderPreview = z.object({
  kind: z.enum(["single", "vertical"]),
  legs: z.array(PreviewContract).min(1).max(2),
  qty: z.number().int().positive(),
  type: z.enum(["market", "limit"]),
  limitPrice: z.number().positive().nullable(),
  maxLoss: z.number().positive(),
  maxProfit: z.number().nonnegative().nullable(),
  exerciseCost: z.number().nonnegative(),
  assignmentNotional: z.number().nonnegative(),
  expiresAt: z.number().int(),
});
export type OptionOrderPreview = z.infer<typeof OptionOrderPreview>;

export function optionOrderRisk(
  ticket: OptionOrderTicket,
  contracts: any[],
  snapshots: Record<string, any>,
) {
  const legs = ticket.legs.map((leg) => {
    const contract = contracts.find((item) => item.symbol === leg.symbol),
      quote = snapshots[leg.symbol]?.latestQuote,
      bid = Number(quote?.bp),
      ask = Number(quote?.ap);
    if (
      !contract?.tradable ||
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid < 0 ||
      ask <= 0 ||
      ask < bid
    )
      throw new Error(`${leg.symbol} has no valid tradable two-sided quote`);
    return {
      ...leg,
      underlying: String(contract.underlyingSymbol),
      expiration: new Date(contract.expirationDate).toISOString().slice(0, 10),
      optionType: contract.type as "call" | "put",
      strike: Number(contract.strikePrice),
      multiplier: Number(contract.multiplier),
      bid,
      ask,
    };
  });
  if (legs.some((leg) => leg.multiplier !== 100))
    throw new Error("Non-standard option deliverables are not supported");
  if (ticket.kind === "single") {
    const premium = ticket.type === "limit" ? ticket.limitPrice! : legs[0]!.ask,
      maxLoss = premium * 100 * ticket.qty;
    return {
      legs,
      maxLoss,
      maxProfit: null,
      referenceDebit: legs[0]!.ask,
      exerciseCost: legs[0]!.strike * 100 * ticket.qty,
      assignmentNotional: 0,
    };
  }
  const [first, second] = legs,
    bought = legs.find((leg) => leg.side === "buy")!,
    sold = legs.find((leg) => leg.side === "sell")!;
  if (
    first!.underlying !== second!.underlying ||
    first!.expiration !== second!.expiration ||
    first!.optionType !== second!.optionType
  )
    throw new Error(
      "Vertical legs must share underlying, expiration and option type",
    );
  const validOrientation =
    bought.optionType === "call"
      ? bought.strike < sold.strike
      : bought.strike > sold.strike;
  if (!validOrientation)
    throw new Error("Debit vertical strike orientation is invalid");
  const width = Math.abs(bought.strike - sold.strike),
    debit = ticket.limitPrice!;
  // For a debit vertical, strike width caps total value; paying the width or
  // more would guarantee a non-positive best-case payoff.
  if (debit >= width)
    throw new Error("Vertical debit must be less than the strike width");
  return {
    legs,
    maxLoss: debit * 100 * ticket.qty,
    maxProfit: (width - debit) * 100 * ticket.qty,
    referenceDebit: Math.max(0.01, bought.ask - sold.bid),
    exerciseCost: bought.strike * 100 * ticket.qty,
    assignmentNotional: sold.strike * 100 * ticket.qty,
  };
}

export const signOptionOrderPreview = (
  preview: OptionOrderPreview,
  secret: string,
) => signToken(OptionOrderPreview.parse(preview), secret);
export function verifyOptionOrderPreview(
  token: string,
  secret: string,
  now = Date.now(),
) {
  const preview = OptionOrderPreview.parse(
    verifyToken(token, secret, "Invalid option preview token"),
  );
  if (preview.expiresAt < now) throw new Error("Option preview expired");
  return preview;
}

export const OptionPositionActionPreview = z.object({
  symbol: z.string(),
  action: z.enum(["exercise", "do_not_exercise"]),
  qty: z.number().refine((value) => value !== 0),
  strike: z.number().positive(),
  multiplier: z.number().positive(),
  optionType: z.enum(["call", "put"]),
  expiration: z.string(),
  exerciseCost: z.number().nonnegative(),
  expiresAt: z.number().int(),
});
export type OptionPositionActionPreview = z.infer<
  typeof OptionPositionActionPreview
>;
export const signOptionPositionAction = (
  preview: OptionPositionActionPreview,
  secret: string,
) => signToken(OptionPositionActionPreview.parse(preview), secret);
export function verifyOptionPositionAction(
  token: string,
  secret: string,
  now = Date.now(),
) {
  const preview = OptionPositionActionPreview.parse(
    verifyToken(token, secret, "Invalid option action token"),
  );
  if (preview.expiresAt < now) throw new Error("Option action preview expired");
  return preview;
}
