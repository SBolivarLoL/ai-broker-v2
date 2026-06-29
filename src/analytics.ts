export type PerformancePoint = { timestamp: number; equity: number; profitLoss: number; profitLossPercent: number; externalCashFlow: number };
export type BenchmarkBar = { timestamp: Date | string | number; close: number };

const valid = (value: number) => Number.isFinite(value);
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function performancePoints(history: { timestamp: number[]; equity: number[]; profitLoss: number[]; profitLossPct: number[]; cashflow?: object }) {
  const length = Math.min(history.timestamp.length, history.equity.length, history.profitLoss.length, history.profitLossPct.length);
  const cashflows = Object.values(history.cashflow ?? {}).filter(Array.isArray) as unknown[][];
  const externalCashFlows = Array.from({ length }, (_, index) => cashflows.reduce((sum, values) => sum + Number(values[index] ?? 0), 0));
  const firstFunded = history.equity.findIndex(equity => Number(equity) > 0);
  if (firstFunded >= 0 && history.equity.slice(0, firstFunded).every(equity => Number(equity) <= 0)) {
    const delayedFunding = externalCashFlows.findIndex((flow, index) => index >= firstFunded && flow > 0 && Math.abs(flow - history.equity[firstFunded]) <= Math.max(1, history.equity[firstFunded] * .01));
    if (delayedFunding > firstFunded) {
      externalCashFlows[firstFunded] += externalCashFlows[delayedFunding];
      externalCashFlows[delayedFunding] = 0;
    }
  }
  return Array.from({ length }, (_, index) => ({
    timestamp: history.timestamp[index] * 1_000,
    equity: history.equity[index],
    profitLoss: history.profitLoss[index],
    profitLossPercent: history.profitLossPct[index] * 100,
    externalCashFlow: externalCashFlows[index],
  })).filter(point => Object.values(point).every(valid) && point.equity > 0);
}

export function timeWeightedReturn(points: PerformancePoint[]) {
  if (!points.length) return 0;
  return points.at(-1)!.profitLossPercent / 100;
}

export function moneyWeightedReturn(points: PerformancePoint[]) {
  if (points.length < 2) return null;
  const first = points[0], last = points.at(-1)!;
  const flows = [{ timestamp: first.timestamp, amount: -first.equity }, ...points.slice(1).map(point => ({ timestamp: point.timestamp, amount: -point.externalCashFlow }))];
  flows.push({ timestamp: last.timestamp, amount: last.equity });
  const years = (timestamp: number) => Math.max(0, (timestamp - first.timestamp) / (365.25 * 86_400_000));
  const npv = (rate: number) => flows.reduce((sum, flow) => sum + flow.amount / ((1 + rate) ** years(flow.timestamp)), 0);
  let low = -0.9999, high = 1;
  let lowValue = npv(low), highValue = npv(high);
  while (lowValue * highValue > 0 && high < 1_000_000) { high *= 2; highValue = npv(high); }
  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue) || lowValue * highValue > 0) return null;
  for (let index = 0; index < 120; index++) {
    const middle = (low + high) / 2, value = npv(middle);
    if (Math.abs(value) < 1e-8) return middle;
    if (lowValue * value <= 0) high = middle;
    else { low = middle; lowValue = value; }
  }
  return (low + high) / 2;
}

