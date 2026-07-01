import { expect, test } from "bun:test";
import { createStore } from "./store";
import { appendTradeJournalReview, createTradeJournalEntry, journalCandidateFromReceipt } from "./trade-journal";

const receiptId = "00000000-0000-4000-8000-000000000001";
const entryId = "00000000-0000-4000-8000-000000000002";
const reviewId = "00000000-0000-4000-8000-000000000003";

const receipt = {
  orderId: "paper-order-1",
  status: "filled",
  createdAt: "2026-06-29T10:00:00.000Z",
  preview: { symbol: "SPY", side: "buy", qty: 0.5, price: 500 },
  plan: { id: "00000000-0000-4000-8000-000000000004", ideas: [{ symbol: "SPY", action: "buy", actionable: true, thesis: "Diversified market exposure", invalidation: "Portfolio concentration rises" }] },
};

test("journal candidates are derived only from standard stock-order receipts", () => {
  expect(journalCandidateFromReceipt(receiptId, receipt)).toMatchObject({ symbol: "SPY", side: "buy", qty: 0.5, suggestedThesis: "Diversified market exposure" });
  expect(journalCandidateFromReceipt(receiptId, { ...receipt, preview: { ...receipt.preview, symbol: "BTC/USD" } })).toBeNull();
  expect(journalCandidateFromReceipt(receiptId, { status: "filled" })).toBeNull();
});

test("trade reviews preserve thesis history and classify explicit drift with broker evidence", () => {
  const candidate = journalCandidateFromReceipt(receiptId, receipt)!;
  const entry = createTradeJournalEntry(candidate, { receiptId, thesis: "Diversified exposure should reduce single-name risk", invalidation: "Concentration exceeds the portfolio limit" }, "researcher", "2026-06-29T10:05:00Z", entryId);
  expect(entry).toMatchObject({ status: "unreviewed", referencePriceSource: "order_preview", reviews: [] });

  const reviewed = appendTradeJournalReview(entry, { status: "drifting", notes: "Concentration rose after other positions moved." }, { currentPrice: 475, observedAt: "2026-06-30T10:00:00Z", receiptStatus: "filled", position: { qty: 0.5, averageEntryPrice: 498, currentPrice: 475, marketValue: 237.5, unrealizedProfitLoss: -11.5, unrealizedReturnPercent: -4.62 } }, "researcher", "2026-06-30T10:00:00Z", reviewId);
  expect(reviewed).toMatchObject({ status: "drifting", thesis: entry.thesis, reviews: [{ drift: { previousStatus: "unreviewed", currentStatus: "drifting", direction: "initial" }, snapshot: { priceChangePercent: -5 } }] });
  expect(reviewed.reviews[0]!.evidence).toEqual(["price:SPY:2026-06-30T10:00:00Z", `receipt:${receiptId}`]);

  const recovered = appendTradeJournalReview(reviewed, { status: "intact", notes: "Position size is back inside policy." }, { currentPrice: 510, observedAt: "2026-07-01T10:00:00Z", receiptStatus: "filled", position: null }, "researcher", "2026-07-01T10:00:00Z", "00000000-0000-4000-8000-000000000005");
  expect(recovered.reviews.at(-1)).toMatchObject({ drift: { direction: "improved" }, snapshot: { priceChangePercent: 2 } });
});

test("closed journal entries are terminal", () => {
  const candidate = journalCandidateFromReceipt(receiptId, receipt)!;
  const entry = createTradeJournalEntry(candidate, { receiptId, thesis: "Diversified exposure should reduce single-name risk", invalidation: "Concentration exceeds the portfolio limit" }, "researcher", "2026-06-29T10:05:00Z", entryId);
  const evidence = { currentPrice: 500, observedAt: "2026-06-30T10:00:00Z", receiptStatus: "filled", position: null };
  const closed = appendTradeJournalReview(entry, { status: "closed", notes: "The position was exited." }, evidence, "researcher", "2026-06-30T10:00:00Z", reviewId);
  expect(() => appendTradeJournalReview(closed, { status: "intact", notes: "Reopen it." }, evidence, "researcher")).toThrow("Closed journal entries cannot be reviewed again");
});

test("journal entries and reviews persist with decision-audit evidence", () => {
  const store = createStore(":memory:");
  const candidate = journalCandidateFromReceipt(receiptId, receipt)!;
  const entry = createTradeJournalEntry(candidate, { receiptId, thesis: "Diversified exposure should reduce single-name risk", invalidation: "Concentration exceeds the portfolio limit" }, "researcher", "2026-06-29T10:05:00Z", entryId);
  store.addTradeJournalEntry(entry, "researcher");
  expect(store.tradeJournalEntryForReceipt(receiptId)).toEqual(entry);

  const reviewed = appendTradeJournalReview(entry, { status: "intact", notes: "Risk remains inside the stated limit." }, { currentPrice: 505, observedAt: "2026-06-30T10:00:00Z", receiptStatus: "filled", position: null }, "researcher", "2026-06-30T10:00:00Z", reviewId);
  store.updateTradeJournalEntry(reviewed, "researcher");
  expect(store.tradeJournalEntries()).toEqual([reviewed]);
  expect(store.decisionAuditTrail(entryId).map(item => item.kind)).toEqual(["trade_journal.created", "trade_journal.reviewed"]);
  expect(store.schemaMigrations()).toContainEqual(expect.objectContaining({ id: "0011", expected: true }));
  store.close();
});
