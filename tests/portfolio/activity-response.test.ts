import { expect, test } from "bun:test";
import { accountActivitiesDto } from "../../backend/features/portfolio/activity-response";
import type { LedgerActivity } from "../../backend/features/portfolio/ledger";

test("legacy account activities expose provenance gaps without inventing times", () => {
  const legacy: LedgerActivity = {
    id: "legacy-fill",
    type: "FILL",
    subType: null,
    category: "trade",
    status: "executed",
    occurredAt: "2026-01-01T12:00:00.000Z",
    symbol: "AAPL",
    side: "buy",
    quantity: 1,
    price: 100,
    amount: -100,
    orderId: null,
    corporateAction: null,
    observedAt: null,
    publishedAt: null,
    effectivePeriod: null,
    retrievedAt: null,
  };

  const response = accountActivitiesDto({
    activities: [legacy],
    allActivities: [legacy],
    imported: 0,
    truncated: false,
    cacheHit: true,
    retrievedAt: "2026-01-03T10:00:00.000Z",
    serverRespondedAt: "2026-01-03T10:00:01.000Z",
  });

  expect(response).toMatchObject({
    observedAt: null,
    publishedAt: null,
    effectivePeriod: null,
    retrievedAt: "2026-01-03T10:00:00.000Z",
    quality: {
      status: "partial",
      expected: {
        activityHistory: 1,
        storedActivities: 1,
        retrievalTimes: 1,
        providerTimes: 1,
        sellBasisUnits: 0,
        corporateActions: 0,
      },
      received: {
        activityHistory: 1,
        storedActivities: 1,
        retrievalTimes: 0,
        providerTimes: 0,
        sellBasisUnits: 0,
        corporateActions: 0,
        withRetrievalTime: 0,
        withProviderTime: 0,
      },
      omitted: {
        activityHistory: 0,
        storedActivities: 0,
        retrievalTimes: 1,
        providerTimes: 1,
        sellBasisUnits: 0,
        corporateActions: 0,
      },
      freshness: {
        status: "unavailable",
        retrievedAt: "2026-01-03T10:00:00.000Z",
        evaluatedAt: "2026-01-03T10:00:01.000Z",
        cacheHit: true,
      },
      missing: [
        "1 stored activities have no preserved retrieval time.",
        "1 stored activities have no preserved provider time taxonomy.",
      ],
    },
    activities: [
      {
        id: "legacy-fill",
        observedAt: null,
        publishedAt: null,
        effectivePeriod: null,
        retrievedAt: null,
        serverRespondedAt: "2026-01-03T10:00:01.000Z",
      },
    ],
  });
});

test("ledger quality makes bounded history and basis gaps consequential", () => {
  const timed = {
    observedAt: "2026-01-02T15:00:00.000Z",
    publishedAt: null,
    effectivePeriod: null,
    retrievedAt: "2026-01-03T10:00:00.000Z",
  };
  const sell: LedgerActivity = {
    id: "unmatched-sell",
    type: "FILL",
    subType: null,
    category: "trade",
    status: "executed",
    occurredAt: "2026-01-02T15:00:00.000Z",
    symbol: "AAPL",
    side: "sell",
    quantity: 2,
    price: 120,
    amount: 240,
    orderId: null,
    corporateAction: null,
    ...timed,
  };
  const corporateAction: LedgerActivity = {
    ...sell,
    id: "unresolved-reorg",
    type: "REORG",
    category: "corporate_action",
    side: null,
    quantity: null,
    price: null,
    amount: 0,
    occurredAt: "2026-01-02T16:00:00.000Z",
    corporateAction: null,
  };

  const response = accountActivitiesDto({
    activities: [sell, corporateAction],
    allActivities: [sell, corporateAction],
    imported: 2,
    truncated: true,
    cacheHit: false,
    retrievedAt: "2026-01-03T10:00:00.000Z",
    serverRespondedAt: "2026-01-03T10:00:01.000Z",
  });

  expect(response.quality).toMatchObject({
    status: "partial",
    expected: {
      activityHistory: 1,
      storedActivities: 2,
      retrievalTimes: 2,
      providerTimes: 2,
      sellBasisUnits: 2,
      corporateActions: 1,
    },
    received: {
      activityHistory: 0,
      storedActivities: 2,
      retrievalTimes: 2,
      providerTimes: 2,
      sellBasisUnits: 0,
      corporateActions: 0,
    },
    omitted: {
      activityHistory: 1,
      storedActivities: 0,
      retrievalTimes: 0,
      providerTimes: 0,
      sellBasisUnits: 2,
      corporateActions: 1,
    },
    rejected: {
      unmatchedSellQuantity: 2,
      unresolvedCorporateActions: 1,
    },
    freshness: {
      status: "observed",
      latestObservedAt: "2026-01-02T15:00:00.000Z",
      cacheHit: false,
    },
  });
  expect(response.quality.missing).toEqual([
    "Account activity history reached its configured import bound.",
    "2 sold units have no matched FIFO acquisition basis.",
    "1 corporate action requires manual basis review.",
  ]);
  expect(response.quality.impact[0]).toContain("not inferred");
});
