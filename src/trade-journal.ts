import { z } from "zod";

export const TradeThesisStatus = z.enum(["unreviewed", "intact", "drifting", "invalidated", "closed"]);
export type TradeThesisStatus = z.infer<typeof TradeThesisStatus>;

export const TradeJournalCreateInput = z.object({
  receiptId: z.string().uuid(),
  thesis: z.string().trim().min(10).max(1_000),
  invalidation: z.string().trim().min(5).max(500),
}).strict();

export const TradeJournalReviewInput = z.object({
  status: z.enum(["intact", "drifting", "invalidated", "closed"]),
  notes: z.string().trim().min(3).max(1_000),
}).strict();

const PositionContext = z.object({
  qty: z.number().finite().nullable(),
  averageEntryPrice: z.number().finite().nullable(),
  currentPrice: z.number().finite().nullable(),
  marketValue: z.number().finite().nullable(),
  unrealizedProfitLoss: z.number().finite().nullable(),
  unrealizedReturnPercent: z.number().finite().nullable(),
});

export const TradeReviewEvidence = z.object({
  currentPrice: z.number().positive().finite(),
  observedAt: z.string().min(1),
  receiptStatus: z.string().min(1),
  position: PositionContext.nullable(),
});

const TradeJournalReview = z.object({
  id: z.string().uuid(),
  status: z.enum(["intact", "drifting", "invalidated", "closed"]),
  notes: z.string().min(3).max(1_000),
  actor: z.string().min(1).max(200),
  reviewedAt: z.string().min(1),
  drift: z.object({
    previousStatus: TradeThesisStatus,
    currentStatus: TradeThesisStatus,
    direction: z.enum(["initial", "unchanged", "improved", "deteriorated", "closed"]),
  }),
  evidence: z.array(z.string().min(1)).min(1),
  snapshot: z.object({
    referencePrice: z.number().positive().finite(),
    currentPrice: z.number().positive().finite(),
    priceChangePercent: z.number().finite(),
    receiptStatus: z.string().min(1),
    position: PositionContext.nullable(),
    warnings: z.array(z.string()),
  }),
});

