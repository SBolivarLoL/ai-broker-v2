import { expect, test } from "bun:test";
import {
  buildAdvisorEvidenceRecord,
  buildAdvisorEvidenceSnapshot,
  buildAdvisorPlanEvidenceReplay,
  buildPortfolioPlanCoverage,
  buildPortfolioQuestionCoverage,
} from "../../backend/features/research/advisor-coverage";
import { evidenceContentHash } from "../../backend/shared/evidence";

function snapshot(
  evidenceId: string,
  phase: "proposal" | "review",
  payload: unknown,
) {
  return buildAdvisorEvidenceSnapshot({
    record: buildAdvisorEvidenceRecord({
      evidenceId,
      phase,
      source: "Test provider",
      retrievedAt: "2026-07-12T12:00:00.000Z",
    }),
    payload,
  });
}

test("portfolio Q&A coverage distinguishes grounded citations from retrieval-only time", () => {
  const output = {
    claims: [
      { evidence: ["portfolio:current"] },
      { evidence: ["bars:AAPL:90d"] },
    ],
  };
  const coverage = buildPortfolioQuestionCoverage({
    output,
    evidenceRecords: [
      buildAdvisorEvidenceRecord({
        evidenceId: "portfolio:current",
        phase: "question",
        source: "Alpaca Trading API",
        retrievedAt: "2026-07-12T12:00:00.000Z",
      }),
      buildAdvisorEvidenceRecord({
        evidenceId: "bars:AAPL:90d",
        phase: "question",
        source: "Alpaca Market Data API",
        observationTime: "2026-07-11T20:00:00.000Z",
        effectivePeriod: {
          start: "2026-04-12T20:00:00.000Z",
          end: "2026-07-11T20:00:00.000Z",
          label: "Returned daily-bar window",
        },
        retrievedAt: "2026-07-12T12:00:01.000Z",
      }),
    ],
    retrievedAt: "2026-07-12T12:00:01.000Z",
    serverRespondedAt: "2026-07-12T12:00:02.000Z",
  });

  expect(coverage).toMatchObject({
    quality: {
      status: "partial",
      expected: {
        claims: 2,
        groundedClaims: 2,
        citedEvidenceRecords: 2,
        evidenceRetrievalTimes: 2,
        providerTimeRecords: 2,
      },
      received: {
        groundedClaims: 2,
        citedEvidenceRecords: 2,
        evidenceRetrievalTimes: 2,
        providerTimeRecords: 1,
      },
      omitted: { providerTimeRecords: 1 },
      freshness: {
        status: "partial_provider_time",
        expectedObservations: 2,
        receivedObservations: 1,
        latestObservedAt: "2026-07-11T20:00:00.000Z",
      },
    },
    observedAt: "2026-07-11T20:00:00.000Z",
    retrievedAt: "2026-07-12T12:00:01.000Z",
    serverRespondedAt: "2026-07-12T12:00:02.000Z",
  });
  expect(coverage.quality.impact.join(" ")).toContain(
    "time-sensitive interpretation",
  );
});

test("portfolio Q&A coverage exposes unresolved claim evidence", () => {
  const coverage = buildPortfolioQuestionCoverage({
    output: { claims: [{ evidence: ["portfolio:current"] }] },
    evidenceRecords: [],
    retrievedAt: "2026-07-12T12:00:00.000Z",
    serverRespondedAt: "2026-07-12T12:00:01.000Z",
  });

  expect(coverage.quality).toMatchObject({
    status: "partial",
    received: {
      groundedClaims: 0,
      citedEvidenceRecords: 0,
      evidenceRetrievalTimes: 0,
      providerTimeRecords: 0,
    },
    omitted: {
      groundedClaims: 1,
      citedEvidenceRecords: 1,
      evidenceRetrievalTimes: 1,
      providerTimeRecords: 1,
    },
    freshness: { status: "unavailable" },
  });
  expect(coverage.quality.missing.join(" ")).toContain(
    "lack a resolved typed-tool citation",
  );
});

