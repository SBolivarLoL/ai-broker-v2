/** Enforces the reviewed inventory of exported time-bearing DTO type literals. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const backend = join(root, "backend");
const timeKeys = new Set([
  "asOf",
  "observedAt",
  "publishedAt",
  "effectivePeriod",
  "retrievedAt",
  "serverRespondedAt",
  "time",
]);

type ReviewedException = {
  kind: "input" | "leaf" | "persistence" | "taxonomy";
  normalizedBy: string;
  reason: string;
};

const reviewed = new Map<string, ReviewedException>([
  [
    "backend/features/strategies/strategy-observability.ts#StrategyDecisionMetricInput",
    {
      kind: "input",
      normalizedBy: "buildStrategyDecisionMetrics",
      reason:
        "Local metric input; asOf is the metric sample time, not a provider DTO.",
    },
  ],
  [
    "backend/features/markets/multi-asset.ts#MultiAssetDtoInput",
    {
      kind: "input",
      normalizedBy: "multiAssetDto",
      reason:
        "Builder input; multiAssetDto emits the complete provider time contract.",
    },
  ],
  [
    "backend/features/markets/market-workspace.ts#MarketWorkspaceSource",
    {
      kind: "input",
      normalizedBy: "discoveryDto",
      reason:
        "Raw discovery aggregation input; discoveryDto emits normalized child and root time.",
    },
  ],
  [
    "backend/features/markets/market-workspace.ts#MarketCalendarSource",
    {
      kind: "input",
      normalizedBy: "calendarDto",
      reason:
        "Raw calendar aggregation input; calendarDto emits normalized child and root time.",
    },
  ],
  [
    "backend/features/portfolio/optimizer-response.ts#OptimizerBar",
    {
      kind: "leaf",
      normalizedBy: "historyTime",
      reason:
        "Leaf market observation; its parent history owns retrieval, response, and effective-window time.",
    },
  ],
  [
    "backend/features/portfolio/optimizer-response.ts#OptimizerHistoryEvidence",
    {
      kind: "input",
      normalizedBy: "portfolioOptimizerDto",
      reason:
        "Normalized provider input; portfolioOptimizerDto adds full per-history and root time.",
    },
  ],
  [
    "backend/features/portfolio/portfolio-exposure.ts#ExposureBar",
    {
      kind: "leaf",
      normalizedBy: "portfolioExposureDto",
      reason:
        "Leaf bar observation consumed by the browser-facing exposure response normalizer.",
    },
  ],
  [
    "backend/features/portfolio/ledger.ts#LedgerActivity",
    {
      kind: "persistence",
      normalizedBy: "accountActivityDto",
      reason:
        "Durable broker row; accountActivityDto adds response time and the normalized time object.",
    },
  ],
  [
    "backend/features/portfolio/rebalance-response.ts#RebalanceMarketEvidence",
    {
      kind: "input",
      normalizedBy: "portfolioRebalanceDto",
      reason:
        "Validated market/asset input; portfolioRebalanceDto emits source-specific full time fields.",
    },
  ],
  [
    "backend/shared/time-provenance.ts#NormalizedTimeProvenance",
    {
      kind: "taxonomy",
      normalizedBy: "normalizeTimeProvenance",
      reason:
        "This is the normalized time object itself, so it must not contain a nested time object.",
    },
  ],
  [
    "backend/shared/time-provenance.ts#TimeProvenanceInput",
    {
      kind: "taxonomy",
      normalizedBy: "normalizeTimeProvenance",
      reason:
        "This is the input to the shared time normalizer, not an output DTO.",
    },
  ],
  [
    "backend/persistence/strategy-store.ts#StrategyDataSnapshotInput",
    {
      kind: "persistence",
      normalizedBy: "createStrategyStore",
      reason:
        "Persistence input; strategy dashboard/report DTOs normalize stored observation and response time.",
    },
  ],
  [
    "backend/persistence/strategy-store.ts#StrategyMetricInput",
    {
      kind: "persistence",
      normalizedBy: "createStrategyStore",
      reason: "Local metric persistence input; asOf is the metric sample time.",
    },
  ],
]);

function files(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory()
        ? files(path)
        : path.endsWith(".ts")
          ? [path]
          : [];
    });
}

function exported(statement: ts.Statement) {
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function typeMembers(statement: ts.Statement) {
  if (
    ts.isTypeAliasDeclaration(statement) &&
    ts.isTypeLiteralNode(statement.type)
  )
    return { name: statement.name.text, members: statement.type.members };
  if (ts.isInterfaceDeclaration(statement))
    return { name: statement.name.text, members: statement.members };
  return null;
}

function memberName(member: ts.TypeElement) {
  const name = member.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name))
    ? name.text
    : null;
}

const sourceFiles = files(backend);
const backendText = sourceFiles
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const exceptions = new Set<string>();
let normalized = 0;

for (const path of sourceFiles) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!exported(statement)) continue;
    const declaration = typeMembers(statement);
    if (!declaration) continue;
    const keys = declaration.members
      .map(memberName)
      .filter((name): name is string => name !== null);
    if (!keys.some((key) => timeKeys.has(key))) continue;
    if (keys.includes("time")) {
      normalized++;
      continue;
    }
    const file = relative(root, path).replaceAll("\\", "/");
    const id = `${file}#${declaration.name}`;
    const exception = reviewed.get(id);
    if (!exception)
      throw new Error(
        `${id} exports time-bearing fields without a normalized time object or reviewed classification`,
      );
    if (!backendText.includes(exception.normalizedBy))
      throw new Error(
        `${id} references missing normalizer ${exception.normalizedBy}`,
      );
    exceptions.add(id);
  }
}

const stale = [...reviewed.keys()].filter((id) => !exceptions.has(id));
if (stale.length)
  throw new Error(`Stale time-taxonomy classifications: ${stale.join(", ")}`);

console.log(
  `Reviewed time taxonomy: ${normalized} normalized exported DTO types; ${exceptions.size} classified inputs, leaves, persistence records, or taxonomy types`,
);
