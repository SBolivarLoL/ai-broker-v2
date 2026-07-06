export const FUNCTION_FLOOR = 95;
export const LINE_FLOOR = 96;

/** Request composition is contract-tested; the percentage gate covers deterministic code. */
export function excludedFromCoverage(path: string) {
  return (
    path === "backend/app.ts" ||
    /^backend\/features\/.+\/(?:[^/]*routes|runtime)\.ts$/.test(path) ||
    [
      "backend/features/markets/service.ts",
      "backend/features/markets/stock-stream.ts",
      "backend/features/portfolio/exposure-service.ts",
      "backend/features/research/copilot.ts",
      "backend/features/research/research.ts",
    ].includes(path)
  );
}

export function parseCoverageSummary(output: string) {
  const match = output.match(
    /^All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/m,
  );
  if (!match) throw new Error("Bun coverage summary was not found");
  return { functions: Number(match[1]), lines: Number(match[2]) };
}

export function parseReviewedCoverage(output: string) {
  const rows = [
    ...output.matchAll(
      /^ (backend|scripts)\/([^|]+)\|\s+([\d.]+)\s+\|\s+([\d.]+)/gm,
    ),
  ]
    .map((match) => ({
      path: `${match[1]}/${match[2]!.trim()}`,
      functions: Number(match[3]),
      lines: Number(match[4]),
    }))
    .filter((row) => !excludedFromCoverage(row.path));
  if (!rows.length) throw new Error("Reviewed coverage rows were not found");
  return {
    functions: Number(
      (
        rows.reduce((total, row) => total + row.functions, 0) / rows.length
      ).toFixed(2),
    ),
    lines: Number(
      (rows.reduce((total, row) => total + row.lines, 0) / rows.length).toFixed(
        2,
      ),
    ),
  };
}

export function meetsCoverageFloor(coverage: {
  functions: number;
  lines: number;
}) {
  return coverage.functions >= FUNCTION_FLOOR && coverage.lines >= LINE_FLOOR;
}
