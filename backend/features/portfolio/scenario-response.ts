import {
  normalizeIsoTime,
  providerTimeFields,
  unavailableProviderTimeFields,
  type EffectivePeriodInput,
} from "../../shared/time-provenance";
import type { CurrentPortfolioExposure } from "./exposure-service";
import {
  buildPortfolioScenarioReport,
  type CustomPortfolioScenario,
} from "./portfolio-scenarios";

type DateInput = string | number | Date;
type ExposureReport = CurrentPortfolioExposure["report"];

export const SCENARIO_MARKET_HISTORY_STALE_SECONDS = 7 * 86_400;
export const SCENARIO_FUTURE_TOLERANCE_SECONDS = 300;

const calculationSource = {
  provider: "local" as const,
  component: "portfolio-scenarios" as const,
  methodology: "deterministic-linear-shocks" as const,
};

const userInputSource = {
  provider: "user" as const,
  component: "portfolio-scenario-request" as const,
};

function evidenceTime(
  evidence: {
    observedAt?: DateInput | null;
    publishedAt?: DateInput | null;
    effectivePeriod?: EffectivePeriodInput | null;
    retrievedAt: DateInput;
  },
  serverRespondedAt: DateInput,
) {
  return providerTimeFields({
    observationTime: evidence.observedAt ?? null,
    publicationTime: evidence.publishedAt ?? null,
    effectivePeriod: evidence.effectivePeriod ?? null,
    retrievalTime: evidence.retrievedAt,
    serverResponseTime: serverRespondedAt,
  });
}

function optionalEvidenceTime(
  evidence: {
    observedAt?: DateInput | null;
    publishedAt?: DateInput | null;
    effectivePeriod?: EffectivePeriodInput | null;
    retrievedAt: DateInput | null;
  },
  serverRespondedAt: DateInput,
) {
  return evidence.retrievedAt === null
    ? unavailableProviderTimeFields(serverRespondedAt)
    : evidenceTime(
        { ...evidence, retrievedAt: evidence.retrievedAt },
        serverRespondedAt,
      );
}

export function scenarioMarketHistoryFreshness(
  observedAt: DateInput | null | undefined,
  evaluatedAt: DateInput,
) {
  const normalizedEvaluation = normalizeIsoTime(
    evaluatedAt,
    "Scenario freshness evaluation time",
  );
  if (observedAt === null || observedAt === undefined) {
    return {
      status: "unavailable" as const,
      observedAt: null,
      ageSeconds: null,
      staleAfterSeconds: SCENARIO_MARKET_HISTORY_STALE_SECONDS,
    };
  }
  const normalizedObservation = normalizeIsoTime(
    observedAt,
    "Scenario market-history observation time",
  );
  const rawAgeSeconds =
    (new Date(normalizedEvaluation).getTime() -
      new Date(normalizedObservation).getTime()) /
    1_000;
  if (rawAgeSeconds < -SCENARIO_FUTURE_TOLERANCE_SECONDS) {
    return {
      status: "future" as const,
      observedAt: normalizedObservation,
      ageSeconds: rawAgeSeconds,
      staleAfterSeconds: SCENARIO_MARKET_HISTORY_STALE_SECONDS,
    };
  }
  const ageSeconds = Math.max(0, rawAgeSeconds);
  return {
    status:
      ageSeconds > SCENARIO_MARKET_HISTORY_STALE_SECONDS
        ? ("stale" as const)
        : ("fresh" as const),
    observedAt: normalizedObservation,
    ageSeconds,
    staleAfterSeconds: SCENARIO_MARKET_HISTORY_STALE_SECONDS,
  };
}

