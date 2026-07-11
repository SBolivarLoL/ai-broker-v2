/**
 * Builds asset-class, SEC SIC, and return-derived factor exposure reports with
 * explicit source coverage and methodology warnings.
 */
export type ExposureBar = {
  date: string;
  close: number;
  observedAt?: string | number | Date;
};
export type ExposureClassification = { sic: string; industry: string | null; sourceUrl: string };
export type ExposurePosition = {
  symbol: string;
  marketValue: number;
  assetClass: string;
  bars?: ExposureBar[];
  classification?: ExposureClassification | null;
  marketDataSource?: string | null;
  warnings?: string[];
};

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sampleDeviation = (values: number[]) => {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const round = (value: number) => Number(value.toFixed(4));

export function secSicDivision(rawSic: string | number) {
  const sic = Number(rawSic);
  if (!Number.isInteger(sic) || sic < 100 || sic > 9999) return null;
  if (sic <= 999) return "Agriculture, forestry and fishing";
  if (sic <= 1499) return "Mining";
  if (sic <= 1799) return "Construction";
  if (sic <= 3999) return "Manufacturing";
  if (sic <= 4999) return "Transportation, communications and utilities";
  if (sic <= 5199) return "Wholesale trade";
  if (sic <= 5999) return "Retail trade";
  if (sic <= 6799) return "Finance, insurance and real estate";
  if (sic <= 8999) return "Services";
  if (sic <= 9729) return "Public administration";
  return "Nonclassifiable establishments";
}

function normalizedAssetClass(value: string) {
  const labels: Record<string, string> = { us_equity: "US equity", us_option: "US option", crypto: "Crypto" };
  return labels[value] ?? (value.replaceAll("_", " ") || "Unknown");
}

function normalizedBars(values: ExposureBar[] | undefined) {
  if (!values) return [];
  const byDate = new Map<string, number>();
  for (const bar of values) {
    const date = String(bar.date).slice(0, 10), close = Number(bar.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) return [];
    byDate.set(date, close);
  }
  return [...byDate].sort(([left], [right]) => left.localeCompare(right)).map(([date, close]) => ({ date, close }));
}

function datedReturns(bars: ExposureBar[]) {
  return new Map(bars.slice(1).map((bar, index) => [bar.date, bar.close / bars[index]!.close - 1]));
}

function factorValues(rawBars: ExposureBar[] | undefined, rawBenchmark: ExposureBar[]) {
  const bars = normalizedBars(rawBars), benchmark = normalizedBars(rawBenchmark);
  const returns = datedReturns(bars), benchmarkReturns = datedReturns(benchmark);
  // Match by session date rather than array position; missing market days must
  // not shift a position return against the wrong benchmark return.
  const dates = [...returns.keys()].filter(date => benchmarkReturns.has(date));
  const marketBeta = dates.length >= 20 ? (() => {
    const left = dates.map(date => returns.get(date)!), right = dates.map(date => benchmarkReturns.get(date)!);
    const lm = mean(left), rm = mean(right);
    const covariance = left.reduce((sum, value, index) => sum + (value - lm) * (right[index]! - rm), 0) / (left.length - 1);
    const variance = right.reduce((sum, value) => sum + (value - rm) ** 2, 0) / (right.length - 1);
    return variance > 0 ? covariance / variance : null;
  })() : null;
  const momentum63dPercent = bars.length >= 64 ? (bars.at(-1)!.close / bars.at(-64)!.close - 1) * 100 : null;
  const recentReturns = [...returns.values()].slice(-20), deviation = sampleDeviation(recentReturns);
  const volatility20dPercent = deviation === null || recentReturns.length < 20 ? null : deviation * Math.sqrt(252) * 100;
  return { marketBeta, momentum63dPercent, volatility20dPercent, observations: dates.length };
}

function aggregate(values: Array<{ label: string; symbol: string; marketValue: number }>, equity: number) {
  const groups = new Map<string, { label: string; netValue: number; grossValue: number; symbols: string[] }>();
  for (const item of values) {
    const group = groups.get(item.label) ?? { label: item.label, netValue: 0, grossValue: 0, symbols: [] };
    group.netValue += item.marketValue;
    group.grossValue += Math.abs(item.marketValue);
    if (!group.symbols.includes(item.symbol)) group.symbols.push(item.symbol);
    groups.set(item.label, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    netPercent: round(group.netValue / equity * 100),
    grossPercent: round(group.grossValue / equity * 100),
  })).sort((left, right) => right.grossPercent - left.grossPercent || left.label.localeCompare(right.label));
}

