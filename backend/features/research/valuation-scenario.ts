/**
 * Applies ordered user assumptions to disclosed SEC inputs and emits a
 * formula-backed valuation memo; it does not generate forecasts.
 */
import { z } from "zod";
import {
  replayComparableValuation,
  type ComparableValuationReplay,
  type ComparableValuationEvidence,
  type ComparableValuationRow,
} from "./comparable-valuation";
import {
  canonicalEvidence,
  dedupeEvidence,
  evidenceContentHash,
  stableEvidenceJson,
  type CanonicalEvidence,
} from "../../shared/evidence";
import { providerTimeFields } from "../../shared/time-provenance";

const Assumption = z.object({
  revenueGrowthPercent: z.number().finite().min(-99).max(200),
  netMarginPercent: z.number().finite().min(-100).max(100),
  priceToEarnings: z.number().finite().min(0.1).max(200),
});

const cases = ["bear", "base", "bull"] as const;
const metrics = [
  "revenueGrowthPercent",
  "netMarginPercent",
  "priceToEarnings",
] as const;
const metricLabels = {
  revenueGrowthPercent: "revenue growth",
  netMarginPercent: "net margin",
  priceToEarnings: "P/E",
} as const;
export const ValuationScenarioInput = z
  .object({ bear: Assumption, base: Assumption, bull: Assumption })
  .superRefine((value, context) => {
    for (const metric of metrics) {
      if (
        value.bear[metric] <= value.base[metric] &&
        value.base[metric] <= value.bull[metric]
      )
        continue;
      context.addIssue({
        code: "custom",
        path: [metric],
        message: `Bear, base and bull ${metricLabels[metric]} assumptions must be ordered from low to high`,
      });
    }
  });
export type ValuationScenarioAssumptions = z.infer<
  typeof ValuationScenarioInput
>;

const round = (value: number) => Number(value.toFixed(6));
const label = (scenario: (typeof cases)[number]) =>
  scenario[0].toUpperCase() + scenario.slice(1);
type ScenarioEvidence = CanonicalEvidence<
  unknown,
  "fundamentals" | "market" | "valuation"
>;
const latestTime = (values: (string | null | undefined)[]) =>
  values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