export function benchmarkAttribution(points: PerformancePoint[], bars: BenchmarkBar[], symbol: string) {
  const normalized = bars.map(bar => ({ timestamp: new Date(bar.timestamp).getTime(), close: Number(bar.close) }))
    .filter(bar => Number.isFinite(bar.timestamp) && Number.isFinite(bar.close) && bar.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const start = points[0]?.timestamp, end = points.at(-1)?.timestamp;
  const covered = normalized.filter(bar => start !== undefined && end !== undefined && bar.timestamp >= start && bar.timestamp <= end + 86_400_000);
  const portfolioReturnPercent = timeWeightedReturn(points) * 100;
  if (covered.length < 2) return { symbol, returnPercent: null, activeReturnPercent: null, observations: covered.length, quality: "insufficient" as const };
  const returnPercent = (covered.at(-1)!.close / covered[0].close - 1) * 100;
  return { symbol, returnPercent, activeReturnPercent: portfolioReturnPercent - returnPercent, observations: covered.length, quality: "complete" as const };
}

export function performanceSummary(points: PerformancePoint[]) {
  if (!points.length) return { totalProfitLoss: 0, totalReturnPercent: 0, timeWeightedReturnPercent: 0, moneyWeightedReturnPercent: null, annualizedReturnPercent: 0, sharpeRatio: 0, positiveDaysPercent: 0, bestDayPercent: 0, worstDayPercent: 0 };
  const returns = points.slice(1).map((point, index) => (1 + point.profitLossPercent / 100) / (1 + points[index].profitLossPercent / 100) - 1).filter(valid);
  const average = mean(returns);
  const variance = returns.length > 1 ? returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1) : 0;
  const elapsedYears = Math.max(1 / 252, (points.at(-1)!.timestamp - points[0].timestamp) / (365.25 * 86_400_000));
  const startingEquity = points[0].equity;
  const endingEquity = points.at(-1)!.equity;
  const totalReturn = startingEquity > 0 ? endingEquity / startingEquity - 1 : 0;
  const twr = timeWeightedReturn(points);
  const mwr = moneyWeightedReturn(points);
  return {
    totalProfitLoss: points.at(-1)!.profitLoss,
    totalReturnPercent: points.at(-1)!.profitLossPercent,
    timeWeightedReturnPercent: twr * 100,
    moneyWeightedReturnPercent: mwr === null ? null : mwr * 100,
    annualizedReturnPercent: totalReturn > -1 ? ((1 + totalReturn) ** (1 / elapsedYears) - 1) * 100 : -100,
    sharpeRatio: variance > 0 ? average / Math.sqrt(variance) * Math.sqrt(252) : 0,
    positiveDaysPercent: returns.length ? returns.filter(value => value > 0).length / returns.length * 100 : 0,
    bestDayPercent: (returns.length ? Math.max(...returns) : 0) * 100,
    worstDayPercent: (returns.length ? Math.min(...returns) : 0) * 100,
  };
}

export function valueAtRisk95(equity: number, normalizedEquity: number[]) {
  const returns = normalizedEquity.slice(1).map((value, index) => value / normalizedEquity[index] - 1).filter(valid).sort((a, b) => a - b);
  if (!returns.length || equity <= 0) return { valueAtRisk95Percent: 0, valueAtRisk95: 0 };
  const percentile = returns[Math.max(0, Math.ceil(returns.length * 0.05) - 1)];
  const lossPercent = Math.max(0, -percentile * 100);
  return { valueAtRisk95Percent: lossPercent, valueAtRisk95: equity * lossPercent / 100 };
}

export function stressTests(equity: number, cash: number, weights: { symbol: string; percent: number }[]) {
  const invested = Math.max(0, equity - cash);
  const largest = weights[0];
  return [
    { name: "Broad selloff", detail: "All holdings fall 10%", estimatedLoss: invested * 0.10, resultingEquity: equity - invested * 0.10 },
    { name: "Severe bear market", detail: "All holdings fall 20%", estimatedLoss: invested * 0.20, resultingEquity: equity - invested * 0.20 },
    { name: "Largest holding shock", detail: largest ? `${largest.symbol} falls 25%` : "No invested position", estimatedLoss: equity * (largest?.percent ?? 0) / 100 * 0.25, resultingEquity: equity * (1 - (largest?.percent ?? 0) / 100 * 0.25) },
  ];
}

export function diversificationScore(hhi: number, largestPositionPercent: number) {
  const score = Math.round(Math.max(0, Math.min(100, 100 - hhi * 100 - Math.max(0, largestPositionPercent - 10) * 1.5)));
  return { score, label: score >= 75 ? "Well diversified" : score >= 50 ? "Moderately concentrated" : "Highly concentrated" };
}
