import { providerTimeFields } from "../../shared/time-provenance";
import type {
  CompanyResearch,
  ResearchEvidence,
  ResearchMetrics,
} from "./research";

const requiredCategories = [
  "market",
  "fundamentals",
  "filings",
  "news",
] as const;
const supplementalCategories = ["macro", "identity"] as const;

function latestTime(values: Array<string | null | undefined>) {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .toSorted()
      .at(-1) ?? null
  );
}

/** Builds the persisted and browser-visible evidence contract for a completed report. */
export function buildCompanyResearchCoverage(
  output: CompanyResearch,
  evidence: ResearchEvidence[],
  metrics: ResearchMetrics,
  serverRespondedAt: string,
) {
  const citedClaims =
    1 +
    output.thesis.length +
    output.risks.length +
    output.catalysts.length +
    output.keyMetrics.length;
  const expected = {
    researchTools: 5,
    requiredEvidenceCategories: requiredCategories.length,
    supplementalEvidenceCategories: supplementalCategories.length,
    citedClaims,
    numericMetrics: output.keyMetrics.length,
    sourceTimeRecords: evidence.length,
  };
  const received = {
    researchTools: Math.min(expected.researchTools, metrics.toolCalls),
    requiredEvidenceCategories: requiredCategories.filter((category) =>
      evidence.some((item) => item.category === category),
    ).length,
    supplementalEvidenceCategories: supplementalCategories.filter((category) =>
      evidence.some((item) => item.category === category),
    ).length,
    citedClaims: Math.min(
      citedClaims,
      Math.round(metrics.citationCoverage * citedClaims),
    ),
    numericMetrics: Math.min(
      output.keyMetrics.length,
      Math.round(metrics.numericGrounding * output.keyMetrics.length),
    ),
    sourceTimeRecords: evidence.filter(
      (item) => item.observedAt || item.publishedAt || item.effectivePeriod,
    ).length,
  };
  const omitted = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      Math.max(0, value - received[key as keyof typeof received]),
    ]),
  ) as Record<keyof typeof expected, number>;
  const observedAt = latestTime(evidence.map((item) => item.observedAt));
  const publishedAt = latestTime(evidence.map((item) => item.publishedAt));
  const effectiveStarts = evidence
    .map((item) => item.effectivePeriod?.start)
    .filter((value): value is string => Boolean(value))
    .toSorted();
  const effectiveEnds = evidence
    .map((item) => item.effectivePeriod?.end)
    .filter((value): value is string => Boolean(value))
    .toSorted();
  const effectivePeriod =
    effectiveStarts.length || effectiveEnds.length
      ? {
          start: effectiveStarts[0] ?? null,
          end: effectiveEnds.at(-1) ?? null,
          label: "Company research evidence periods",
        }
      : null;
  const retrievedAt =
    latestTime(evidence.map((item) => item.retrievedAt)) ?? serverRespondedAt;
  const rootTime = providerTimeFields({
    observationTime: observedAt,
    publicationTime: publishedAt,
    effectivePeriod,
    retrievalTime: retrievedAt,
    serverResponseTime: serverRespondedAt,
  });
  const missing = [
    ...(omitted.researchTools
      ? [
          `${omitted.researchTools} required research tools did not return evidence.`,
        ]
      : []),
    ...(omitted.requiredEvidenceCategories
      ? [
          `${omitted.requiredEvidenceCategories} required evidence categories are missing.`,
        ]
      : []),
    ...(omitted.supplementalEvidenceCategories
      ? [
          `${omitted.supplementalEvidenceCategories} supplemental macro or identity categories are missing.`,
        ]
      : []),
    ...(omitted.citedClaims
      ? [`${omitted.citedClaims} report claims lack a valid evidence citation.`]
      : []),
    ...(omitted.numericMetrics
      ? [
          `${omitted.numericMetrics} numeric metrics do not exactly match cited evidence.`,
        ]
      : []),
    ...(omitted.sourceTimeRecords
      ? [
          `${omitted.sourceTimeRecords} sources expose retrieval time only, without an observation, publication, or effective period.`,
        ]
      : []),
  ];
  const impact = [
    ...(omitted.researchTools || omitted.requiredEvidenceCategories
      ? [
          "The report lacks part of its required market, SEC, filing, or media evidence; conclusions should be treated as incomplete.",
        ]
      : []),
    ...(omitted.supplementalEvidenceCategories
      ? [
          "Missing macro or identity evidence limits context and cross-provider identity confidence without invalidating cited official facts.",
        ]
      : []),
    ...(omitted.citedClaims || omitted.numericMetrics
      ? [
          "Unsupported claims or numeric mismatches reduce grounding confidence even when the report passed the bounded output guardrail.",
        ]
      : []),
    ...(omitted.sourceTimeRecords
      ? [
          "Retrieval-only sources cannot be independently aged as provider observations or publications, so freshness conclusions remain limited.",
        ]
      : []),
  ];
  if (!impact.length) {
    impact.push(
      "All required and supplemental evidence, cited claims, numeric metrics, and source-time records are present.",
    );
  }
  return {
    quality: {
      status: missing.length ? ("partial" as const) : ("complete" as const),
      expected,
      received,
      omitted,
      freshness: {
        status: omitted.sourceTimeRecords
          ? ("partial_provider_time" as const)
          : ("semantic_time_available" as const),
        latestObservedAt: observedAt,
        latestPublishedAt: publishedAt,
        effectivePeriod,
        retrievedAt,
        evaluatedAt: rootTime.serverRespondedAt,
        agePolicy: "source_specific_semantic_time" as const,
      },
      missing,
      impact,
      source:
        "Bounded company-research tool, evidence, citation, metric, and provenance coverage",
      ...rootTime,
    },
    ...rootTime,
  };
}