export function buildValuationScenarioMemo(
  row: ComparableValuationRow,
  sources: ComparableValuationEvidence[],
  rawAssumptions: unknown,
  retrievedAt = new Date().toISOString(),
  context: {
    priceMode?: "latest_retrieval" | "historical_daily_close";
    pointInTime?: {
      status: "not_requested" | "applied";
      asOfDate: string | null;
      cutoffAt: string | null;
    };
  } = {},
) {
  const assumptions = ValuationScenarioInput.parse(rawAssumptions);
  const asOf = new Date(retrievedAt).toISOString();
  const evidenceId = `valuation:scenarios:${row.symbol}:${asOf}`;
  const inputEvidence = [row.evidence.sec, row.evidence.price];
  const warnings = [
    "These are user-entered assumptions, not company guidance or predictions.",
  ];
  if (row.annualRevenue === null || row.annualRevenue <= 0)
    warnings.push(
      "Directly reported annual SEC revenue is unavailable or non-positive.",
    );
  if (row.sharesOutstanding === null || row.sharesOutstanding <= 0)
    warnings.push(
      "Latest SEC shares outstanding are unavailable or non-positive.",
    );
  if (row.sharesOutstanding !== null)
    warnings.push(
      "Latest SEC shares outstanding do not model future dilution, every share class or ADR conversion terms.",
    );

  const scenarios = cases.map((scenario) => {
    const input = assumptions[scenario];
    const projectedRevenue =
      row.annualRevenue !== null && row.annualRevenue > 0
        ? round(row.annualRevenue * (1 + input.revenueGrowthPercent / 100))
        : null;
    const projectedNetIncome =
      projectedRevenue !== null
        ? round((projectedRevenue * input.netMarginPercent) / 100)
        : null;
    const impliedMarketCap =
      projectedNetIncome !== null && projectedNetIncome > 0
        ? round(projectedNetIncome * input.priceToEarnings)
        : null;
    const impliedPrice =
      impliedMarketCap !== null &&
      row.sharesOutstanding !== null &&
      row.sharesOutstanding > 0
        ? round(impliedMarketCap / row.sharesOutstanding)
        : null;
    // Negative projected earnings intentionally produce no P/E-derived value;
    // applying a positive multiple would create a misleading negative price.
    const returnPercent =
      impliedPrice !== null
        ? round((impliedPrice / row.price - 1) * 100)
        : null;
    const assumptionText = `${label(scenario)} assumes ${input.revenueGrowthPercent}% revenue growth, ${input.netMarginPercent}% net margin and a ${input.priceToEarnings}x P/E after 12 months.`;
    const memo =
      impliedPrice === null
        ? `${assumptionText} A mechanical implied price is unavailable because the source inputs or projected earnings are not positive.`
        : `${assumptionText} Applied to the latest eligible annual SEC revenue and SEC shares outstanding, the model implies $${impliedPrice.toFixed(2)} per share, ${returnPercent! >= 0 ? "+" : ""}${returnPercent!.toFixed(1)}% versus the ${context.priceMode === "historical_daily_close" ? "selected historical IEX daily close" : "latest returned Alpaca IEX price"}.`;
    return {
      case: scenario,
      horizonMonths: 12,
      assumptions: input,
      projectedRevenue,
      projectedNetIncome,
      impliedMarketCap,
      impliedPrice,
      returnPercent,
      status:
        impliedPrice === null
          ? ("unavailable" as const)
          : ("available" as const),
      memo,
      evidence: [...inputEvidence, evidenceId],
    };
  });

  const formulas = {
    projectedRevenue:
      "latest annual SEC revenue * (1 + user revenue growth assumption)",
    projectedNetIncome: "projected revenue * user net margin assumption",
    impliedMarketCap: "positive projected net income * user P/E assumption",
    impliedPrice: "implied market cap / latest SEC shares outstanding",
    returnPercent: `(implied price / ${context.priceMode === "historical_daily_close" ? "selected historical IEX daily close" : "latest returned Alpaca IEX price"} - 1) * 100`,
  };
  const sourceUrl =
    sources.find((source) => source.id === row.evidence.sec)?.url ??
    "https://www.sec.gov/edgar";
  const scenarioSource = canonicalEvidence({
    id: evidenceId,
    provider: "ai-broker",
    sourceId: `${row.symbol}:scenarios:${asOf}`,
    category: "valuation",
    authority: "derived",
    claimStatus: "derived_analysis",
    title: `${row.symbol} user-assumption valuation scenarios`,
    url: sourceUrl,
    asOf,
    retrievedAt: asOf,
    serverRespondedAt: asOf,
    observedAt: null,
    publishedAt: null,
    effectivePeriod: null,
    entityIds: { symbol: row.symbol },
    data: {
      symbol: row.symbol,
      horizonMonths: 12,
      assumptionSource: "user-entered",
      assumptions,
      scenarios,
      formulas,
      inputs: inputEvidence,
    },
  });
  const selectedSources = sources.filter((source) =>
    inputEvidence.includes(source.id),
  );
  const deduped = dedupeEvidence([
    ...selectedSources,
    scenarioSource,
  ] as ScenarioEvidence[]);
  const publishedAt = latestTime(
    selectedSources.map((source) => source.publishedAt),
  );
  const effectiveStarts = selectedSources
    .map((source) => source.effectivePeriod?.start)
    .filter((value): value is string => Boolean(value))
    .sort();
  const effectiveEnds = selectedSources
    .map((source) => source.effectivePeriod?.end)
    .filter((value): value is string => Boolean(value))
    .sort();
  const effectivePeriod =
    effectiveStarts.length && effectiveEnds.length
      ? {
          start: effectiveStarts[0]!,
          end: effectiveEnds.at(-1)!,
          label: "Scenario valuation source periods",
        }
      : null;
  const externalRetrievedAt =
    latestTime(selectedSources.map((source) => source.retrievedAt)) ?? asOf;
  const marketSource = selectedSources.find(
    (source) => source.category === "market",
  );
  const rootTime = providerTimeFields({
    observationTime: marketSource?.observedAt ?? null,
    publicationTime: publishedAt,
    effectivePeriod,
    retrievalTime: externalRetrievedAt,
    serverResponseTime: asOf,
  });
  const expected = {
    secFundamentals: 2,
    prices: 1,
    marketPriceObservations: 1,
    assumptionCases: 3,
    scenarioOutputs: 3,
  };
  const received = {
    secFundamentals:
      Number(row.annualRevenue !== null && row.annualRevenue > 0) +
      Number(row.sharesOutstanding !== null && row.sharesOutstanding > 0),
    prices: Number(Number.isFinite(row.price) && row.price > 0),
    marketPriceObservations: Number(
      marketSource?.observedAt !== null &&
        marketSource?.observedAt !== undefined,
    ),
    assumptionCases: cases.length,
    scenarioOutputs: scenarios.filter(
      (scenario) => scenario.status === "available",
    ).length,
  };
  const omitted = {
    secFundamentals: expected.secFundamentals - received.secFundamentals,
    prices: expected.prices - received.prices,
    marketPriceObservations:
      expected.marketPriceObservations - received.marketPriceObservations,
    assumptionCases: expected.assumptionCases - received.assumptionCases,
    scenarioOutputs: expected.scenarioOutputs - received.scenarioOutputs,
  };
  const missing = [
    ...(omitted.secFundamentals
      ? [
          `${omitted.secFundamentals} required SEC scenario inputs are unavailable.`,
        ]
      : []),
    ...(omitted.marketPriceObservations
      ? [
          "The latest returned IEX price has retrieval time but no provider observation time.",
        ]
      : []),
    ...(omitted.scenarioOutputs
      ? [
          `${omitted.scenarioOutputs} scenario outputs are unavailable because source inputs or projected earnings are not positive.`,
        ]
      : []),
  ];
  const impact = omitted.scenarioOutputs
    ? [
        "Unavailable scenario cases have no implied price or return; the remaining cases are mechanical user-assumption illustrations, not forecasts.",
      ]
    : omitted.marketPriceObservations
      ? [
          "All mechanical cases are calculated, but price freshness cannot be independently aged because the provider observation time is unavailable.",
        ]
      : [
          "All three user-assumption cases are calculated from the disclosed SEC and market inputs with explicit source timing.",
        ];
  return {
    schemaVersion: "valuation-scenarios-v3",
    priceMode: context.priceMode ?? "latest_retrieval",
    pointInTime: context.pointInTime ?? {
      status: "not_requested" as const,
      asOfDate: null,
      cutoffAt: null,
    },
    symbol: row.symbol,
    companyName: row.companyName,
    referencePrice: row.price,
    calculatedAt: asOf,
    baseline: {
      annualRevenue: row.annualRevenue,
      netMarginPercent: row.netMarginPercent,
      priceToEarnings: row.priceToEarnings,
      sharesOutstanding: row.sharesOutstanding,
      periods: row.periods,
      source:
        context.priceMode === "historical_daily_close"
          ? "Point-in-time SEC fundamentals and historical Alpaca IEX daily close"
          : "SEC fundamentals and latest returned Alpaca IEX price",
      ...rootTime,
    },
    scenarios: scenarios.map((scenario) => ({
      ...scenario,
      source: "Local deterministic user-assumption valuation",
      ...rootTime,
    })),
    sources: deduped.records,
    warnings: [...new Set(warnings)],
    formulas,
    quality: {
      status: missing.length ? "partial" : "complete",
      expected,
      received,
      omitted,
      freshness: {
        status: received.marketPriceObservations
          ? "observed"
          : "retrieval_time_only",
        latestPublishedAt: publishedAt,
        effectivePeriod,
        retrievedAt: externalRetrievedAt,
        evaluatedAt: rootTime.serverRespondedAt,
        agePolicy:
          context.priceMode === "historical_daily_close"
            ? "historical_price_must_not_exceed_cutoff"
            : "market_price_observation_unavailable",
      },
      missing,
      impact,
      source:
        "Calculated from bounded SEC, Alpaca, and user-assumption evidence",
      ...rootTime,
    },
    ...rootTime,
  };
}

