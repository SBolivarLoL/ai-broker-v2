import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { json, requestJson } from "../../http/http";
import type { createStore } from "../../persistence/store";
import {
  disclosureFeed,
  disclosurePaperRule,
  evaluateDisclosurePaperTrial,
  largestEligibleHolding,
  type DisclosurePaperTrial,
  type DisclosureSource,
} from "./disclosures";

const feedPath = "/api/research/disclosures";
const paperPath = `${feedPath}/paper`;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
type Context = {
  alpaca: Alpaca;
  store: ReturnType<typeof createStore>;
  actor: string;
  allow: (key: string, maximum: number) => boolean;
  source: () => DisclosureSource;
  now: () => Date;
};

export async function handleDisclosureRequest(request: Request, url: URL, context: Context) {
  const { alpaca, store, actor, allow, source, now } = context;
  if (url.pathname === feedPath && request.method === "GET") {
    if (!allow(`disclosure-feed:${actor}`, 12))
      return json({ error: "Disclosure feed rate limit exceeded" }, 429);
    try {
      return json({
        ...await disclosureFeed(source(), now),
        trials: store.disclosurePaperTrials(actor),
      });
    } catch {
      return json({ error: "SEC disclosure data is unavailable. Check the SEC contact configuration and retry." }, 503);
    }
  }
  if (url.pathname !== paperPath) return null;
  if (request.method !== "GET" && request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  if (!allow(`disclosure-paper:${actor}`, 12))
    return json({ error: "Disclosure paper-test rate limit exceeded" }, 429);
  const accession = request.method === "POST"
    ? (await requestJson(request)).accession
    : url.searchParams.get("accession");
  if (typeof accession !== "string" || !accessionPattern.test(accession))
    return json({ error: "A valid SEC accession is required" }, 400);
  const existing = store.getDisclosurePaperTrial(actor, accession);
  if (request.method === "GET") return existing
    ? json(await evaluateDisclosurePaperTrial(existing, alpaca, now()))
    : json({ error: "No paper test was recorded for this filing" }, 404);
  if (existing) return json({ trial: existing, created: false });

  const trial = await prepareTrial(source, accession, now);
  if (trial instanceof Response) return trial;
  const created = store.recordDisclosurePaperTrial(actor, trial);
  return json({
    trial: created ? trial : store.getDisclosurePaperTrial(actor, accession),
    created,
  }, created ? 201 : 200);
}

async function prepareTrial(getSource: Context["source"], accession: string, now: Context["now"]):
  Promise<DisclosurePaperTrial | Response> {
  try {
    const source = getSource();
    const feed = await disclosureFeed(source, now);
    if (feed.sources.every(item => item.status === "unavailable"))
      return json({ error: "SEC disclosure feed is temporarily unavailable" }, 503);
    const record = feed.sources.flatMap(item => item.records)
      .find(item => item.accession === accession);
    if (!record?.canStartPaper || !record.acceptedAt || !record.reportDate)
      return json({ error: "Select a recent eligible 13F holdings report from the disclosure feed" }, 409);
    const table = await source.institutionalHoldings(record.cik, accession, record.primaryDocument);
    const candidate = await largestEligibleHolding(table.xml);
    if (!candidate)
      return json({ error: "This filing has no eligible holdings in the paper test universe" }, 422);
    const recordedAt = now().toISOString();
    if (recordedAt < table.checkedAt || recordedAt < record.acceptedAt)
      return json({ error: "SEC evidence times could not be verified" }, 502);
    return {
      accession, filer: record.filer,
      reportDate: record.reportDate, acceptedAt: record.acceptedAt, recordedAt,
      filingUrl: record.url, tableUrl: table.url, tableHash: table.contentHash,
      ...candidate, rule: disclosurePaperRule,
    };
  } catch {
    return json({ error: "SEC holdings could not be verified. Try again when the filing is available." }, 503);
  }
}
