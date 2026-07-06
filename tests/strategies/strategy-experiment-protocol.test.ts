import { expect, test } from "bun:test";
import {
  currentStrategyExperimentProtocol,
  parseStrategyExperimentProtocol,
  strategyExperimentProtocols,
  withStrategyExperimentProtocolConfig,
} from "../../backend/features/strategies/strategy-experiment-protocol";

const config = {
  strategyId: "moving-average-trend",
  params: { fast: 5, slow: 20, exposure: 0.5 },
};

test("pre-registers immutable paper experiment protocol versions", () => {
  const first = parseStrategyExperimentProtocol(
    {
      hypothesis: "Trend exposure will beat cash after costs during this paper window.",
      startAt: "2026-07-08T00:00:00.000Z",
      stopAt: "2026-08-08T00:00:00.000Z",
      minimumObservations: 30,
      maximumBudget: 500,
      invalidationCriteria: [
        "Stop if max drawdown breaches ten percent.",
        "Stop if execution slippage exceeds assumptions.",
      ],
      reviewCadenceDays: 7,
    },
    {
      actor: "tester",
      config,
      now: new Date("2026-07-07T12:00:00.000Z"),
    },
  );
  const nextConfig = withStrategyExperimentProtocolConfig(config, first);
  const second = parseStrategyExperimentProtocol(
    {
      hypothesis: "Continue the same frozen parameters with a lower budget cap.",
      parameters: config.params,
      startDate: "2026-08-09T00:00:00.000Z",
      stopDate: "2026-09-09T00:00:00.000Z",
      minimumObservations: 20,
      maximumBudget: 250,
      invalidationCriteria: "Stop if the strategy misses two review cadences.",
      reviewCadence: 14,
    },
    {
      actor: "tester",
      config: nextConfig,
      now: new Date("2026-08-01T12:00:00.000Z"),
    },
  );
  const finalConfig = withStrategyExperimentProtocolConfig(nextConfig, second);

  expect(first).toMatchObject({
    protocolVersion: "strategy-paper-experiment-protocol-v1",
    version: 1,
    registeredBy: "tester",
    registeredAt: "2026-07-07T12:00:00.000Z",
    parameters: config.params,
    minimumObservations: 30,
    maximumBudget: 500,
    reviewCadenceDays: 7,
    protocolHash: expect.stringMatching(/^sha256:/),
  });
  expect(currentStrategyExperimentProtocol(finalConfig)).toMatchObject({
    version: 2,
    maximumBudget: 250,
  });
  expect(strategyExperimentProtocols(finalConfig).map((item) => item.version)).toEqual([
    1,
    2,
  ]);
});

test("rejects vague protocols and hidden parameter drift", () => {
  expect(() =>
    parseStrategyExperimentProtocol(
      {
        hypothesis: "Too short",
        parameters: { fast: 6, slow: 20, exposure: 0.5 },
        startAt: "2026-07-08T00:00:00.000Z",
        stopAt: "2026-08-08T00:00:00.000Z",
        minimumObservations: 30,
        maximumBudget: 500,
        invalidationCriteria: ["Stop if drawdown breaches the limit."],
        reviewCadenceDays: 7,
      },
      {
        actor: "tester",
        config,
        now: new Date("2026-07-07T12:00:00.000Z"),
      },
    ),
  ).toThrow("Protocol parameters must match");
  expect(() =>
    parseStrategyExperimentProtocol(
      {
        hypothesis: "Trend exposure paper test",
        startAt: "2026-08-08T00:00:00.000Z",
        stopAt: "2026-07-08T00:00:00.000Z",
        minimumObservations: 0,
        maximumBudget: 500,
        invalidationCriteria: [],
        reviewCadenceDays: 7,
      },
      {
        actor: "tester",
        config,
        now: new Date("2026-07-07T12:00:00.000Z"),
      },
    ),
  ).toThrow("Protocol stop must be after");
});
