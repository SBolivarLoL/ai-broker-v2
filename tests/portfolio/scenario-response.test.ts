import { expect, test } from "bun:test";
import type { CurrentPortfolioExposure } from "../../backend/features/portfolio/exposure-service";
import {
  portfolioScenarioDto,
  scenarioMarketHistoryFreshness,
} from "../../backend/features/portfolio/scenario-response";
import { CustomPortfolioScenario } from "../../backend/features/portfolio/portfolio-scenarios";

function exposureReport(input: {
  observedAt?: string | null;
  omittedPositions?: number;
  positions?: Array<{
    symbol: string;
    marketValue: number;
    assetClass: string;
    sector: string | null;
    sic: string | null;
    volatility20dPercent: number | null;
    observedAt?: string | null;
  }>;
}) {
  const retrievedAt = "2026-01-10T20:00:00.000Z";
  const respondedAt = "2026-01-10T20:00:01.000Z";
  const positions = input.positions ?? [];
  return {
    schemaVersion: "portfolio-exposure-v2",
    positions: positions.map((position) => ({
      ...position,
      factors: { volatility20dPercent: position.volatility20dPercent },
      source: {
        currentPosition: {
          provider: "alpaca",
          api: "trading",
          environment: "paper",
        },
        marketHistory: {
          provider: "alpaca",
          api: "market-data",
          feed: "iex",
        },
        classification: position.sic
          ? { provider: "sec", dataset: "submissions", taxonomy: "SIC" }
          : null,
      },
      observedAt: position.observedAt ?? input.observedAt ?? null,
      publishedAt: null,
      effectivePeriod: {
        start: "2025-12-01T20:00:00.000Z",
        end: position.observedAt ?? input.observedAt ?? null,
        label: `${position.symbol} exposure evidence window`,
      },
      retrievedAt,
      serverRespondedAt: respondedAt,
    })),
    quality: {
      status: positions.length ? "complete" : "empty",
      omittedPositions: input.omittedPositions ?? 0,
    },
    inputs: {
      positions: {
        retrievedAt,
      },
      positionEvidence: positions.map((position) => ({
        symbol: position.symbol,
        currentPosition: {
          source: {
            provider: "alpaca",
            api: "trading",
            environment: "paper",
          },
          observedAt: null,
          publishedAt: null,
          effectivePeriod: null,
          retrievedAt,
        },
        marketHistory: {
          queried: true,
          available: position.volatility20dPercent !== null,
          count: position.volatility20dPercent === null ? 0 : 20,
          rejected: 0,
          source: {
            provider: "alpaca",
            api: "market-data",
            feed: "iex",
          },
          observedAt: position.observedAt ?? input.observedAt ?? null,
          publishedAt: null,
          effectivePeriod: {
            start: "2025-12-01T20:00:00.000Z",
            end: position.observedAt ?? input.observedAt ?? null,
            label: `${position.symbol} IEX exposure-factor window`,
          },
          retrievedAt,
        },
        classification: {
          queried: true,
          available: Boolean(position.sic),
          source: {
            provider: "sec",
            dataset: "submissions",
            taxonomy: "SIC",
          },
          observedAt: null,
          publishedAt: null,
          effectivePeriod: null,
          retrievedAt: position.sic ? retrievedAt : null,
        },
      })),
    },
    source: {
      account: {
        provider: "alpaca",
        api: "trading",
        environment: "paper",
      },
      marketHistory: {
        provider: "alpaca",
        api: "market-data",
        feed: "iex",
      },
      classifications: {
        provider: "sec",
        dataset: "submissions",
        taxonomy: "SIC",
      },
    },
    observedAt: input.observedAt ?? null,
    publishedAt: null,
    effectivePeriod: input.observedAt
      ? {
          start: "2025-12-01T20:00:00.000Z",
          end: input.observedAt,
          label: "Trailing IEX exposure-factor input window",
        }
      : null,
    retrievedAt,
    serverRespondedAt: respondedAt,
    asOf: respondedAt,
  } as unknown as CurrentPortfolioExposure["report"];
}

