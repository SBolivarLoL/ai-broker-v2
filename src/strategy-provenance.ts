import { createHash } from "node:crypto";

export const STRATEGY_FEATURE_SCHEMA_VERSION = "strategy-features-v1";
export const STRATEGY_BACKTEST_POLICY_VERSION = "crypto-backtest-v1";

export type CodeIdentity = {
  gitCommit: string;
  workingTreeDirty: boolean;
};

export type StrategyProvenance = CodeIdentity & {
  pluginVersion: string;
  featureSchemaVersion: string;
  policyVersion: string;
  definitionHash: string;
  provider: string;
  feed: string;
  query: {
    start: string;
    end: string;
    timeframe: string;
    symbols: string[];
  };
  datasetHash: string;
};

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function canonicalHash(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function parseGitCommit(value: unknown) {
  const commit = String(value ?? "").trim().toLowerCase();
  if (!GIT_COMMIT.test(commit)) throw new Error("A full 40-character Git commit is required for strategy provenance");
  return commit;
}

export function resolveCodeIdentity(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): CodeIdentity {
  if (env.APP_GIT_COMMIT) {
    return { gitCommit: parseGitCommit(env.APP_GIT_COMMIT), workingTreeDirty: env.APP_GIT_DIRTY === "1" };
  }
  const commit = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd, stdout: "pipe", stderr: "pipe" });
  if (!commit.success) throw new Error("APP_GIT_COMMIT is required when the Git commit cannot be resolved");
  const dirty = Bun.spawnSync({ cmd: ["git", "status", "--porcelain", "--untracked-files=no"], cwd, stdout: "pipe", stderr: "pipe" });
  if (!dirty.success) throw new Error("The Git working-tree state could not be resolved");
  return {
    gitCommit: parseGitCommit(new TextDecoder().decode(commit.stdout)),
    workingTreeDirty: dirty.stdout.byteLength > 0,
  };
}

export function parseStrategyProvenance(value: StrategyProvenance): StrategyProvenance {
  const start = new Date(value.query?.start);
  const end = new Date(value.query?.end);
  if (!value.pluginVersion || !value.featureSchemaVersion || !value.policyVersion || !value.provider || !value.feed) throw new Error("Strategy provenance versions and provider are required");
  if (!SHA256.test(value.definitionHash) || !SHA256.test(value.datasetHash)) throw new Error("Strategy provenance hashes must be SHA-256");
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end || !value.query.timeframe || !value.query.symbols.length) throw new Error("Strategy provenance query is invalid");
  return {
    gitCommit: parseGitCommit(value.gitCommit),
    workingTreeDirty: Boolean(value.workingTreeDirty),
    pluginVersion: value.pluginVersion,
    featureSchemaVersion: value.featureSchemaVersion,
    policyVersion: value.policyVersion,
    definitionHash: value.definitionHash,
    provider: value.provider,
    feed: value.feed,
    query: {
      start: start.toISOString(),
      end: end.toISOString(),
      timeframe: value.query.timeframe,
      symbols: [...value.query.symbols],
    },
    datasetHash: value.datasetHash,
  };
}