export const TradeJournalEntry = z.object({
  id: z.string().uuid(),
  receiptId: z.string().uuid(),
  orderId: z.string().min(1),
  planId: z.string().uuid().nullable(),
  symbol: z.string().regex(/^[A-Z.]{1,10}$/),
  side: z.enum(["buy", "sell"]),
  qty: z.number().positive().finite(),
  referencePrice: z.number().positive().finite(),
  referencePriceSource: z.literal("order_preview"),
  orderStatusAtEntry: z.string().min(1),
  thesis: z.string().min(10).max(1_000),
  invalidation: z.string().min(5).max(500),
  status: TradeThesisStatus,
  reviews: z.array(TradeJournalReview).max(500),
  createdBy: z.string().min(1).max(200),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TradeJournalEntry = z.infer<typeof TradeJournalEntry>;

export const TradeJournalReceiptCandidate = z.object({
  receiptId: z.string().uuid(),
  orderId: z.string().min(1),
  planId: z.string().uuid().nullable(),
  symbol: z.string().regex(/^[A-Z.]{1,10}$/),
  side: z.enum(["buy", "sell"]),
  qty: z.number().positive().finite(),
  referencePrice: z.number().positive().finite(),
  orderStatus: z.string().min(1),
  createdAt: z.string().min(1),
  suggestedThesis: z.string().nullable(),
  suggestedInvalidation: z.string().nullable(),
});
export type TradeJournalReceiptCandidate = z.infer<typeof TradeJournalReceiptCandidate>;

export function journalCandidateFromReceipt(receiptId: string, receipt: unknown): TradeJournalReceiptCandidate | null {
  if (!z.string().uuid().safeParse(receiptId).success || !receipt || typeof receipt !== "object") return null;
  const record = receipt as Record<string, any>;
  const preview = record.preview;
  if (!preview || typeof preview !== "object") return null;
  const symbol = String(preview.symbol ?? "").trim().toUpperCase();
  const side = preview.side;
  const qty = Number(preview.qty);
  const referencePrice = Number(preview.price);
  const orderId = String(record.orderId ?? "").trim();
  if (!/^[A-Z.]{1,10}$/.test(symbol) || !["buy", "sell"].includes(side) || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(referencePrice) || referencePrice <= 0 || !orderId) return null;

  const plan = record.plan && typeof record.plan === "object" ? record.plan : null;
  const planId = z.string().uuid().safeParse(plan?.id).success ? plan.id as string : null;
  const action = side === "buy" ? "buy" : "reduce";
  const idea = Array.isArray(plan?.ideas) ? plan.ideas.find((item: any) => item?.symbol === symbol && item?.action === action && item?.actionable === true) : null;
  return TradeJournalReceiptCandidate.parse({
    receiptId,
    orderId,
    planId,
    symbol,
    side,
    qty,
    referencePrice,
    orderStatus: String(record.status ?? "unknown"),
    createdAt: String(record.createdAt ?? new Date(0).toISOString()),
    suggestedThesis: typeof idea?.thesis === "string" ? idea.thesis : null,
    suggestedInvalidation: typeof idea?.invalidation === "string" ? idea.invalidation : null,
  });
}

export function createTradeJournalEntry(candidate: TradeJournalReceiptCandidate, input: unknown, actor: string, now = new Date().toISOString(), id = crypto.randomUUID()) {
  const parsedCandidate = TradeJournalReceiptCandidate.parse(candidate);
  const parsedInput = TradeJournalCreateInput.parse(input);
  if (parsedInput.receiptId !== parsedCandidate.receiptId) throw new Error("Receipt does not match the journal entry");
  const createdAt = new Date(now).toISOString();
  return TradeJournalEntry.parse({
    id,
    receiptId: parsedCandidate.receiptId,
    orderId: parsedCandidate.orderId,
    planId: parsedCandidate.planId,
    symbol: parsedCandidate.symbol,
    side: parsedCandidate.side,
    qty: parsedCandidate.qty,
    referencePrice: parsedCandidate.referencePrice,
    referencePriceSource: "order_preview",
    orderStatusAtEntry: parsedCandidate.orderStatus,
    thesis: parsedInput.thesis,
    invalidation: parsedInput.invalidation,
    status: "unreviewed",
    reviews: [],
    createdBy: actor,
    createdAt,
    updatedAt: createdAt,
  });
}

export function appendTradeJournalReview(entry: unknown, input: unknown, evidence: unknown, actor: string, now = new Date().toISOString(), id = crypto.randomUUID()) {
  const parsedEntry = TradeJournalEntry.parse(entry);
  const parsedInput = TradeJournalReviewInput.parse(input);
  const parsedEvidence = TradeReviewEvidence.parse(evidence);
  if (parsedEntry.status === "closed") throw new Error("Closed journal entries cannot be reviewed again");
  const reviewedAt = new Date(now).toISOString();
  const rank: Record<"intact" | "drifting" | "invalidated", number> = { intact: 0, drifting: 1, invalidated: 2 };
  const direction = parsedInput.status === "closed" ? "closed"
    : parsedEntry.status === "unreviewed" ? "initial"
    : parsedEntry.status === parsedInput.status ? "unchanged"
    : rank[parsedInput.status] > rank[parsedEntry.status] ? "deteriorated" : "improved";
  const warnings = ["Price change uses the signed order-preview reference price, not the execution fill price."];
  if (parsedEvidence.receiptStatus !== "filled") warnings.push(`The linked order is ${parsedEvidence.receiptStatus}; post-trade attribution may be incomplete.`);
  if (!parsedEvidence.position) warnings.push("No current open position was available; the trade may be closed, unfilled, or netted with other activity.");
  const review = TradeJournalReview.parse({
    id,
    status: parsedInput.status,
    notes: parsedInput.notes,
    actor,
    reviewedAt,
    drift: { previousStatus: parsedEntry.status, currentStatus: parsedInput.status, direction },
    evidence: [`price:${parsedEntry.symbol}:${parsedEvidence.observedAt}`, `receipt:${parsedEntry.receiptId}`],
    snapshot: {
      referencePrice: parsedEntry.referencePrice,
      currentPrice: parsedEvidence.currentPrice,
      priceChangePercent: Number(((parsedEvidence.currentPrice / parsedEntry.referencePrice - 1) * 100).toFixed(4)),
      receiptStatus: parsedEvidence.receiptStatus,
      position: parsedEvidence.position,
      warnings,
    },
  });
  return TradeJournalEntry.parse({ ...parsedEntry, status: parsedInput.status, reviews: [...parsedEntry.reviews, review], updatedAt: reviewedAt });
}
