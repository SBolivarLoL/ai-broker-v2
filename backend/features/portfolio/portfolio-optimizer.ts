/**
 * Generates constrained long-only allocation proposals from current holdings.
 * Results are planning inputs, never executable orders.
 */
import { z } from "zod";

export const PortfolioOptimizerRequest = z.object({
  maxWeightPercent: z.coerce.number().finite().min(1).max(100).default(20),
  maxTurnoverPercent: z.coerce.number().finite().min(0).max(100).default(10),
  cashReservePercent: z.coerce.number().finite().min(0).max(100).default(5),
  minObservations: z.coerce.number().int().min(10).max(252).default(30),
});

export type PortfolioOptimizerRequest = z.infer<typeof PortfolioOptimizerRequest>;
export type OptimizerPosition = { symbol: string; marketValue: number; closes: number[] };

const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const returns = (values: number[]) => values.slice(1).map((value, index) => value / values[index]! - 1).filter(Number.isFinite);
const variance = (values: number[]) => {
  const average = mean(values);
  return values.length > 1 ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1) : 0;
};
const covariance = (left: number[], right: number[]) => {
  const length = Math.min(left.length, right.length), a = left.slice(-length), b = right.slice(-length), am = mean(a), bm = mean(b);
  return length > 1 ? a.reduce((sum, value, index) => sum + (value - am) * (b[index]! - bm), 0) / (length - 1) : 0;
};

function cappedWeights(scores: Map<string, number>, budget: number, maxWeight: number) {
  const result = new Map<string, number>(), remaining = new Map([...scores].filter(([, score]) => score > 0));
  let cashResidual = Math.max(0, budget), capBound = false;
  while (remaining.size && cashResidual > 1e-10) {
    const scoreTotal = [...remaining.values()].reduce((sum, score) => sum + score, 0);
    let cappedThisRound = false;
    for (const [symbol, score] of [...remaining]) {
      const weight = scoreTotal ? cashResidual * score / scoreTotal : cashResidual / remaining.size;
      if (weight > maxWeight + 1e-10) {
        result.set(symbol, maxWeight);
        remaining.delete(symbol);
        cashResidual -= maxWeight;
        capBound = cappedThisRound = true;
      }
    }
    if (!cappedThisRound) {
      for (const [symbol, score] of remaining) result.set(symbol, scoreTotal ? cashResidual * score / scoreTotal : cashResidual / remaining.size);
      cashResidual = 0;
      break;
    }
  }
  return { weights: result, cashResidual: Math.max(0, cashResidual), capBound };
}

function scaleTurnover(current: Map<string, number>, target: Map<string, number>, maxTurnover: number) {
  const symbols = new Set([...current.keys(), ...target.keys()]);
  const turnover = [...symbols].reduce((sum, symbol) => sum + Math.abs((target.get(symbol) ?? 0) - (current.get(symbol) ?? 0)), 0);
  const scale = turnover > maxTurnover && turnover > 0 ? maxTurnover / turnover : 1;
  return {
    weights: new Map([...symbols].map(symbol => [symbol, (current.get(symbol) ?? 0) + ((target.get(symbol) ?? 0) - (current.get(symbol) ?? 0)) * scale])),
    turnoverScale: scale,
  };
}

