import {
  providerTimeFields,
  type EffectivePeriodInput,
  type ProviderTimeFields,
} from "../../shared/time-provenance";

export type AdvisorEvidencePhase = "question" | "proposal" | "review";

export type AdvisorEvidenceRecord = ProviderTimeFields & {
  evidenceId: string;
  phase: AdvisorEvidencePhase;
  source: string;
  kind: "provider" | "local";
};

type QuestionOutput = {
  claims: Array<{ evidence: string[] }>;
};

type PlanOutput = {
  ideas: Array<{
    evidence: string[];
    actionable: boolean;
    simulationId: string | null;
    riskReview: { evidence: string[] };
  }>;
};

function latestTime(values: Array<string | null | undefined>) {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .toSorted()
      .at(-1) ?? null
  );
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function expectsProviderTime(evidenceId: string) {
  return !evidenceId.startsWith("simulation:");
}

function recordFor(
  records: AdvisorEvidenceRecord[],
  phase: AdvisorEvidencePhase,
  evidenceId: string,
) {
  return records.find(
    (record) => record.phase === phase && record.evidenceId === evidenceId,
  );
}

export function buildAdvisorEvidenceRecord(input: {
  evidenceId: string;
  phase: AdvisorEvidencePhase;
  source: string;
  kind?: "provider" | "local";
  observationTime?: string | Date | number | null;
  publicationTime?: string | Date | number | null;
  effectivePeriod?: EffectivePeriodInput | null;
  retrievedAt?: string;
}): AdvisorEvidenceRecord {
  const retrievedAt = input.retrievedAt ?? new Date().toISOString();
  return {
    evidenceId: input.evidenceId,
    phase: input.phase,
    source: input.source,
    kind: input.kind ?? "provider",
    ...providerTimeFields({
      observationTime: input.observationTime,
      publicationTime: input.publicationTime,
      effectivePeriod: input.effectivePeriod,
      retrievalTime: retrievedAt,
      serverResponseTime: retrievedAt,
    }),
  };
}

function buildTimeContract(input: {
  records: AdvisorEvidenceRecord[];
  retrievedAt: string;
  serverRespondedAt: string;
}) {
  const observedAt = latestTime(input.records.map((item) => item.observedAt));
  const publishedAt = latestTime(input.records.map((item) => item.publishedAt));
  const starts = input.records
    .map((item) => item.effectivePeriod?.start)
    .filter((value): value is string => Boolean(value))
    .toSorted();
  const ends = input.records
    .map((item) => item.effectivePeriod?.end)
    .filter((value): value is string => Boolean(value))
    .toSorted();
  return providerTimeFields({
    observationTime: observedAt,
    publicationTime: publishedAt,
    effectivePeriod:
      starts.length || ends.length
        ? {
            start: starts[0] ?? null,
            end: ends.at(-1) ?? null,
            label: "Advisor cited provider evidence periods",
          }
        : null,
    retrievalTime: input.retrievedAt,
    serverResponseTime: input.serverRespondedAt,
  });
}

