import {
  FUNCTION_FLOOR,
  LINE_FLOOR,
  meetsCoverageFloor,
  parseReviewedCoverage,
} from "./coverage";

const child = Bun.spawn(["bun", "test", "--coverage"], {
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
process.stdout.write(stdout);
process.stderr.write(stderr);
if (exitCode !== 0) process.exit(exitCode);

const coverage = parseReviewedCoverage(`${stdout}\n${stderr}`);
console.log(
  `Reviewed coverage boundary: ${coverage.functions}% functions, ${coverage.lines}% lines`,
);
if (!meetsCoverageFloor(coverage)) {
  console.error(
    `Coverage below floor: ${coverage.functions}% functions (need ${FUNCTION_FLOOR}%), ` +
      `${coverage.lines}% lines (need ${LINE_FLOOR}%)`,
  );
  process.exit(1);
}
