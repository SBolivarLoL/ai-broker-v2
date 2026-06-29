import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const Preview = z.object({
  symbol: z.string().regex(/^[A-Z.]{1,10}$/),
  side: z.enum(["buy", "sell"]),
  qty: z.number().positive().finite(),
  notional: z.number().positive().finite().optional(),
  amountType: z.enum(["quantity", "notional"]).default("quantity"),
  type: z.enum(["market", "limit", "stop", "stop_limit", "trailing_stop"]).default("market"),
  orderClass: z.enum(["simple", "bracket", "oco", "oto"]).default("simple"),
  limitPrice: z.number().positive().finite().nullable().default(null),
  stopPrice: z.number().positive().finite().nullable().default(null),
  trailPercent: z.number().positive().max(100).finite().nullable().default(null),
  takeProfitPrice: z.number().positive().finite().nullable().default(null),
  stopLossPrice: z.number().positive().finite().nullable().default(null),
  stopLossLimitPrice: z.number().positive().finite().nullable().default(null),
  timeInForce: z.enum(["day", "gtc", "opg", "cls"]).default("day"),
  extendedHours: z.boolean().default(false),
  allowShort: z.boolean().default(false),
  price: z.number().positive().finite(),
  expiresAt: z.number().int(),
  planId: z.string().uuid().optional(),
  simulation: z.object({
    allowed: z.boolean(), estimatedNotional: z.number(), resultingCash: z.number(), resultingPositionPercent: z.number(), turnoverPercent: z.number(), reasons: z.array(z.string()),
  }).optional(),
}).superRefine((preview, context) => {
  if (preview.amountType === "notional" && (preview.type !== "market" || !preview.notional)) context.addIssue({ code: "custom", message: "Notional orders must be market orders" });
  if (preview.type === "limit" && !preview.limitPrice) context.addIssue({ code: "custom", message: "Limit price is required" });
  if (preview.type === "stop" && !preview.stopPrice) context.addIssue({ code: "custom", message: "Stop price is required" });
  if (preview.type === "stop_limit" && (!preview.limitPrice || !preview.stopPrice)) context.addIssue({ code: "custom", message: "Stop and limit prices are required" });
  if (preview.type === "trailing_stop" && !preview.trailPercent) context.addIssue({ code: "custom", message: "Trail percent is required" });
  if (preview.extendedHours && preview.type !== "limit") context.addIssue({ code: "custom", message: "Extended hours requires a limit order" });
  if (preview.orderClass === "bracket" && (!preview.takeProfitPrice || !preview.stopLossPrice)) context.addIssue({ code: "custom", message: "Bracket legs are required" });
  if (preview.orderClass === "oco" && (!preview.takeProfitPrice || !preview.stopLossPrice)) context.addIssue({ code: "custom", message: "OCO legs are required" });
  if (preview.orderClass === "oto" && Number(Boolean(preview.takeProfitPrice)) + Number(Boolean(preview.stopLossPrice)) !== 1) context.addIssue({ code: "custom", message: "Exactly one OTO leg is required" });
});

export type Preview = z.infer<typeof Preview>;

const signature = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function signToken(value: unknown, secret: string) {
  if (secret.length < 32) throw new Error("PREVIEW_SECRET must be at least 32 characters");
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyToken(token: string, secret: string, invalidMessage: string) {
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) throw new Error(invalidMessage);
  const expected = signature(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new Error(invalidMessage);
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

export function signPreview(preview: Preview, secret: string) {
  return signToken(Preview.parse(preview), secret);
}

export function verifyPreview(token: string, secret: string, now = Date.now()) {
  const preview = Preview.parse(verifyToken(token, secret, "Invalid preview token"));
  if (preview.expiresAt < now) throw new Error("Preview expired");
  return preview;
}

/**
 * Verifies intent only, then requires the caller to obtain fresh account, position,
 * open-order, quote and turnover data before it can submit the order.
 */
export async function verifyPreviewFresh<T>(
  token: string,
  secret: string,
  validate: (intent: Omit<Preview, "simulation" | "expiresAt">) => T | Promise<T>,
  now = Date.now(),
) {
  const preview = verifyPreview(token, secret, now);
  const { simulation: _simulation, expiresAt: _expiresAt, ...intent } = preview;
  return { preview, validation: await validate(intent) };
}