function finishCoverage(input: {
  report: "Portfolio Q&A" | "Guided rebalance";
  expected: Record<string, number>;
  received: Record<string, number>;
  records: AdvisorEvidenceRecord[];
  citedProviderRecords: AdvisorEvidenceRecord[];
  retrievedAt: string;
  serverRespondedAt: string;
  missing: string[];
  impact: string[];
}) {
  const omitted = Object.fromEntries(
    Object.entries(input.expected).map(([key, value]) => [
      key,
      Math.max(0, value - (input.received[key] ?? 0)),
    ]),
  );
  const providerTimeRecords = input.citedProviderRecords.filter(
    (record) =>
      record.observedAt || record.publishedAt || record.effectivePeriod,
  ).length;
  const missingProviderTime = Math.max(
    0,
    input.citedProviderRecords.length - providerTimeRecords,
  );
  if (missingProviderTime) {
    input.missing.push(
      `${missingProviderTime} cited provider evidence records expose retrieval time but no observation, publication, or effective time.`,
    );
    input.impact.push(
      "Claims remain grounded to returned evidence, but time-sensitive interpretation is limited where providers expose retrieval time only.",
    );
  }
  const rootTime = buildTimeContract(input);
  const omittedTotal = Object.values(omitted).reduce(
    (sum, value) => sum + value,
    0,
  );
  const status = omittedTotal || missingProviderTime ? "partial" : "complete";
  if (!input.impact.length) {
    input.impact.push(
      `${input.report} claims, citations, retrieval times, and applicable provider times are complete.`,
    );
  }
  return {
    quality: {
      status,
      expected: input.expected,
      received: input.received,
      omitted,
      freshness: {
        status: !input.citedProviderRecords.length
          ? "unavailable"
          : missingProviderTime
            ? providerTimeRecords
              ? "partial_provider_time"
              : "retrieval_only"
            : "complete",
        expectedObservations: input.citedProviderRecords.length,
        receivedObservations: providerTimeRecords,
        latestObservedAt: rootTime.observedAt,
        latestPublishedAt: rootTime.publishedAt,
        retrievedAt: rootTime.retrievedAt,
        evaluatedAt: rootTime.serverRespondedAt,
        agePolicy: "provider_time_required_for_time_sensitive_interpretation",
      },
      missing: input.missing,
      impact: input.impact,
      source:
        "Typed read-only tool evidence returned during the completed advisor run",
      ...rootTime,
    },
    evidenceRecords: input.records,
    ...rootTime,
  };
}

/** Builds visible coverage for one completed read-only portfolio answer. */
export function buildPortfolioQuestionCoverage(input: {
  output: QuestionOutput;
  evidenceRecords: AdvisorEvidenceRecord[];
  retrievedAt: string;
  serverRespondedAt: string;
}) {
  const references = unique(
    input.output.claims.flatMap((claim) => claim.evidence),
  );
  const citedRecords = references
    .map((id) => recordFor(input.evidenceRecords, "question", id))
    .filter((record): record is AdvisorEvidenceRecord => Boolean(record));
  const expected = {
    claims: input.output.claims.length,
    groundedClaims: input.output.claims.length,
    citedEvidenceRecords: references.length,
    evidenceRetrievalTimes: references.length,
    providerTimeRecords: references.filter(expectsProviderTime).length,
  };
  const received = {
    claims: input.output.claims.length,
    groundedClaims: input.output.claims.filter((claim) =>
      claim.evidence.every((id) =>
        recordFor(input.evidenceRecords, "question", id),
      ),
    ).length,
    citedEvidenceRecords: citedRecords.length,
    evidenceRetrievalTimes: citedRecords.filter((record) => record.retrievedAt)
      .length,
    providerTimeRecords: citedRecords.filter(
      (record) =>
        record.kind === "provider" &&
        Boolean(
          record.observedAt || record.publishedAt || record.effectivePeriod,
        ),
    ).length,
  };
  const missing = [
    ...(received.groundedClaims < expected.groundedClaims
      ? [
          `${expected.groundedClaims - received.groundedClaims} answer claims lack a resolved typed-tool citation.`,
        ]
      : []),
    ...(received.evidenceRetrievalTimes < expected.evidenceRetrievalTimes
      ? [
          `${expected.evidenceRetrievalTimes - received.evidenceRetrievalTimes} cited evidence records lack retrieval time.`,
        ]
      : []),
  ];
  const impact = [
    ...(received.groundedClaims < expected.groundedClaims
      ? [
          "Ungrounded answer claims must not be treated as established portfolio facts.",
        ]
      : []),
  ];
  return finishCoverage({
    report: "Portfolio Q&A",
    expected,
    received,
    records: input.evidenceRecords,
    citedProviderRecords: citedRecords.filter(
      (record) => record.kind === "provider",
    ),
    retrievedAt: input.retrievedAt,
    serverRespondedAt: input.serverRespondedAt,
    missing,
    impact,
  });
}