function proposal(input: {
  id: string;
  name: string;
  description: string;
  symbols: string[];
  currentWeights: Map<string, number>;
  means: Map<string, number>;
  covariance: Map<string, Map<string, number>>;
  rawScores: Map<string, number>;
  budget: number;
  maxWeight: number;
  maxTurnover: number;
}) {
  const capped = cappedWeights(input.rawScores, input.budget, input.maxWeight);
  const scaled = scaleTurnover(input.currentWeights, capped.weights, input.maxTurnover);
  const weights = scaled.weights;
  const expectedDailyReturn = input.symbols.reduce((sum, symbol) => sum + (weights.get(symbol) ?? 0) * (input.means.get(symbol) ?? 0), 0);
  const dailyVariance = input.symbols.reduce((outer, left) => outer + input.symbols.reduce((inner, right) => inner + (weights.get(left) ?? 0) * (weights.get(right) ?? 0) * (input.covariance.get(left)?.get(right) ?? 0), 0), 0);
  const marginal = new Map(input.symbols.map(symbol => [symbol, input.symbols.reduce((sum, other) => sum + (weights.get(other) ?? 0) * (input.covariance.get(symbol)?.get(other) ?? 0), 0)]));
  const rows = input.symbols.map(symbol => {
    const targetWeight = weights.get(symbol) ?? 0, currentWeight = input.currentWeights.get(symbol) ?? 0;
    return {
      symbol,
      currentWeightPercent: round(currentWeight * 100),
      targetWeightPercent: round(targetWeight * 100),
      deltaPercent: round((targetWeight - currentWeight) * 100),
      expectedAnnualReturnPercent: round((input.means.get(symbol) ?? 0) * 252 * 100),
      annualizedVolatilityPercent: round(Math.sqrt(Math.max(0, input.covariance.get(symbol)?.get(symbol) ?? 0) * 252) * 100),
      riskContributionPercent: round(dailyVariance > 0 ? targetWeight * (marginal.get(symbol) ?? 0) / dailyVariance * 100 : 0),
    };
  }).sort((left, right) => Math.abs(right.deltaPercent) - Math.abs(left.deltaPercent) || left.symbol.localeCompare(right.symbol));
  const turnoverPercent = rows.reduce((sum, row) => sum + Math.abs(row.deltaPercent), 0);
  const bindingConstraints = [
    ...(capped.capBound ? ["max_weight"] : []),
    ...(capped.cashResidual > 1e-8 ? ["cash_residual"] : []),
    ...(scaled.turnoverScale < 0.999999 ? ["turnover_budget"] : []),
  ];
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    expectedAnnualReturnPercent: round(expectedDailyReturn * 252 * 100),
    annualizedVolatilityPercent: round(Math.sqrt(Math.max(0, dailyVariance) * 252) * 100),
    turnoverPercent: round(turnoverPercent),
    maxPositionWeightPercent: round(Math.max(0, ...rows.map(row => row.targetWeightPercent))),
    bindingConstraints,
    targetDraft: rows.filter(row => row.targetWeightPercent >= 0.05).map(row => `${row.symbol} ${round(row.targetWeightPercent, 2)}`).join("\n"),
    weights: rows,
  };
}

