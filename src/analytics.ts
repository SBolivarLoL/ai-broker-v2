export type PerformancePoint = { timestamp: number; equity: number; profitLoss: number; profitLossPercent: number };

const valid = (value: number) => Number.isFinite(value);
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function performancePoints(history: { timestamp: number[]; equity: number[]; profitLoss: number[]; profitLossPct: number[] }) {
  const length = Math.min(history.timestamp.length, history.equity.length, history.profitLoss.length, history.profitLossPct.length);
  return Array.from({ length }, (_, index) => ({
    timestamp: history.timestamp[index] * 1_000,
    equity: history.equity[index],
    profitLoss: history.profitLoss[index],
    profitLossPercent: history.profitLossPct[index] * 100,
  })).filter(point => Object.values(point).every(valid) && point.equity > 0);
}

export function performanceSummary(points: PerformancePoint[]) {
  if (!points.length) return { totalProfitLoss: 0, totalReturnPercent: 0, annualizedReturnPercent: 0, sharpeRatio: 0, positiveDaysPercent: 0, bestDayPercent: 0, worstDayPercent: 0 };
  const returns = points.slice(1).map((point, index) => point.equity / points[index].equity - 1).filter(valid);
  const average = mean(returns);
  const variance = returns.length > 1 ? returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1) : 0;
  const elapsedYears = Math.max(1 / 252, (points.at(-1)!.timestamp - points[0].timestamp) / (365.25 * 86_400_000));
  const startingEquity = points[0].equity;
  const endingEquity = points.at(-1)!.equity;
  const totalReturn = startingEquity > 0 ? endingEquity / startingEquity - 1 : 0;
  return {
    totalProfitLoss: points.at(-1)!.profitLoss,
    totalReturnPercent: points.at(-1)!.profitLossPercent,
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
