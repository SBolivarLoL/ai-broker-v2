import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { z } from "zod";
import { conflict } from "../../http/http";
import { providerTimeFields } from "../../shared/time-provenance";

/** Execution requires a recent IEX trade even outside the core session.
 * A previous close is useful for research, but cannot authorize an order.
 */
export const OrderPriceEvidence = z.object({
  symbol: z.string().regex(/^[A-Z.]{1,10}$/),
  price: z.number().positive().finite(),
  source: z.literal("Alpaca latest stock trade"),
  feed: z.literal("iex"),
  observedAt: z.string().datetime(),
  retrievedAt: z.string().datetime(),
  maxAgeSeconds: z.literal(60),
});
export type OrderPriceEvidence = z.infer<typeof OrderPriceEvidence>;

export function assertFreshOrderPrice(evidence: OrderPriceEvidence, now: Date) {
  const parsed = OrderPriceEvidence.safeParse(evidence);
  const observed = parsed.success ? Date.parse(parsed.data.observedAt) : NaN;
  const retrieved = parsed.success ? Date.parse(parsed.data.retrievedAt) : NaN;
  const time = now.getTime();
  if (!Number.isFinite(time) || !Number.isFinite(observed) ||
      observed > retrieved || retrieved > time || time - observed > 60_000) {
    throw conflict(
      "A valid IEX trade observed within 60 seconds is required. Wait for current market data, then create a new preview; closed-session prices are not exempt.",
      "market_price_unavailable", true, "refresh_preview",
    );
  }
}

/** Preserve the identity and observation discarded by SDK getLatestPrice(). */
export async function getOrderPrice(
  marketData: Pick<Alpaca["marketData"], "stocks">,
  symbol: string,
  now: () => Date = () => new Date(),
) {
  const response = await marketData.stocks.stockLatestTradeSingle({ symbol, feed: "iex" });
  const retrievedAt = now();
  const timestamp = response?.trade?.t;
  const observed = timestamp instanceof Date || typeof timestamp === "string"
    ? new Date(timestamp) : null;
  const parsed = OrderPriceEvidence.safeParse({
    symbol: response?.symbol,
    price: response?.trade?.p,
    source: "Alpaca latest stock trade",
    feed: "iex",
    observedAt: observed && Number.isFinite(observed.getTime()) ? observed.toISOString() : null,
    retrievedAt: retrievedAt.toISOString(),
    maxAgeSeconds: 60,
  });
  if (!parsed.success || response.symbol !== symbol)
    throw conflict("The broker returned missing or invalid price identity, value, or observation time. Refresh the preview when current data is available.",
      "market_price_unavailable", true, "refresh_preview");
  assertFreshOrderPrice(parsed.data, retrievedAt);
  return {
    ...parsed.data,
    ...providerTimeFields({
      observationTime: parsed.data.observedAt,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: parsed.data.retrievedAt,
      serverResponseTime: parsed.data.retrievedAt,
    }),
    observedAt: parsed.data.observedAt,
  };
}
