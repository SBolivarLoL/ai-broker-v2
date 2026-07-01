export const FUNCTION_FLOOR = 95;
export const LINE_FLOOR = 96;

export function parseCoverageSummary(output: string) {
  const match = output.match(/^All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/m);
  if (!match) throw new Error("Bun coverage summary was not found");
  return { functions: Number(match[1]), lines: Number(match[2]) };
}

export function meetsCoverageFloor(coverage: { functions: number; lines: number }) {
  return coverage.functions >= FUNCTION_FLOOR && coverage.lines >= LINE_FLOOR;
}
