import { expect, test } from "bun:test";
import { normalizeStrategySchedule, parseStrategyIntervalMinutes, strategyRunIsDue, withNextStrategySchedule } from "./strategy-scheduler";

test("validates strategy schedule intervals", () => {
  expect(parseStrategyIntervalMinutes(undefined)).toBe(null);
  expect(parseStrategyIntervalMinutes(0)).toBe(null);
  expect(parseStrategyIntervalMinutes("15")).toBe(15);
  expect(() => parseStrategyIntervalMinutes("0.5")).toThrow("Strategy schedule interval");
  expect(() => parseStrategyIntervalMinutes("1441")).toThrow("Strategy schedule interval");
});

test("detects scheduled shadow runs that are due", () => {
  const now = new Date("2026-06-24T10:00:00.000Z");
  expect(strategyRunIsDue({ status: "completed", config: { schedule: { intervalMinutes: 5 } } }, now)).toBe(false);
  expect(strategyRunIsDue({ status: "paper", config: { schedule: { intervalMinutes: 5 } } }, now)).toBe(true);
  expect(strategyRunIsDue({ status: "shadow", config: {} }, now)).toBe(false);
  expect(strategyRunIsDue({ status: "shadow", config: { schedule: { intervalMinutes: 5, nextRunAt: "2026-06-24T09:59:00.000Z" } } }, now)).toBe(true);
  expect(strategyRunIsDue({ status: "shadow", config: { schedule: { intervalMinutes: 5, nextRunAt: "2026-06-24T10:01:00.000Z" } } }, now)).toBe(false);
  expect(strategyRunIsDue({ status: "shadow", config: { schedule: { intervalMinutes: 5 } } }, now, "2026-06-24T09:54:59.000Z")).toBe(true);
  expect(strategyRunIsDue({ status: "shadow", config: { schedule: { intervalMinutes: 5 } } }, now, "2026-06-24T09:58:00.000Z")).toBe(false);
});

test("rolls scheduled strategy run timestamps forward", () => {
  const updated = withNextStrategySchedule({ schedule: { intervalMinutes: 15, nextRunAt: "2026-06-24T09:59:00.000Z" } }, new Date("2026-06-24T10:00:00.000Z"));
  expect(normalizeStrategySchedule(updated)).toMatchObject({ intervalMinutes: 15 });
  expect(updated).toMatchObject({
    schedule: {
      intervalMinutes: 15,
      lastRunAt: "2026-06-24T10:00:00.000Z",
      nextRunAt: "2026-06-24T10:15:00.000Z",
    },
  });
});
