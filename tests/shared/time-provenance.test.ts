import { expect, test } from "bun:test";
import {
  localResponseTimeFields,
  normalizeTimeProvenance,
  providerTimeFields,
  unavailableProviderTimeFields,
} from "../../backend/shared/time-provenance";

test("normalizes explicit provider time provenance", () => {
  expect(
    normalizeTimeProvenance({
      observationTime: "2026-06-24T10:00:00Z",
      publicationTime: "2026-06-24T10:00:05Z",
      effectivePeriod: {
        start: "2026-06-01",
        end: "2026-06-30T23:59:59Z",
        label: "June 2026",
      },
      retrievalTime: "2026-06-24T10:00:10Z",
      serverResponseTime: "2026-06-24T10:00:11Z",
    }),
  ).toEqual({
    observationTime: "2026-06-24T10:00:00.000Z",
    publicationTime: "2026-06-24T10:00:05.000Z",
    effectivePeriod: {
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-30T23:59:59.000Z",
      label: "June 2026",
    },
    retrievalTime: "2026-06-24T10:00:10.000Z",
    serverResponseTime: "2026-06-24T10:00:11.000Z",
  });
});

test("rejects invalid timestamp provenance", () => {
  expect(() =>
    normalizeTimeProvenance({
      retrievalTime: "not-a-date",
    }),
  ).toThrow("Retrieval time");
  expect(() =>
    normalizeTimeProvenance({
      retrievalTime: "2026-06-24T10:00:10Z",
      effectivePeriod: {
        start: "2026-07-01",
        end: "2026-06-01",
      },
    }),
  ).toThrow("start cannot be after end");
});

test("builds explicit provider DTO time fields", () => {
  const fields = providerTimeFields({
    observationTime: null,
    publicationTime: "2026-06-28",
    effectivePeriod: { end: "2026-06-27", label: "report date" },
    retrievalTime: "2026-06-29T12:00:00Z",
    serverResponseTime: "2026-06-29T12:00:01Z",
  });
  expect(fields).toEqual({
    observedAt: null,
    publishedAt: "2026-06-28T00:00:00.000Z",
    effectivePeriod: {
      start: null,
      end: "2026-06-27T00:00:00.000Z",
      label: "report date",
    },
    retrievedAt: "2026-06-29T12:00:00.000Z",
    serverRespondedAt: "2026-06-29T12:00:01.000Z",
    time: {
      observationTime: null,
      publicationTime: "2026-06-28T00:00:00.000Z",
      effectivePeriod: {
        start: null,
        end: "2026-06-27T00:00:00.000Z",
        label: "report date",
      },
      retrievalTime: "2026-06-29T12:00:00.000Z",
      serverResponseTime: "2026-06-29T12:00:01.000Z",
    },
    asOf: "2026-06-29T12:00:01.000Z",
  });
});

test("keeps an unqueried or failed provider retrieval explicitly unavailable", () => {
  expect(unavailableProviderTimeFields("2026-06-29T12:00:01Z")).toEqual({
    observedAt: null,
    publishedAt: null,
    effectivePeriod: null,
    retrievedAt: null,
    serverRespondedAt: "2026-06-29T12:00:01.000Z",
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: null,
      serverResponseTime: "2026-06-29T12:00:01.000Z",
    },
    asOf: "2026-06-29T12:00:01.000Z",
  });
});

test("marks local-only response time without inventing provider retrieval", () => {
  expect(localResponseTimeFields("2026-07-12T12:00:01Z")).toMatchObject({
    observedAt: null,
    publishedAt: null,
    retrievedAt: null,
    serverRespondedAt: "2026-07-12T12:00:01.000Z",
    asOf: "2026-07-12T12:00:01.000Z",
    time: {
      observationTime: null,
      publicationTime: null,
      retrievalTime: null,
      serverResponseTime: "2026-07-12T12:00:01.000Z",
    },
  });
});
