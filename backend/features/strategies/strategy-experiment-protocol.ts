/** Pre-registers immutable paper-experiment protocols for strategy runs. */
import { canonicalHash } from "./strategy-provenance";

export type StrategyExperimentProtocol = {
  protocolVersion: "strategy-paper-experiment-protocol-v1";
  version: number;
  registeredAt: string;
  registeredBy: string;
  hypothesis: string;
  parameters: Record<string, unknown>;
  parameterHash: string;
  startAt: string;
  stopAt: string;
  minimumObservations: number;
  maximumBudget: number;
  invalidationCriteria: string[];
  reviewCadenceDays: number;
  protocolHash: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  label: string,
  min: number,
  max: number,
) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max)
    throw new Error(`${label} must be ${min} to ${max} characters`);
  return text;
}

function integerInRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`${label} must be ${min} to ${max}`);
  return number;
}

function numberInRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    throw new Error(`${label} must be ${min} to ${max}`);
  return number;
}

function isoDate(value: unknown, label: string) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date.toISOString();
}

function invalidationCriteria(value: unknown) {
  const items = Array.isArray(value) ? value : [value];
  const criteria = items.map((item) =>
    boundedText(item, "Invalidation criterion", 5, 300),
  );
  if (criteria.length < 1 || criteria.length > 10)
    throw new Error("Invalidation criteria must contain 1 to 10 items");
  return [...new Set(criteria)];
}

export function strategyExperimentProtocols(config: unknown) {
  if (!isRecord(config)) return [];
  const history = Array.isArray(config.experimentProtocols)
    ? config.experimentProtocols.filter(isRecord)
    : [];
  const current = isRecord(config.experimentProtocol)
    ? [config.experimentProtocol]
    : [];
  return [...history, ...current].filter(
    (item, index, items) =>
      items.findIndex((candidate) => candidate.protocolHash === item.protocolHash) ===
      index,
  ) as StrategyExperimentProtocol[];
}

export function currentStrategyExperimentProtocol(config: unknown) {
  if (!isRecord(config) || !isRecord(config.experimentProtocol)) return null;
  return config.experimentProtocol as StrategyExperimentProtocol;
}

export function parseStrategyExperimentProtocol(
  input: Record<string, unknown>,
  context: {
    actor: string;
    config: unknown;
    now?: Date;
  },
) {
  const config = isRecord(context.config) ? context.config : {};
  const runParameters = isRecord(config.params) ? config.params : {};
  const suppliedParameters = isRecord(input.parameters)
    ? input.parameters
    : runParameters;
  const parameterHash = canonicalHash(suppliedParameters);
  if (parameterHash !== canonicalHash(runParameters))
    throw new Error(
      "Protocol parameters must match the reviewed run parameters; create a new backtest and run for changed parameters",
    );

  const now = context.now ?? new Date();
  const startAt = isoDate(input.startAt ?? input.startDate, "Protocol start");
  const stopAt = isoDate(input.stopAt ?? input.stopDate, "Protocol stop");
  const startTime = new Date(startAt).getTime();
  const stopTime = new Date(stopAt).getTime();
  if (startTime >= stopTime)
    throw new Error("Protocol stop must be after protocol start");
  if (stopTime <= now.getTime())
    throw new Error("Protocol stop must be in the future");

  const previous = strategyExperimentProtocols(config);
  const draft = {
    protocolVersion: "strategy-paper-experiment-protocol-v1" as const,
    version:
      previous.reduce(
        (highest, protocol) => Math.max(highest, Number(protocol.version) || 0),
        0,
      ) + 1,
    registeredAt: now.toISOString(),
    registeredBy: context.actor,
    hypothesis: boundedText(input.hypothesis, "Hypothesis", 10, 1_000),
    parameters: suppliedParameters,
    parameterHash,
    startAt,
    stopAt,
    minimumObservations: integerInRange(
      input.minimumObservations,
      "Minimum observations",
      1,
      100_000,
    ),
    maximumBudget: numberInRange(input.maximumBudget, "Maximum budget", 1, 100_000),
    invalidationCriteria: invalidationCriteria(input.invalidationCriteria),
    reviewCadenceDays: integerInRange(
      input.reviewCadenceDays ?? input.reviewCadence,
      "Review cadence days",
      1,
      90,
    ),
  };
  return { ...draft, protocolHash: canonicalHash(draft) };
}

export function withStrategyExperimentProtocolConfig(
  config: unknown,
  protocol: StrategyExperimentProtocol,
) {
  const base = isRecord(config) ? { ...config } : {};
  return {
    ...base,
    experimentProtocol: protocol,
    experimentProtocols: [...strategyExperimentProtocols(base), protocol],
  };
}
