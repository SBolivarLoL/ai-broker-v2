import { expect, test } from "bun:test";
import {
  parseStrategyReview,
  strategyReviewStatus,
  withStrategyReviewConfig,
} from "../../backend/features/strategies/strategy-review";

test("maps review actions to existing strategy run statuses", () => {
  expect(strategyReviewStatus("continue", "paper")).toBe("paper");
  expect(strategyReviewStatus("continue", "paused")).toBe("shadow");
  expect(strategyReviewStatus("pause", "paper")).toBe("paused");
  expect(strategyReviewStatus("retire", "shadow")).toBe("retired");
  expect(strategyReviewStatus("revise", "completed")).toBe("shadow");
  expect(strategyReviewStatus("promote", "paper")).toBe("completed");
});

test("parses a strategy review with actor, timestamp and revision evidence", () => {
  const parsed = parseStrategyReview(
    {
      action: "revise",
      note: "Widen the spread gate after paper slippage review",
      revision: { maxSpreadBps: 75 },
    },
    "tester",
    "paper",
    new Date("2026-06-25T10:00:00.000Z"),
  );

  expect(parsed).toMatchObject({
    action: "revise",
    status: "shadow",
    note: "Widen the spread gate after paper slippage review",
    review: {
      actor: "tester",
      reviewedAt: "2026-06-25T10:00:00.000Z",
      revision: { maxSpreadBps: 75 },
    },
  });
});
test("rejects missing review notes and unknown actions", () => {
  expect(() =>
    parseStrategyReview(
      { action: "skip", note: "Useful note" },
      "tester",
      "shadow",
    ),
  ).toThrow("Review action");
  expect(() =>
    parseStrategyReview({ action: "continue", note: "no" }, "tester", "shadow"),
  ).toThrow("Review note");
});

test("appends review history without mutating unrelated config", () => {
  const next = withStrategyReviewConfig(
    {
      strategyId: "moving-average-trend",
      reviewHistory: [{ action: "continue", note: "old" }],
    },
    {
      action: "promote",
      actor: "tester",
      reviewedAt: "2026-06-25T11:00:00.000Z",
      note: "Promote after beating cash and buy-and-hold",
    },
  );

  expect(next).toMatchObject({
    strategyId: "moving-average-trend",
    review: { action: "promote", actor: "tester" },
    reviewHistory: [
      { action: "continue", note: "old" },
      {
        action: "promote",
        note: "Promote after beating cash and buy-and-hold",
      },
    ],
  });
});