export type ValuationScenarioReplay = {
  schemaVersion: "valuation-scenario-replay-v1";
  payloadPolicy: "stored_point_in_time_parent_and_user_assumptions";
  calculationVersion: "valuation-scenarios-v3";
  parentReplay: ComparableValuationReplay;
  assumptions: ValuationScenarioAssumptions;
  memo: ReturnType<typeof buildValuationScenarioMemo>;
  contentHash: string;
};

function scenarioParentInputs(parentReplay: ComparableValuationReplay) {
  const parent = replayComparableValuation(parentReplay).report;
  const row = parent.rows.find((candidate) => candidate.symbol === parent.subject);
  if (!row)
    throw new Error("Historical valuation subject inputs are unavailable");
  return { parent, row };
}

export function buildValuationScenarioReplay(
  parentReplay: ComparableValuationReplay,
  rawAssumptions: unknown,
  calculatedAt = new Date().toISOString(),
): ValuationScenarioReplay {
  const assumptions = ValuationScenarioInput.parse(rawAssumptions);
  const { parent, row } = scenarioParentInputs(parentReplay);
  const memo = buildValuationScenarioMemo(
    row,
    parent.sources,
    assumptions,
    calculatedAt,
    {
      priceMode: parent.priceMode,
      pointInTime: {
        status: parent.pointInTime.status,
        asOfDate: parent.pointInTime.asOfDate,
        cutoffAt: parent.pointInTime.cutoffAt,
      },
    },
  );
  const manifest = JSON.parse(
    stableEvidenceJson({
      schemaVersion: "valuation-scenario-replay-v1" as const,
      payloadPolicy: "stored_point_in_time_parent_and_user_assumptions" as const,
      calculationVersion: "valuation-scenarios-v3" as const,
      parentReplay,
      assumptions,
      memo,
    }),
  ) as Omit<ValuationScenarioReplay, "contentHash">;
  return { ...manifest, contentHash: evidenceContentHash(manifest) };
}