/** Builds visible coverage for a proposal plus its independent risk review. */
export function buildPortfolioPlanCoverage(input: {
  output: PlanOutput;
  evidenceRecords: AdvisorEvidenceRecord[];
  retrievedAt: string;
  serverRespondedAt: string;
}) {
  const proposalReferences = unique(
    input.output.ideas.flatMap((idea) => idea.evidence),
  );
  const reviewReferences = unique(
    input.output.ideas.flatMap((idea) => idea.riskReview.evidence),
  );
  const citedRecords = [
    ...proposalReferences
      .map((id) => recordFor(input.evidenceRecords, "proposal", id))
      .filter((record): record is AdvisorEvidenceRecord => Boolean(record)),
    ...reviewReferences
      .map((id) => recordFor(input.evidenceRecords, "review", id))
      .filter((record): record is AdvisorEvidenceRecord => Boolean(record)),
  ];
  const actionable = input.output.ideas.filter((idea) => idea.actionable);
  const expected = {
    ideas: input.output.ideas.length,
    groundedIdeas: input.output.ideas.length,
    independentRiskReviews: input.output.ideas.length,
    groundedRiskReviews: input.output.ideas.length,
    citedEvidenceRecords: proposalReferences.length + reviewReferences.length,
    evidenceRetrievalTimes: proposalReferences.length + reviewReferences.length,
    actionAuthorities: actionable.length,
    providerTimeRecords: [...proposalReferences, ...reviewReferences].filter(
      expectsProviderTime,
    ).length,
  };
  const received = {
    ideas: input.output.ideas.length,
    groundedIdeas: input.output.ideas.filter((idea) =>
      idea.evidence.every((id) =>
        recordFor(input.evidenceRecords, "proposal", id),
      ),
    ).length,
    independentRiskReviews: input.output.ideas.filter((idea) => idea.riskReview)
      .length,
    groundedRiskReviews: input.output.ideas.filter((idea) =>
      idea.riskReview.evidence.every((id) =>
        recordFor(input.evidenceRecords, "review", id),
      ),
    ).length,
    citedEvidenceRecords: citedRecords.length,
    evidenceRetrievalTimes: citedRecords.filter((record) => record.retrievedAt)
      .length,
    actionAuthorities: actionable.filter(
      (idea) =>
        idea.simulationId &&
        idea.evidence.includes(`simulation:${idea.simulationId}`) &&
        recordFor(
          input.evidenceRecords,
          "proposal",
          `simulation:${idea.simulationId}`,
        )?.kind === "local",
    ).length,
    providerTimeRecords: citedRecords.filter(
      (record) =>
        record.kind === "provider" &&
        Boolean(
          record.observedAt || record.publishedAt || record.effectivePeriod,
        ),
    ).length,
  };
  const missing = [
    ...(received.groundedIdeas < expected.groundedIdeas
      ? [
          `${expected.groundedIdeas - received.groundedIdeas} proposal ideas lack resolved typed-tool evidence.`,
        ]
      : []),
    ...(received.groundedRiskReviews < expected.groundedRiskReviews
      ? [
          `${expected.groundedRiskReviews - received.groundedRiskReviews} independent risk reviews lack resolved review evidence.`,
        ]
      : []),
    ...(received.actionAuthorities < expected.actionAuthorities
      ? [
          `${expected.actionAuthorities - received.actionAuthorities} actionable ideas lack exact local simulation authority.`,
        ]
      : []),
  ];
  const impact = [
    ...(received.groundedIdeas < expected.groundedIdeas ||
    received.groundedRiskReviews < expected.groundedRiskReviews
      ? [
          "Ideas or counter-theses with unresolved evidence must not support a portfolio conclusion.",
        ]
      : []),
    ...(received.actionAuthorities < expected.actionAuthorities
      ? [
          "A draft without exact simulation authority must remain non-actionable.",
        ]
      : []),
  ];
  return finishCoverage({
    report: "Guided rebalance",
    expected,
    received,
    records: input.evidenceRecords,
    citedProviderRecords: citedRecords.filter(
      (record) => record.kind === "provider",
    ),
    retrievedAt: input.retrievedAt,
    serverRespondedAt: input.serverRespondedAt,
    missing,
    impact,
  });
}
