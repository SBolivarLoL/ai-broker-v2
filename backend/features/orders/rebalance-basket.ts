import { z } from "zod";
import { signToken, verifyToken } from "./orders";
import {
  simulateTrade,
  type PendingOrder,
  type Position,
  type RiskSnapshot,
} from "../portfolio/risk";

const BasketLeg = z.object({
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z.]{1,10}$/),
  side: z.enum(["buy", "sell"]),
  qty: z.coerce.number().positive().finite(),
});

export const RebalanceBasket = z
  .object({
    legs: z.array(BasketLeg).min(2).max(10),
    timeInForce: z.enum(["day", "gtc"]).default("day"),
  })
  .superRefine((basket, context) => {
    const symbols = basket.legs.map((leg) => leg.symbol);
    if (new Set(symbols).size !== symbols.length)
      context.addIssue({
        code: "custom",
        message: "A basket may contain only one leg per symbol",
      });
  });

export type RebalanceBasket = z.infer<typeof RebalanceBasket>;
export type PricedBasketLeg = RebalanceBasket["legs"][number] & {
  price: number;
};

export const RebalanceBasketPreview = z.object({
  legs: z
    .array(BasketLeg.extend({ price: z.number().positive().finite() }))
    .min(2)
    .max(10),
  timeInForce: z.enum(["day", "gtc"]),
  expiresAt: z.number().int(),
});

export type RebalanceBasketPreview = z.infer<typeof RebalanceBasketPreview>;

export function simulateRebalanceBasket(input: {
  snapshot: RiskSnapshot;
  positions: Position[];
  legs: PricedBasketLeg[];
  dailyTurnover?: number;
  pendingOrders?: PendingOrder[];
}) {
  const {
    snapshot,
    positions,
    legs,
    dailyTurnover = 0,
    pendingOrders = [],
  } = input;
  const basketPending = legs.map((leg) => ({
    symbol: leg.symbol,
    side: leg.side,
    qty: leg.qty,
    price: leg.price,
  }));
  const simulations = legs.map((leg, index) => ({
    ...leg,
    simulation: simulateTrade({
      snapshot,
      positions,
      symbol: leg.symbol,
      side: leg.side,
      qty: leg.qty,
      price: leg.price,
      dailyTurnover,
      pendingOrders: [
        ...pendingOrders,
        ...basketPending.filter((_, otherIndex) => otherIndex !== index),
      ],
    }),
  }));
  const buyNotional = legs
    .filter((leg) => leg.side === "buy")
    .reduce((sum, leg) => sum + leg.qty * leg.price, 0);
  const sellNotional = legs
    .filter((leg) => leg.side === "sell")
    .reduce((sum, leg) => sum + leg.qty * leg.price, 0);
  const turnover = legs.reduce((sum, leg) => sum + leg.qty * leg.price, 0);
  return {
    allowed: simulations.every((leg) => leg.simulation.allowed),
    legs: simulations,
    summary: {
      buyNotional,
      sellNotional,
      netCashChange: sellNotional - buyNotional,
      resultingCash: snapshot.cash + sellNotional - buyNotional,
      turnoverPercent:
        ((dailyTurnover +
          pendingOrders.reduce(
            (sum, order) => sum + Number(order.qty) * Number(order.price),
            0,
          ) +
          turnover) /
          snapshot.equity) *
        100,
    },
    warnings: [
      "Alpaca has no atomic basket endpoint. Approved legs are submitted sequentially and may fill or fail independently.",
    ],
  };
}

export function signRebalanceBasketPreview(
  preview: RebalanceBasketPreview,
  secret: string,
) {
  return signToken(RebalanceBasketPreview.parse(preview), secret);
}

export function verifyRebalanceBasketPreview(
  token: string,
  secret: string,
  now = Date.now(),
) {
  const preview = RebalanceBasketPreview.parse(
    verifyToken(token, secret, "Invalid basket preview token"),
  );
  if (preview.expiresAt < now) throw new Error("Basket preview expired");
  return preview;
}
