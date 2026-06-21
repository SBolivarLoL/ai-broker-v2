import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const Preview = z.object({
  symbol: z.string().regex(/^[A-Z.]{1,10}$/),
  side: z.enum(["buy", "sell"]),
  qty: z.number().positive().finite(),
  price: z.number().positive().finite(),
  expiresAt: z.number().int(),
  planId: z.string().uuid().optional(),
  simulation: z.object({
    allowed: z.boolean(), estimatedNotional: z.number(), resultingCash: z.number(), resultingPositionPercent: z.number(), turnoverPercent: z.number(), reasons: z.array(z.string()),
  }).optional(),
});

export type Preview = z.infer<typeof Preview>;

const signature = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function signPreview(preview: Preview, secret: string) {
  if (secret.length < 32) throw new Error("PREVIEW_SECRET must be at least 32 characters");
  const payload = Buffer.from(JSON.stringify(Preview.parse(preview))).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyPreview(token: string, secret: string, now = Date.now()) {
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) throw new Error("Invalid preview token");
  const expected = signature(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new Error("Invalid preview token");
  const preview = Preview.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
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
  validate: (intent: Pick<Preview, "symbol" | "side" | "qty" | "price" | "planId">) => T | Promise<T>,
  now = Date.now(),
) {
  const preview = verifyPreview(token, secret, now);
  const intent = { symbol: preview.symbol, side: preview.side, qty: preview.qty, price: preview.price, ...(preview.planId ? { planId: preview.planId } : {}) };
  return { preview, validation: await validate(intent) };
}
