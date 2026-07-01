import { describe, expect, test } from "bun:test";
import { meetsCoverageFloor, parseCoverageSummary } from "./coverage";

describe("coverage gate", () => {
  test("parses Bun's aggregate coverage row", () => {
    expect(parseCoverageSummary("All files | 95.01 | 96.44 |\n")).toEqual({
      functions: 95.01,
      lines: 96.44,
    });
    expect(() => parseCoverageSummary("no summary")).toThrow();
  });

  test("enforces both reviewed floors", () => {
    expect(meetsCoverageFloor({ functions: 95, lines: 96 })).toBe(true);
    expect(meetsCoverageFloor({ functions: 94.99, lines: 100 })).toBe(false);
    expect(meetsCoverageFloor({ functions: 100, lines: 95.99 })).toBe(false);
  });
});