export function buildPortfolioExposureReport(input: { equity: number; cash: number; positions: ExposurePosition[]; benchmarkBars: ExposureBar[]; asOf?: string; warnings?: string[] }) {
  if (!Number.isFinite(input.equity) || input.equity <= 0 || !Number.isFinite(input.cash)) throw new Error("Valid portfolio equity and cash are required");
  const positions = input.positions.map(position => ({ ...position, marketValue: Number(position.marketValue), factors: factorValues(position.bars, input.benchmarkBars) }));
  if (positions.some(position => !position.symbol || !Number.isFinite(position.marketValue))) throw new Error("Exposure positions must have a symbol and finite market value");
  const equityPositions = positions.filter(position => position.assetClass === "us_equity");
  const equityGross = equityPositions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  const classifiedGross = equityPositions.filter(position => position.classification && secSicDivision(position.classification.sic)).reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  const investedGross = positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);

  const factorDefinitions = [
    { id: "market_beta", label: "Market beta", unit: "beta", key: "marketBeta" as const, method: "Weighted position beta versus SPY from date-aligned daily returns (minimum 20 observations)." },
    { id: "momentum_63d", label: "63-session momentum", unit: "%", key: "momentum63dPercent" as const, method: "Weighted close-to-close return across 63 trading sessions." },
    { id: "volatility_20d", label: "20-session volatility", unit: "% annualized", key: "volatility20dPercent" as const, method: "Weighted sample volatility of the latest 20 daily returns, annualized with 252 sessions." },
  ];
  const factors = factorDefinitions.map(definition => {
    const available = positions.filter(position => position.factors[definition.key] !== null);
    const value = available.reduce((sum, position) => sum + position.marketValue / input.equity * position.factors[definition.key]!, 0);
    const coveredGross = available.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
    return { ...definition, value: available.length ? round(value) : null, coveragePercent: investedGross ? round(coveredGross / investedGross * 100) : 0 };
  });

  const sectors = aggregate(equityPositions.map(position => ({ label: position.classification ? secSicDivision(position.classification.sic) ?? "Unclassified" : "Unclassified", symbol: position.symbol, marketValue: position.marketValue })), input.equity);
  const industries = aggregate(equityPositions.map(position => ({ label: position.classification?.industry || "Unclassified", symbol: position.symbol, marketValue: position.marketValue })), input.equity);
  const assetClasses = aggregate([
    ...positions.map(position => ({ label: normalizedAssetClass(position.assetClass), symbol: position.symbol, marketValue: position.marketValue })),
    { label: "Cash", symbol: "CASH", marketValue: input.cash },
  ], input.equity);
  const classificationCoveragePercent = equityGross ? round(classifiedGross / equityGross * 100) : 0;
  const warnings = ["Sector and industry labels use the SEC SIC taxonomy, not GICS or ICB classifications.", "Return-derived factor diagnostics are historical descriptions, not forecasts or expected returns.", ...positions.flatMap(position => position.warnings ?? []), ...(input.warnings ?? [])];
  if (equityGross && classificationCoveragePercent < 100) warnings.push(`${round(100 - classificationCoveragePercent)}% of gross US-equity exposure has no usable SEC SIC classification.`);
  if (!equityGross) warnings.push("The portfolio has no US-equity exposure to classify by SEC SIC.");
  for (const factor of factors) if (factor.coveragePercent < 100) warnings.push(`${factor.label} covers ${factor.coveragePercent}% of gross invested exposure; unavailable positions contribute zero and remain a coverage gap.`);
  const sources = positions.flatMap(position => position.classification ? [{ symbol: position.symbol, provider: "SEC", taxonomy: "SIC", sic: position.classification.sic, industry: position.classification.industry, sector: secSicDivision(position.classification.sic), url: position.classification.sourceUrl }] : []);
  return {
    asOf: new Date(input.asOf ?? Date.now()).toISOString(),
    benchmark: "SPY",
    assetClasses,
    sectors,
    industries,
    factors,
    positions: positions.map(position => ({ symbol: position.symbol, assetClass: normalizedAssetClass(position.assetClass), marketValue: position.marketValue, sector: position.classification ? secSicDivision(position.classification.sic) : null, industry: position.classification?.industry ?? null, sic: position.classification?.sic ?? null, marketDataSource: position.marketDataSource ?? null, factors: position.factors })),
    quality: { classificationScheme: "SEC SIC", classificationCoveragePercent, grossInvestedPercent: round(investedGross / input.equity * 100) },
    sources,
    warnings: [...new Set(warnings)],
  };
}
