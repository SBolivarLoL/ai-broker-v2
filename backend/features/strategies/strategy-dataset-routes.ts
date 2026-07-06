import { ClientError, json, requestJson } from "../../http/http";
import {
  buildVersionedCryptoDataset,
  cryptoDatasetChunks,
  parseCryptoDatasetRequest,
} from "./strategy-datasets";
import type { StrategyRouteContext } from "./strategy-route-context";

function datasetDto(
  dataset: NonNullable<
    ReturnType<StrategyRouteContext["store"]["getStrategyBarDataset"]>
  >,
  includeBars = false,
) {
  return {
    id: dataset.id,
    provider: dataset.provider,
    feed: dataset.feed,
    timezone: dataset.timezone,
    timeframe: dataset.timeframe,
    symbols: dataset.symbols,
    start: dataset.start,
    end: dataset.end,
    datasetHash: dataset.datasetHash,
    previousDatasetId: dataset.previousDatasetId,
    stats: dataset.stats,
    createdAt: dataset.createdAt,
    ...(includeBars ? { bars: dataset.bars } : {}),
  };
}

/** Owns immutable long-history crypto dataset ingestion and retrieval. */
export async function handleStrategyDatasetRequest(
  request: Request,
  url: URL,
  context: StrategyRouteContext,
): Promise<Response | null> {
  const { alpaca, store, actor, allow } = context;
  if (url.pathname === "/api/strategy/datasets" && request.method === "GET")
    return json({
      datasets: store.strategyBarDatasets(actor).map((dataset) =>
        datasetDto(dataset!),
      ),
      asOf: new Date().toISOString(),
    });

  const datasetMatch = url.pathname.match(
    /^\/api\/strategy\/datasets\/([^/]+)$/,
  );
  if (datasetMatch && request.method === "GET") {
    const dataset = store.getStrategyBarDataset(
      decodeURIComponent(datasetMatch[1]!),
    );
    if (!dataset || dataset.actor !== actor)
      return json({ error: "Strategy dataset not found" }, 404);
    return json(datasetDto(dataset, url.searchParams.get("includeBars") === "1"));
  }

  if (url.pathname !== "/api/strategy/datasets" || request.method !== "POST")
    return null;
  if (!allow(`${actor}:strategy-datasets`, 4))
    return json({ error: "Strategy dataset ingest rate limit exceeded" }, 429);
  const input = await requestJson(request);
  let query;
  try {
    query = parseCryptoDatasetRequest(input);
  } catch (error) {
    throw new ClientError(
      error instanceof Error ? error.message : "Invalid strategy dataset request",
      400,
    );
  }

  const rawBars = Object.fromEntries(
    query.symbols.map((symbol) => [symbol, [] as unknown[]]),
  );
  const chunks = cryptoDatasetChunks(query.start, query.end);
  for (const chunk of chunks) {
    const response = await alpaca.marketData.getCryptoBars({
      loc: "us",
      symbols: query.symbols,
      timeframe: query.timeframe,
      start: chunk.start,
      end: chunk.end,
      limit: 10_000,
    } as any);
    for (const symbol of query.symbols)
      rawBars[symbol]!.push(...(response[symbol] ?? []));
  }
  const previous = store.latestStrategyBarDataset(
    actor,
    query.symbols,
    query.timeframe,
    query.start.toISOString(),
    query.end.toISOString(),
  );
  const version = buildVersionedCryptoDataset({
    request: query,
    rawBars,
    previous: previous ? { id: previous.id, bars: previous.bars } : null,
  });
  const existing = store.strategyBarDatasetByHash(actor, version.datasetHash);
  if (existing)
    return json({ reused: true, dataset: datasetDto(existing) });

  const id = crypto.randomUUID();
  const dataset = store.strategyBarDataset({
    id,
    actor,
    provider: version.provider,
    feed: version.feed,
    timezone: version.timezone,
    timeframe: version.timeframe,
    symbols: version.symbols,
    start: version.start,
    end: version.end,
    datasetHash: version.datasetHash,
    previousDatasetId: version.previousDatasetId,
    stats: version.stats,
    bars: version.bars,
  })!;
  store.event("strategy.dataset.ingested", actor, {
    datasetId: id,
    datasetHash: dataset.datasetHash,
    symbols: dataset.symbols,
    timeframe: dataset.timeframe,
    start: dataset.start,
    end: dataset.end,
    chunks: chunks.length,
    stats: dataset.stats,
  });
  return json({ reused: false, chunks: chunks.length, dataset: datasetDto(dataset) }, 201);
}