test("scenario response preserves input time and refreshes response time", () => {
  const exposure = exposureReport({
    observedAt: "2026-01-09T20:00:00.000Z",
    positions: [
      {
        symbol: "AAPL",
        marketValue: 40_000,
        assetClass: "US equity",
        sector: "Manufacturing",
        sic: "3571",
        volatility20dPercent: 20,
      },
    ],
  });
  const response = portfolioScenarioDto({
    equity: 100_000,
    exposure,
    serverRespondedAt: "2026-01-10T20:00:02Z",
  });

  expect(response).toMatchObject({
    schemaVersion: "portfolio-scenarios-v2",
    observedAt: "2026-01-09T20:00:00.000Z",
    retrievedAt: "2026-01-10T20:00:00.000Z",
    serverRespondedAt: "2026-01-10T20:00:02.000Z",
    asOf: "2026-01-10T20:00:02.000Z",
    quality: {
      status: "complete",
      expected: {
        currentPositions: 1,
        scenarios: 3,
        positionEvaluations: 3,
      },
      received: {
        currentPositions: 1,
        scenarios: 3,
        positionEvaluations: 3,
        modeledPositionEvaluations: 3,
      },
      omitted: {
        currentPositions: 0,
        positionEvaluations: 0,
        unmodeledPositionEvaluations: 0,
      },
      freshness: {
        marketHistories: { fresh: 1, stale: 0, unavailable: 0, future: 0 },
      },
    },
    inputs: {
      exposure: {
        schemaVersion: "portfolio-exposure-v2",
        positionCount: 1,
        retrievedAt: "2026-01-10T20:00:00.000Z",
        serverRespondedAt: "2026-01-10T20:00:02.000Z",
      },
    },
    source: {
      calculation: { provider: "local", component: "portfolio-scenarios" },
    },
  });
  expect(response.scenarios[0]?.positions[0]).toMatchObject({
    symbol: "AAPL",
    observedAt: "2026-01-09T20:00:00.000Z",
    retrievedAt: "2026-01-10T20:00:00.000Z",
    serverRespondedAt: "2026-01-10T20:00:02.000Z",
    source: { provider: "local", component: "portfolio-scenarios" },
    inputSource: {
      currentPosition: { provider: "alpaca" },
      marketHistory: { feed: "iex" },
      classification: { provider: "sec" },
    },
  });
  expect(response.inputs.positions[0]).toMatchObject({
    symbol: "AAPL",
    currentPosition: {
      observedAt: null,
      retrievedAt: "2026-01-10T20:00:00.000Z",
      serverRespondedAt: "2026-01-10T20:00:02.000Z",
    },
    marketHistory: {
      observedAt: "2026-01-09T20:00:00.000Z",
      retrievedAt: "2026-01-10T20:00:00.000Z",
      serverRespondedAt: "2026-01-10T20:00:02.000Z",
    },
    classification: {
      observedAt: null,
      retrievedAt: "2026-01-10T20:00:00.000Z",
      serverRespondedAt: "2026-01-10T20:00:02.000Z",
    },
  });
});

