import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { monitoringNews } from "../markets/market-monitoring";

const dayMs = 86_400_000;
const maxNewsSymbols = 20;

function amount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function buildPortfolioBriefing(alpaca: Alpaca, now: () => Date) {
  const [account, positions] = await Promise.all([
    alpaca.trading.account.getAccount(),
    alpaca.trading.positions.getAllOpenPositions(),
  ]);
  const retrievedAt = now();
  const equity = amount(account.equity);
  const lastEquity = amount(account.lastEquity);
  const equityChange = equity === null || lastEquity === null
    ? null
    : equity - lastEquity;
  const symbolCounts = new Map<string, number>();
  for (const { symbol } of positions)
    symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
  const measured = positions.flatMap(({ symbol, unrealizedIntradayPl }) => {
    const pnl = amount(unrealizedIntradayPl);
    return symbol && symbolCounts.get(symbol) === 1 && pnl !== null
      ? [{ symbol, pnl }]
      : [];
  });
  const ranked = measured
    .filter(({ pnl }) => pnl !== 0)
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl) || a.symbol.localeCompare(b.symbol));
  const symbols = [...new Set([
    ...ranked.map(({ symbol }) => symbol),
    ...positions.map(({ symbol }) => symbol).filter(Boolean).sort(),
  ])].slice(0, maxNewsSymbols);
  const contextStart = new Date(retrievedAt.getTime() - dayMs);
  const articles = symbols.length ? await alpaca.marketData.news.news({
    symbols: symbols.join(","),
    start: contextStart,
    end: retrievedAt,
    limit: 30,
    sort: "desc",
    includeContent: false,
  }).catch(() => null) : null;
  const newsRetrievedAt = now();
  const developments = monitoringNews(
    articles?.news ?? [],
    positions.filter(({ symbol }) => symbols.includes(symbol)),
    [],
    newsRetrievedAt,
  ).flatMap(({ publishedAt, relevantSymbols, source, url, headline }) => {
    if (!publishedAt || !url || !URL.canParse(url) || new URL(url).protocol !== "https:" ||
      Date.parse(publishedAt) < contextStart.getTime() ||
      Date.parse(publishedAt) > retrievedAt.getTime()) return [];
    return [{ publishedAt, symbols: relevantSymbols, source, url, headline }];
  }).filter((item, index, all) => all.findIndex(other => other.url === item.url) === index)
    .slice(0, 4);

  return {
    mode: "paper" as const,
    retrievedAt: retrievedAt.toISOString(),
    accountSource: "Alpaca Paper Trading API",
    currency: account.currency ?? null,
    equityChange,
    equityChangePercent: equityChange === null || lastEquity === null || lastEquity <= 0
      ? null
      : equityChange / lastEquity * 100,
    contributors: ranked.slice(0, 5),
    coverage: {
      positions: positions.length,
      withIntradayPnl: measured.length,
      checkedForNews: symbols.length,
      news: symbols.length === 0 ? "no_positions" : articles ? "available" : "unavailable",
    },
    contextStart: contextStart.toISOString(),
    contextEnd: retrievedAt.toISOString(),
    newsRetrievedAt: articles ? newsRetrievedAt.toISOString() : null,
    developments,
  };
}