/** Builds a scenario response without losing the exposure evidence it uses. */
export function portfolioScenarioDto(input: {
  equity: number;
  exposure: ExposureReport;
  custom?: CustomPortfolioScenario;
  serverRespondedAt: DateInput;
}) {
  const serverRespondedAt = normalizeIsoTime(
    input.serverRespondedAt,
    "Scenario server response time",
  );
  const exposureTime = evidenceTime(input.exposure, serverRespondedAt);
  const exposureBySymbol = new Map(
    input.exposure.positions.map((position) => [position.symbol, position]),
  );
  const providerEvidenceBySymbol = new Map(
    input.exposure.inputs.positionEvidence.map((position) => [
      position.symbol,
      position,
    ]),
  );
  const freshnessBySymbol = new Map(
    input.exposure.positions.map((position) => [
      position.symbol,
      scenarioMarketHistoryFreshness(position.observedAt, serverRespondedAt),
    ]),
  );
  const scenarioPositions = input.exposure.positions.map((position) => ({
    symbol: position.symbol,
    marketValue: position.marketValue,
    assetClass: position.assetClass,
    sector: position.sector,
    sic: position.sic,
    volatility20dPercent:
      freshnessBySymbol.get(position.symbol)?.status === "fresh"
        ? position.factors.volatility20dPercent
        : null,
  }));
  const report = buildPortfolioScenarioReport({
    equity: input.equity,
    positions: scenarioPositions,
    custom: input.custom,
    asOf: serverRespondedAt,
  });
  const omittedPositions = input.exposure.quality.omittedPositions;
  const expectedPositions = scenarioPositions.length + omittedPositions;
  const expectedEvaluations = expectedPositions * report.scenarios.length;
  const receivedEvaluations =
    scenarioPositions.length * report.scenarios.length;
  const modeledEvaluations = report.scenarios.reduce(
    (sum, scenario) =>
      sum +
      scenario.positions.filter((position) => position.shockPercent !== null)
        .length,
    0,
  );
  const scenarioCoverage = report.scenarios.map((scenario) => {
    const missingSymbols = scenario.positions
      .filter((position) => position.shockPercent === null)
      .map((position) => position.symbol);
    return {
      id: scenario.id,
      expectedPositions: scenarioPositions.length,
      modeledPositions: scenarioPositions.length - missingSymbols.length,
      omittedPositions: missingSymbols.length,
      grossExposureCoveragePercent: scenario.coveragePercent,
      missingSymbols,
      impact: missingSymbols.length
        ? "Unmodeled positions contribute zero to this scenario result."
        : "All bounded current positions contribute to this scenario result.",
    };
  });
  const missing = [
    ...(omittedPositions
      ? [
          `${omittedPositions} current position${omittedPositions === 1 ? " was" : "s were"} omitted by the upstream exposure bound.`,
        ]
      : []),
    ...scenarioCoverage.flatMap((coverage) =>
      coverage.missingSymbols.map(
        (symbol) => `${coverage.id}:${symbol}:required_input`,
      ),
    ),
  ];
  const impact = missing.length
    ? [
        "Displayed losses are bounded estimates: omitted or unmodeled positions contribute zero and can understate portfolio impact.",
      ]
    : [
        "Every bounded current position is represented in every displayed scenario.",
      ];
  const positionInputs = input.exposure.positions.map((position) => {
    const providerEvidence = providerEvidenceBySymbol.get(position.symbol);
    if (!providerEvidence)
      throw new Error(
        `Scenario position ${position.symbol} is missing provider input evidence`,
      );
    return {
      symbol: position.symbol,
      marketValue: position.marketValue,
      assetClass: position.assetClass,
      hasClassification: Boolean(position.sic && position.sector),
      hasVolatility: Number.isFinite(position.factors.volatility20dPercent),
      marketHistoryFreshness: freshnessBySymbol.get(position.symbol)!,
      currentPosition: {
        ...providerEvidence.currentPosition,
        ...evidenceTime(providerEvidence.currentPosition, serverRespondedAt),
      },
      marketHistory: {
        ...providerEvidence.marketHistory,
        ...optionalEvidenceTime(
          providerEvidence.marketHistory,
          serverRespondedAt,
        ),
      },
      classification: {
        ...providerEvidence.classification,
        ...optionalEvidenceTime(
          providerEvidence.classification,
          serverRespondedAt,
        ),
      },
      source: position.source,
      ...evidenceTime(position, serverRespondedAt),
    };
  });
  const freshnessCounts = {
    fresh: positionInputs.filter(
      (position) => position.marketHistoryFreshness.status === "fresh",
    ).length,
    stale: positionInputs.filter(
      (position) => position.marketHistoryFreshness.status === "stale",
    ).length,
    unavailable: positionInputs.filter(
      (position) => position.marketHistoryFreshness.status === "unavailable",
    ).length,
    future: positionInputs.filter(
      (position) => position.marketHistoryFreshness.status === "future",
    ).length,
  };
  const scenarioTime = {
    source: calculationSource,
    ...exposureTime,
  };

  return {
    ...report,
    schemaVersion: "portfolio-scenarios-v2",
    scenarios: report.scenarios.map((scenario) => ({
      ...scenario,
      positions: scenario.positions.map((position) => {
        const evidence = exposureBySymbol.get(position.symbol);
        if (!evidence)
          throw new Error(
            `Scenario position ${position.symbol} is missing exposure evidence`,
          );
        return {
          ...position,
          source: calculationSource,
          inputSource: evidence.source,
          ...evidenceTime(evidence, serverRespondedAt),
        };
      }),
      quality: scenarioCoverage.find(
        (coverage) => coverage.id === scenario.id,
      )!,
      ...scenarioTime,
    })),
    warnings: [
      ...new Set([...report.warnings, ...(missing.length ? impact : [])]),
    ],
    inputs: {
      exposure: {
        schemaVersion: input.exposure.schemaVersion,
        positionCount: scenarioPositions.length,
        omittedPositionCount: omittedPositions,
        qualityStatus: input.exposure.quality.status,
        source: input.exposure.source,
        ...exposureTime,
      },
      positions: positionInputs,
      customAssumptions: {
        provided: Boolean(input.custom),
        shockCount: input.custom?.shocks.length ?? 0,
        source: userInputSource,
        receivedAt: serverRespondedAt,
      },
    },
    quality: {
      status:
        expectedPositions === 0
          ? ("empty" as const)
          : missing.length
            ? ("partial" as const)
            : ("complete" as const),
      expected: {
        currentPositions: expectedPositions,
        scenarios: report.scenarios.length,
        positionEvaluations: expectedEvaluations,
      },
      received: {
        currentPositions: scenarioPositions.length,
        scenarios: report.scenarios.length,
        positionEvaluations: receivedEvaluations,
        modeledPositionEvaluations: modeledEvaluations,
      },
      omitted: {
        currentPositions: omittedPositions,
        positionEvaluations: expectedEvaluations - receivedEvaluations,
        unmodeledPositionEvaluations: receivedEvaluations - modeledEvaluations,
      },
      freshness: {
        evaluatedAt: serverRespondedAt,
        marketHistoryStaleAfterSeconds: SCENARIO_MARKET_HISTORY_STALE_SECONDS,
        marketHistories: freshnessCounts,
        currentPositions: {
          status: "retrieval_time_only" as const,
          observedAt: null,
          retrievedAt: input.exposure.inputs.positions.retrievedAt,
        },
        classifications: {
          status: "observation_time_unavailable" as const,
          withRetrievalTime: positionInputs.filter(
            (position) => position.classification.retrievedAt !== null,
          ).length,
        },
      },
      scenarios: scenarioCoverage,
      missing,
      impact,
      source: "Calculated from the bounded portfolio-scenario evidence set",
      ...exposureTime,
    },
    source: {
      calculation: calculationSource,
      exposure: input.exposure.source,
      customAssumptions: input.custom ? userInputSource : null,
    },
    ...exposureTime,
  };
}