export function buildPortfolioOptimizerReport(input: {
  equity: number;
  positions: OptimizerPosition[];
  request?: unknown;
  asOf?: string;
}) {
  const request = PortfolioOptimizerRequest.parse(input.request ?? {});
  if (!Number.isFinite(input.equity) || input.equity <= 0) throw new Error("Valid portfolio equity is required");
  const currentWeights = new Map(input.positions.map(position => [position.symbol, Math.max(0, Number(position.marketValue)) / input.equity]));
  const prepared = input.positions.map(position => ({ ...position, returns: returns(position.closes) }));
  const usable = prepared.filter(position => position.returns.length >= request.minObservations && Number(position.marketValue) > 0);
  const warnings = prepared.filter(position => !usable.some(item => item.symbol === position.symbol)).map(position => `${position.symbol} has insufficient positive-position return history for optimization.`);
  if (!usable.length) return { asOf: input.asOf ?? new Date().toISOString(), proposals: [], coverage: { optimizedSymbols: [], omittedSymbols: prepared.map(position => position.symbol), optimizedWeightPercent: 0 }, warnings: warnings.length ? warnings : ["No current long equity positions have enough return history for optimization."], methodology: [] };
  const length = Math.min(...usable.map(position => position.returns.length));
  const aligned = usable.map(position => ({ ...position, returns: position.returns.slice(-length) }));
  const rawMeans = new Map(aligned.map(position => [position.symbol, mean(position.returns)]));
  const crossMean = mean([...rawMeans.values()]);
  // Shrink noisy per-symbol means toward the cross-sectional mean and
  // off-diagonal covariance toward zero to reduce small-sample instability.
  const means = new Map([...rawMeans].map(([symbol, value]) => [symbol, value * 0.5 + crossMean * 0.5]));
  const covarianceMatrix = new Map<string, Map<string, number>>();
  for (const left of aligned) {
    const row = new Map<string, number>();
    for (const right of aligned) {
      const raw = covariance(left.returns, right.returns);
      row.set(right.symbol, left.symbol === right.symbol ? Math.max(raw, 1e-8) : raw * 0.75);
    }
    covarianceMatrix.set(left.symbol, row);
  }
  const symbols = aligned.map(position => position.symbol).sort();
  const optimizedCurrentWeight = symbols.reduce((sum, symbol) => sum + (currentWeights.get(symbol) ?? 0), 0);
  const omittedWeight = [...currentWeights].filter(([symbol]) => !symbols.includes(symbol)).reduce((sum, [, weight]) => sum + weight, 0);
  const budget = Math.max(0, Math.min(1 - request.cashReservePercent / 100 - omittedWeight, 1));
  const maxWeight = request.maxWeightPercent / 100, maxTurnover = request.maxTurnoverPercent / 100;
  const inverseVolScores = new Map(symbols.map(symbol => [symbol, 1 / Math.sqrt(covarianceMatrix.get(symbol)?.get(symbol) ?? 1)]));
  const meanVarianceScores = new Map(symbols.map(symbol => {
    const annualMean = (means.get(symbol) ?? 0) * 252, annualVariance = (covarianceMatrix.get(symbol)?.get(symbol) ?? 1e-8) * 252;
    return [symbol, Math.max(0, annualMean) / Math.max(annualVariance, 1e-8)];
  }));
  if (![...meanVarianceScores.values()].some(score => score > 0)) {
    for (const symbol of symbols) meanVarianceScores.set(symbol, 1 / Math.max(covarianceMatrix.get(symbol)?.get(symbol) ?? 1e-8, 1e-8));
    warnings.push("All shrunk expected returns are non-positive; the mean-variance proposal falls back to minimum-variance scores.");
  }
  const proposals = [
    proposal({ id: "risk_parity", name: "Risk parity", description: "Inverse-volatility weights with capped long-only positions and turnover scaling.", symbols, currentWeights, means, covariance: covarianceMatrix, rawScores: inverseVolScores, budget, maxWeight, maxTurnover }),
    proposal({ id: "mean_variance", name: "Mean-variance tilt", description: "Shrunk return-to-variance scores with capped long-only positions and turnover scaling.", symbols, currentWeights, means, covariance: covarianceMatrix, rawScores: meanVarianceScores, budget, maxWeight, maxTurnover }),
  ];
  return {
    asOf: input.asOf ?? new Date().toISOString(),
    proposals,
    coverage: { optimizedSymbols: symbols, omittedSymbols: prepared.filter(position => !symbols.includes(position.symbol)).map(position => position.symbol), optimizedWeightPercent: round(optimizedCurrentWeight * 100), observations: length },
    constraints: { maxWeightPercent: request.maxWeightPercent, maxTurnoverPercent: request.maxTurnoverPercent, cashReservePercent: request.cashReservePercent, minObservations: request.minObservations },
    warnings,
    methodology: [
      "Uses current long equity holdings only; it does not infer new tickers or short positions.",
      "Daily returns are aligned over the shared available window, expected returns are shrunk halfway to the cross-sectional mean and off-diagonal covariance is shrunk toward zero.",
      "Outputs are target-weight proposals for the constrained rebalance planner, not orders or forecasts.",
    ],
  };
}