export function replayValuationScenario(value: unknown) {
  if (!value || typeof value !== "object")
    throw new Error("Valuation scenario replay is invalid");
  const replay = value as ValuationScenarioReplay;
  const { contentHash, ...manifest } = replay;
  if (
    replay.schemaVersion !== "valuation-scenario-replay-v1" ||
    replay.calculationVersion !== "valuation-scenarios-v3" ||
    contentHash !== evidenceContentHash(manifest)
  )
    throw new Error("Valuation scenario replay integrity check failed");
  const assumptions = ValuationScenarioInput.parse(replay.assumptions);
  const { parent, row } = scenarioParentInputs(replay.parentReplay);
  const recomputed = buildValuationScenarioMemo(
    row,
    parent.sources,
    assumptions,
    replay.memo.calculatedAt,
    {
      priceMode: parent.priceMode,
      pointInTime: {
        status: parent.pointInTime.status,
        asOfDate: parent.pointInTime.asOfDate,
        cutoffAt: parent.pointInTime.cutoffAt,
      },
    },
  );
  if (evidenceContentHash(recomputed) !== evidenceContentHash(replay.memo))
    throw new Error("Valuation scenario deterministic recomputation failed");
  return {
    schemaVersion: "valuation-scenario-replay-result-v1" as const,
    status: "verified" as const,
    providerRequests: 0 as const,
    replayHash: contentHash,
    parentReplayHash: replay.parentReplay.contentHash,
    memo: recomputed,
  };
}