test("guided rebalance coverage binds proposals reviews and action authority", () => {
  const simulationId = "00000000-0000-4000-8000-000000000001";
  const output = {
    ideas: [
      {
        evidence: ["portfolio:current", `simulation:${simulationId}`],
        actionable: true,
        simulationId,
        riskReview: { evidence: ["risk:current"] },
      },
      {
        evidence: ["portfolio:current"],
        actionable: false,
        simulationId: null,
        riskReview: { evidence: ["risk:current"] },
      },
      {
        evidence: ["portfolio:current"],
        actionable: false,
        simulationId: null,
        riskReview: { evidence: ["risk:current"] },
      },
    ],
  };
  const coverage = buildPortfolioPlanCoverage({
    output,
    evidenceRecords: [
      buildAdvisorEvidenceRecord({
        evidenceId: "portfolio:current",
        phase: "proposal",
        source: "Alpaca Trading API",
        observationTime: "2026-07-12T11:59:58.000Z",
        retrievedAt: "2026-07-12T12:00:00.000Z",
      }),
      buildAdvisorEvidenceRecord({
        evidenceId: `simulation:${simulationId}`,
        phase: "proposal",
        source: "Local deterministic paper-order simulation",
        kind: "local",
        retrievedAt: "2026-07-12T12:00:00.000Z",
      }),
      buildAdvisorEvidenceRecord({
        evidenceId: "risk:current",
        phase: "review",
        source: "Alpaca Trading API plus local deterministic risk",
        observationTime: "2026-07-12T11:59:59.000Z",
        retrievedAt: "2026-07-12T12:00:01.000Z",
      }),
    ],
    retrievedAt: "2026-07-12T12:00:01.000Z",
    serverRespondedAt: "2026-07-12T12:00:02.000Z",
  });

  expect(coverage.quality).toMatchObject({
    status: "complete",
    expected: {
      ideas: 3,
      groundedIdeas: 3,
      independentRiskReviews: 3,
      groundedRiskReviews: 3,
      citedEvidenceRecords: 3,
      evidenceRetrievalTimes: 3,
      actionAuthorities: 1,
      providerTimeRecords: 2,
    },
    received: {
      groundedIdeas: 3,
      groundedRiskReviews: 3,
      actionAuthorities: 1,
      providerTimeRecords: 2,
    },
    freshness: {
      status: "complete",
      expectedObservations: 2,
      receivedObservations: 2,
    },
    missing: [],
  });
  expect(coverage.quality.impact).toEqual([
    "Guided rebalance claims, citations, retrieval times, and applicable provider times are complete.",
  ]);
});

test("advisor evidence snapshots canonicalize JSON before hashing", () => {
  const first = snapshot("price:AAPL", "proposal", {
    symbol: "AAPL",
    nested: { quantity: 2, at: new Date("2026-07-12T10:00:00.000Z") },
  });
  const second = snapshot("price:AAPL", "proposal", {
    nested: { at: "2026-07-12T10:00:00.000Z", quantity: 2 },
    symbol: "AAPL",
  });

  expect(first.payload).toEqual(second.payload);
  expect(first.contentHash).toBe(second.contentHash);
  expect(first.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
});

test("advisor plan replay stores only cited phase-specific snapshots", () => {
  const output = {
    ideas: [
      { evidence: ["portfolio:current", "price:AAPL"], actionable: false, simulationId: null, riskReview: { evidence: ["risk:current"] } },
      { evidence: ["portfolio:current"], actionable: false, simulationId: null, riskReview: { evidence: ["risk:current"] } },
      { evidence: ["portfolio:current"], actionable: false, simulationId: null, riskReview: { evidence: ["risk:current"] } },
    ],
  };
  const inputs = [
    snapshot("risk:current", "review", { concentration: 0.35 }),
    snapshot("news:AAPL", "proposal", { articles: [] }),
    snapshot("portfolio:current", "proposal", { equity: "10000" }),
    snapshot("price:AAPL", "proposal", { price: 200 }),
  ];
  const replay = buildAdvisorPlanEvidenceReplay({ output, evidenceSnapshots: inputs });
  const reordered = buildAdvisorPlanEvidenceReplay({ output, evidenceSnapshots: inputs.toReversed() });

  expect(replay).toMatchObject({
    schemaVersion: "advisor-plan-evidence-v1",
    payloadPolicy: "allowlisted_typed_tool_output",
    status: "complete",
    expectedSnapshots: 3,
    receivedSnapshots: 3,
    missingSnapshots: [],
    references: [
      { phase: "proposal", evidenceId: "portfolio:current" },
      { phase: "proposal", evidenceId: "price:AAPL" },
      { phase: "review", evidenceId: "risk:current" },
    ],
  });
  expect(replay.snapshots.map(({ phase, evidenceId }) => `${phase}:${evidenceId}`)).toEqual([
    "proposal:portfolio:current",
    "proposal:price:AAPL",
    "review:risk:current",
  ]);
  expect(replay.snapshots.some(({ evidenceId }) => evidenceId === "news:AAPL")).toBe(false);
  expect(replay.contentHash).toBe(reordered.contentHash);
  const { contentHash, ...manifest } = replay;
  expect(contentHash).toBe(evidenceContentHash(manifest));
});

test("advisor plan replay exposes missing and ambiguous cited snapshots", () => {
  const output = {
    ideas: Array.from({ length: 3 }, () => ({
      evidence: ["portfolio:current"],
      actionable: false,
      simulationId: null,
      riskReview: { evidence: ["risk:current"] },
    })),
  };
  const duplicate = snapshot("portfolio:current", "proposal", { equity: "10000" });
  const replay = buildAdvisorPlanEvidenceReplay({ output, evidenceSnapshots: [duplicate, duplicate] });

  expect(replay).toMatchObject({
    status: "partial",
    expectedSnapshots: 2,
    receivedSnapshots: 0,
    missingSnapshots: [
      { phase: "proposal", evidenceId: "portfolio:current", reason: "ambiguous" },
      { phase: "review", evidenceId: "risk:current", reason: "missing" },
    ],
  });
});
