/** Encodes lifecycle transitions and evidence requirements for strategy review. */
import type { StrategyRunStatus } from "../../persistence/store";

export type StrategyReviewAction =
  "continue" | "pause" | "retire" | "revise" | "promote";
export type StrategyReviewRecord = Record<string, unknown> & {
  action: StrategyReviewAction;
  actor: string;
  reviewedAt: string;
  note: string;
  revision?: Record<string, unknown>;
};

const reviewActions = new Set<StrategyReviewAction>([
  "continue",
  "pause",
  "retire",
  "revise",
  "promote",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function reviewNote(value: unknown) {
  const note = String(value ?? "").trim();
  if (note.length < 5 || note.length > 1_000)
    throw new Error("Review note must be 5 to 1000 characters");
  return note;
}

export function strategyReviewStatus(
  action: StrategyReviewAction,
  currentStatus: StrategyRunStatus,
): StrategyRunStatus {
  if (action === "pause") return "paused";
  if (action === "retire") return "retired";
  if (action === "revise") return "shadow";
  if (action === "promote") return "completed";
  return currentStatus === "paper" ? "paper" : "shadow";
}

export function parseStrategyReview(
  input: Record<string, unknown>,
  actor: string,
  currentStatus: StrategyRunStatus,
  now = new Date(),
) {
  const action = String(input.action ?? "")
    .trim()
    .toLowerCase();
  if (!reviewActions.has(action as StrategyReviewAction))
    throw new Error(
      "Review action must be continue, pause, retire, revise or promote",
    );
  const revision = isRecord(input.revision) ? input.revision : undefined;
  const review: StrategyReviewRecord = {
    action: action as StrategyReviewAction,
    actor,
    reviewedAt: now.toISOString(),
    note: reviewNote(input.note),
    ...(revision ? { revision } : {}),
  };
  return {
    action: review.action,
    status: strategyReviewStatus(review.action, currentStatus),
    note: review.note,
    review,
  };
}

export function withStrategyReviewConfig(
  config: unknown,
  review: StrategyReviewRecord,
): Record<string, unknown> & {
  review: StrategyReviewRecord;
  reviewHistory: Record<string, unknown>[];
} {
  const base = isRecord(config) ? { ...config } : {};
  const history = Array.isArray(base.reviewHistory)
    ? base.reviewHistory.filter(isRecord)
    : [];
  return { ...base, review, reviewHistory: [...history, review].slice(-50) };
}
