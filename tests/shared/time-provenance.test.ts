import { expect, test } from "bun:test";
import { normalizeTimeProvenance } from "../../backend/shared/time-provenance";

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