test("scenario response excludes stale volatility and explains coverage impact", () => {
  const exposure = exposureReport({
    observedAt: "2025-12-20T20:00:00.000Z",
    omittedPositions: 1,
    positions: [
      {
        symbol: "AAPL",
        marketValue: 40_000,
        assetClass: "US equity",
        sector: "Manufacturing",
        sic: "3571",
        volatility20dPercent: 20,
      },
    ],
  });
  const response = portfolioScenarioDto({
    equity: 100_000,
    exposure,
    serverRespondedAt: "2026-01-10T20:00:02Z",
  });
  const volatility = response.scenarios.find(
    (scenario) => scenario.id === "volatility_spike",
  )!;

  expect(volatility.positions[0]).toMatchObject({
    symbol: "AAPL",
    shockPercent: null,
    estimatedPnl: null,
  });
  expect(volatility.quality).toMatchObject({
    modeledPositions: 0,
    omittedPositions: 1,
    missingSymbols: ["AAPL"],
  });
  expect(response.quality).toMatchObject({
    status: "partial",
    expected: { currentPositions: 2, positionEvaluations: 6 },
    received: {
      currentPositions: 1,
      positionEvaluations: 3,
      modeledPositionEvaluations: 2,
    },
    omitted: {
      currentPositions: 1,
      positionEvaluations: 3,
      unmodeledPositionEvaluations: 1,
    },
    freshness: {
      marketHistories: { fresh: 0, stale: 1, unavailable: 0, future: 0 },
    },
  });
  expect(response.quality.missing).toContain(
    "volatility_spike:AAPL:required_input",
  );
  expect(response.warnings).toContain(response.quality.impact[0]!);
});

test("scenario response reports empty and custom-request evidence explicitly", () => {
  const empty = portfolioScenarioDto({
    equity: 100_000,
    exposure: exposureReport({}),
    serverRespondedAt: "2026-01-10T20:00:02Z",
  });
  expect(empty.quality).toMatchObject({
    status: "empty",
    expected: { currentPositions: 0, positionEvaluations: 0 },
  });
  expect(empty.inputs.customAssumptions).toMatchObject({
    provided: false,
    shockCount: 0,
  });

  const unavailable = portfolioScenarioDto({
    equity: 100_000,
    exposure: exposureReport({
      positions: [
        {
          symbol: "BTC/USD",
          marketValue: 1_000,
          assetClass: "Crypto",
          sector: null,
          sic: null,
          volatility20dPercent: null,
        },
      ],
    }),
    serverRespondedAt: "2026-01-10T20:00:02Z",
  });
  expect(unavailable.inputs.positions[0]).toMatchObject({
    marketHistory: {
      observedAt: null,
      retrievedAt: "2026-01-10T20:00:00.000Z",
    },
    classification: {
      observedAt: null,
      retrievedAt: null,
      serverRespondedAt: "2026-01-10T20:00:02.000Z",
    },
  });
  expect(unavailable.quality.freshness.classifications).toMatchObject({
    status: "observation_time_unavailable",
    withRetrievalTime: 0,
  });

  const exposure = exposureReport({
    observedAt: "2026-01-09T20:00:00.000Z",
    positions: [
      {
        symbol: "AAPL",
        marketValue: 40_000,
        assetClass: "US equity",
        sector: "Manufacturing",
        sic: "3571",
        volatility20dPercent: 20,
      },
    ],
  });
  const custom = CustomPortfolioScenario.parse({
    name: "Custom decline",
    shocks: [{ symbol: "AAPL", shockPercent: -15 }],
  });
  const response = portfolioScenarioDto({
    equity: 100_000,
    exposure,
    custom,
    serverRespondedAt: "2026-01-10T20:00:02Z",
  });
  expect(response.scenarios[0]).toMatchObject({
    id: "custom",
    quality: { modeledPositions: 1, omittedPositions: 0 },
  });
  expect(response.inputs.customAssumptions).toMatchObject({
    provided: true,
    shockCount: 1,
    source: { provider: "user" },
    receivedAt: "2026-01-10T20:00:02.000Z",
  });
});

test("scenario market-history freshness distinguishes unavailable and future evidence", () => {
  expect(
    scenarioMarketHistoryFreshness(null, "2026-01-10T20:00:00Z"),
  ).toMatchObject({ status: "unavailable", observedAt: null });
  expect(
    scenarioMarketHistoryFreshness(
      "2026-01-10T20:06:00Z",
      "2026-01-10T20:00:00Z",
    ),
  ).toMatchObject({ status: "future" });
  expect(() =>
    scenarioMarketHistoryFreshness("invalid", "2026-01-10T20:00:00Z"),
  ).toThrow("observation time must be a valid timestamp");
});
