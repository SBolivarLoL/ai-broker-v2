export type SearchableAsset = {
  symbol: string;
  name: string;
  exchange?: string;
};

const normalized = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

function subsequenceScore(query: string, value: string) {
  let queryIndex = 0;
  let gaps = 0;
  let previous = -1;
  for (
    let index = 0;
    index < value.length && queryIndex < query.length;
    index++
  ) {
    if (value[index] !== query[queryIndex]) continue;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    queryIndex++;
  }
  return queryIndex === query.length ? gaps : null;
}

function assetScore(asset: SearchableAsset, rawQuery: string) {
  const query = normalized(rawQuery);
  const symbol = normalized(asset.symbol);
  const name = normalized(asset.name);
  if (!query) return null;
  if (symbol === query) return 0;
  if (symbol.startsWith(query))
    return 10 + (symbol.length - query.length) / 100;
  if (name.startsWith(query)) return 20 + (name.length - query.length) / 1_000;
  // One-character queries should stay useful instead of matching nearly every name.
  if (query.length === 1) return null;
  const symbolIndex = symbol.indexOf(query);
  if (symbolIndex >= 0) return 30 + symbolIndex;
  const nameIndex = name.indexOf(query);
  if (nameIndex >= 0) return 40 + nameIndex / 100;
  const symbolGaps = subsequenceScore(query, symbol);
  const nameGaps = subsequenceScore(query, name);
  const gaps = [symbolGaps, nameGaps].filter(
    (value): value is number => value !== null,
  );
  return gaps.length ? 50 + Math.min(...gaps) : null;
}

export function searchAssets(
  assets: SearchableAsset[],
  query: string,
  limit = 8,
) {
  return assets
    .map((asset) => ({ asset, score: assetScore(asset, query) }))
    .filter(
      (candidate): candidate is { asset: SearchableAsset; score: number } =>
        candidate.score !== null,
    )
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.asset.symbol.localeCompare(right.asset.symbol),
    )
    .slice(0, limit)
    .map(({ asset }) => asset);
}
