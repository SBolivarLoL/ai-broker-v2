// Lives beside coverage.ts, outside tests/, so the same coverage run collects
// coverage.ts toward the reviewed floor it exports.
import { describe, expect, test } from "bun:test";
import {
  excludedFromCoverage,
  meetsCoverageFloor,
  parseReviewedCoverage,
  parseCoverageSummary,
} from "./coverage";

describe("coverage gate", () => {
  test("keeps operational scripts in the standard TypeScript project", async () => {
    expect((await Bun.file("tsconfig.json").json()).include).toEqual([
      "backend",
      "tests",
      "scripts",
    ]);
    expect((await Bun.file("package.json").json()).scripts.check).toStartWith(
      "bun scripts/check-time-taxonomy.ts &&",
    );
    expect(excludedFromCoverage("backend/features/orders/routes.ts")).toBe(
      true,
    );
    expect(excludedFromCoverage("backend/features/orders/orders.ts")).toBe(
      false,
    );
  });

  test("averages deterministic modules without route orchestration", () => {
    const row = (path: string, functions: number, lines: number) =>
      ` ${path} | ${functions} | ${lines} |\n`;
    const coverage = parseReviewedCoverage(
      row("backend/features/orders/orders.ts", 90, 92) +
        row("backend/shared/values.ts", 100, 100) +
        row("backend/features/orders/routes.ts", 0, 0),
    );
    expect(coverage).toEqual({ functions: 95, lines: 96 });
    expect(() => parseReviewedCoverage("no rows")).toThrow();
  });

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
