import { expect, test } from "bun:test";
import {
  canonicalEvidence,
  dedupeEvidence,
  evidenceContentHash,
} from "../../backend/shared/evidence";

const record = (overrides: Record<string, unknown> = {}) =>
  canonicalEvidence({
    id: "sec:AAPL:filing",
    provider: "SEC",
    sourceId: "0000320193-26-000001",
    category: "filings",
    authority: "official",
    claimStatus: "official_record",
    title: "Apple filing",
    url: "https://WWW.SEC.GOV/filing/?utm_source=test#section",
    asOf: "2026-06-28",
    observedAt: "2026-06-27T21:30:00Z",
    retrievedAt: "2026-06-29T12:00:00Z",
    serverRespondedAt: "2026-06-29T12:00:01Z",
    publishedAt: "2026-06-28T06:00:00Z",
    effectivePeriod: { end: "2026-06-28", label: "filing date" },
    entityIds: { symbol: "aapl", cik: "320193" },
    data: { b: 2, a: 1 },
    ...overrides,
  } as any);

test("builds deterministic canonical evidence with normalized identity and URL", () => {
  const evidence = record();
  expect(evidence).toMatchObject({
    provider: "sec",
    canonicalUrl: "https://www.sec.gov/filing",
    asOf: "2026-06-28T00:00:00.000Z",
    observedAt: "2026-06-27T21:30:00.000Z",
    retrievedAt: "2026-06-29T12:00:00.000Z",
    serverRespondedAt: "2026-06-29T12:00:01.000Z",
    publishedAt: "2026-06-28T06:00:00.000Z",
    entityIds: { symbol: "AAPL", cik: "0000320193" },
    time: {
      observationTime: "2026-06-27T21:30:00.000Z",
      publicationTime: "2026-06-28T06:00:00.000Z",
      effectivePeriod: {
        start: null,
        end: "2026-06-28T00:00:00.000Z",
        label: "filing date",
      },
      retrievalTime: "2026-06-29T12:00:00.000Z",
      serverResponseTime: "2026-06-29T12:00:01.000Z",
    },
  });
  expect(evidence.contentHash).toBe(evidenceContentHash({ a: 1, b: 2 }));
  expect(() => record({ data: { value: Number.NaN } })).toThrow("non-finite");
});

test("canonical evidence preserves an explicitly unavailable observation time", () => {
  const evidence = record({ observedAt: null });
  expect(evidence.observedAt).toBeNull();
  expect(evidence.time.observationTime).toBeNull();
  expect(evidence.retrievedAt).toBe("2026-06-29T12:00:00.000Z");
});

test("deduplicates exact evidence conservatively and records source revisions", () => {
  const original = record();
  const revision = record({
    id: "sec:AAPL:filing:revision",
    retrievedAt: "2026-06-29T13:00:00Z",
    data: { a: 1, b: 3 },
  });
  const licensedCopy = record({
    id: "vendor:AAPL:copy",
    provider: "vendor",
    sourceId: "vendor-1",
    authority: "licensed_provider",
    claimStatus: "media_signal",
    url: "https://vendor.test/story",
    data: { a: 1, b: 3 },
  });
  const distinctHeadline = record({
    id: "vendor:AAPL:other",
    provider: "vendor",
    sourceId: "vendor-2",
    authority: "licensed_provider",
    claimStatus: "media_signal",
    url: "https://vendor.test/other",
    data: { headline: "Similar words, distinct source" },
  });
  const result = dedupeEvidence([
    original,
    revision,
    licensedCopy,
    distinctHeadline,
  ]);
  expect(result.records.map((item) => item.id)).toEqual([
    "sec:AAPL:filing:revision",
    "vendor:AAPL:other",
  ]);
  expect(result.duplicates).toEqual([
    {
      keptId: "sec:AAPL:filing:revision",
      discardedId: "sec:AAPL:filing",
      reason: "provider_source_id",
    },
    {
      keptId: "sec:AAPL:filing:revision",
      discardedId: "vendor:AAPL:copy",
      reason: "exact_content",
    },
  ]);
  expect(result.revisions).toHaveLength(1);
});

test("does not merge similar media records without exact identity evidence", () => {
  const first = record({
    id: "media:1",
    provider: "gdelt",
    sourceId: "1",
    authority: "public_web",
    claimStatus: "media_signal",
    category: "news",
    url: "https://news.test/1",
    data: { headline: "Company reports results", detail: "A" },
  });
  const second = record({
    id: "media:2",
    provider: "finnhub",
    sourceId: "2",
    authority: "licensed_provider",
    claimStatus: "media_signal",
    category: "news",
    url: "https://news.test/2",
    data: { headline: "Company reports results", detail: "B" },
  });
  const sameDocumentFragment = record({
    id: "sec:AAPL:other-section",
    sourceId: "0000320193-26-000001:risk",
    data: { section: "Different filing fragment" },
  });
  expect(
    dedupeEvidence([first, second, record(), sameDocumentFragment]).records,
  ).toHaveLength(4);
});
