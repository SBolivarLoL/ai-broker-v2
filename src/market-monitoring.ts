import type { Sec8KAlertEvidence } from "./sec-edgar";

export type MonitoringPosition = { symbol: string; qty: string | number };
export type MonitoringWatchlist = { id: string; name: string; assets: { symbol: string }[] };

const actionLabels: Record<string, string> = {
  cashDividends: "Cash dividend", cashMergers: "Cash merger", forwardSplits: "Forward split",
  nameChanges: "Name change", partialCalls: "Partial call", redemptions: "Redemption",
  reorganizations: "Reorganization", reverseSplits: "Reverse split", rightsDistributions: "Rights distribution",
  spinOffs: "Spin-off", stockAndCashMergers: "Stock-and-cash merger", stockDividends: "Stock dividend",
  stockMergers: "Stock merger", unitSplits: "Unit split", worthlessRemovals: "Worthless removal",
};

const iso = (value: unknown) => {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const plainText = (value: unknown) => String(value ?? "").replace(/&(?:amp|quot|#34|#39|lt|gt);/g, entity => ({ "&amp;": "&", "&quot;": '"', "&#34;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" }[entity] ?? entity));

const symbolFor = (action: any) => String(action.symbol ?? action.sourceSymbol ?? action.oldSymbol ?? action.acquireeSymbol ?? "").toUpperCase();
const eventDate = (action: any) => iso(action.exDate ?? action.effectiveDate ?? action.processDate ?? action.payableDate);

function scopeFor(symbols: string[], held: Set<string>, watchlists: MonitoringWatchlist[]) {
  const portfolio = symbols.some(symbol => held.has(symbol));
  const lists = watchlists.filter(list => list.assets.some(asset => symbols.includes(asset.symbol.toUpperCase()))).map(list => ({ id: list.id, name: list.name }));
  return { portfolio, watchlists: lists };
}

export function monitoringNews(articles: any[], positions: MonitoringPosition[], watchlists: MonitoringWatchlist[]) {
  const held = new Set(positions.map(position => position.symbol.toUpperCase()));
  return articles.map(article => {
    const symbols = [...new Set((article.symbols ?? []).map((symbol: unknown) => String(symbol).toUpperCase()).filter(Boolean))] as string[];
    const relevance = scopeFor(symbols, held, watchlists);
    const relevantSymbols = symbols.filter(symbol => held.has(symbol) || watchlists.some(list => list.assets.some(asset => asset.symbol.toUpperCase() === symbol)));
    return {
      id: Number(article.id), headline: plainText(article.headline || "Untitled article"), summary: plainText(article.summary),
      source: String(article.source ?? "Unknown source"), createdAt: iso(article.createdAt), updatedAt: iso(article.updatedAt),
      url: typeof article.url === "string" ? article.url : null, symbols, relevantSymbols, relevance,
    };
  }).filter(article => article.createdAt && (article.relevance.portfolio || article.relevance.watchlists.length))
    .sort((a, b) => Number(b.relevance.portfolio) - Number(a.relevance.portfolio) || b.createdAt!.localeCompare(a.createdAt!)).slice(0, 12);
}

function holdingImpact(type: string, action: any, quantity: number | null) {
  if (quantity === null) return null;
  if (type === "cashDividends" && Number.isFinite(Number(action.rate))) return { kind: "cash", estimatedCash: quantity * Number(action.rate), message: `Estimated cash based on ${quantity} currently held shares.` };
  if (["forwardSplits", "reverseSplits"].includes(type) && Number(action.oldRate) > 0 && Number(action.newRate) > 0) {
    const estimatedQuantity = quantity * Number(action.newRate) / Number(action.oldRate);
    return { kind: "quantity", estimatedQuantity, message: `Estimated quantity changes from ${quantity} to ${estimatedQuantity}; total market value is not implied to change.` };
  }
  return { kind: "review", message: "This holding may be affected; final terms and broker accounting require review." };
}

export function monitoringCorporateActions(envelope: Record<string, any[] | undefined>, positions: MonitoringPosition[], watchlists: MonitoringWatchlist[]) {
  const quantities = new Map(positions.map(position => [position.symbol.toUpperCase(), Number(position.qty)]));
  const held = new Set(quantities.keys());
  return Object.entries(envelope).flatMap(([type, actions]) => (actions ?? []).map(action => {
    const symbol = symbolFor(action);
    const relatedSymbols = [...new Set([symbol, action.newSymbol, action.acquirerSymbol, action.alternateSymbol].filter(Boolean).map(value => String(value).toUpperCase()))];
    const quantity = quantities.has(symbol) && Number.isFinite(quantities.get(symbol)) ? quantities.get(symbol)! : null;
    return {
      id: String(action.id ?? `${type}:${symbol}:${eventDate(action)}`), type, label: actionLabels[type] ?? type,
      symbol, relatedSymbols, eventDate: eventDate(action), processDate: iso(action.processDate), payableDate: iso(action.payableDate),
      rate: Number.isFinite(Number(action.rate)) ? Number(action.rate) : null,
      oldRate: Number.isFinite(Number(action.oldRate)) ? Number(action.oldRate) : null,
      newRate: Number.isFinite(Number(action.newRate)) ? Number(action.newRate) : null,
      relevance: scopeFor(relatedSymbols, held, watchlists), impact: holdingImpact(type, action, quantity),
    };
  })).filter(action => action.symbol && action.eventDate && (action.relevance.portfolio || action.relevance.watchlists.length))
    .sort((a, b) => Number(b.relevance.portfolio) - Number(a.relevance.portfolio) || a.eventDate!.localeCompare(b.eventDate!)).slice(0, 20);
}

const secImportanceRank = { standard: 1, high: 2, critical: 3 } as const;

export function monitoringSecFilings(alerts: Sec8KAlertEvidence[], positions: MonitoringPosition[], watchlists: MonitoringWatchlist[]) {
  const held = new Set(positions.map(position => position.symbol.toUpperCase()));
  return alerts.map(alert => ({ ...alert, relevance: scopeFor([alert.symbol], held, watchlists) }))
    .filter(alert => alert.relevance.portfolio || alert.relevance.watchlists.length)
    .sort((a, b) => secImportanceRank[b.importance] - secImportanceRank[a.importance] || b.filed.localeCompare(a.filed) || a.symbol.localeCompare(b.symbol))
    .slice(0, 20);
}

const eventKind = (text: string) => {
  if (/earnings|revenue|guidance|quarter|results/i.test(text)) return "earnings";
  if (/dividend|distribution/i.test(text)) return "dividend";
  if (/merger|acquisition|acquire|takeover/i.test(text)) return "merger";
  if (/fda|lawsuit|regulat|investigation|antitrust/i.test(text)) return "regulatory";
  if (/upgrade|downgrade|price target|analyst/i.test(text)) return "analyst";
  return "company_update";
};

export function monitoringEventClusters(news: ReturnType<typeof monitoringNews>, actions: ReturnType<typeof monitoringCorporateActions>, filings: ReturnType<typeof monitoringSecFilings> = []) {
  const entries = [
    ...news.flatMap(article => article.relevantSymbols.map(symbol => ({ symbol, kind: eventKind(`${article.headline} ${article.summary}`), at: article.createdAt!, label: article.headline, source: "news" as const, id: String(article.id) }))),
    ...actions.map(action => ({ symbol: action.symbol, kind: action.type === "cashDividends" ? "dividend" : "corporate_action", at: action.eventDate!, label: action.label, source: "corporate_action" as const, id: action.id })),
    ...filings.map(filing => ({ symbol: filing.symbol, kind: "sec_8k", at: `${filing.filed}T00:00:00.000Z`, label: `Item ${filing.primaryItem.code}: ${filing.primaryItem.label}`, source: "sec_8k" as const, id: filing.id })),
  ];
  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = `${entry.symbol}:${entry.kind}`, group = grouped.get(key) ?? [];
    if (!group.some(item => item.id === entry.id)) group.push(entry);
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([key, timeline]) => {
    const [symbol, kind] = key.split(":");
    return { symbol: symbol!, kind: kind!, count: timeline.length, latestAt: timeline.map(item => item.at).sort().at(-1)!, timeline: timeline.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5) };
  }).sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt)).slice(0, 12);
}
