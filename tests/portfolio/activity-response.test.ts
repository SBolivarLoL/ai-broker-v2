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
      received: {
        storedActivities: 1,
        withRetrievalTime: 0,
        withProviderTime: 0,
      },
      missing: [
        "1 stored activities have no preserved retrieval time.",
        "1 stored activities have no preserved provider time taxonomy.",
      ],
    },
    activities: [{
      id: "legacy-fill",
      observedAt: null,
      publishedAt: null,
      effectivePeriod: null,
      retrievedAt: null,
      serverRespondedAt: "2026-01-03T10:00:01.000Z",
    }],
  });
});
