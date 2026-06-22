type Series = { symbol: string; weight: number; closes: number[] };
const returns = (values: number[]) => values.slice(1).map((value, index) => value / values[index]! - 1);
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const covariance = (left: number[], right: number[]) => {
  const length = Math.min(left.length, right.length), a = left.slice(-length), b = right.slice(-length), am = mean(a), bm = mean(b);
  return length > 1 ? a.reduce((sum, value, index) => sum + (value - am) * (b[index]! - bm), 0) / (length - 1) : 0;
};

export function advancedPortfolioRisk(equity: number, series: Series[], benchmarkCloses: number[]) {
  const usable = series.map(item => ({ ...item, returns: returns(item.closes) })).filter(item => item.returns.length >= 2);
  const length = Math.min(...usable.map(item => item.returns.length));
  const aligned = usable.map(item => ({ ...item, returns: item.returns.slice(-length) }));
  const portfolioReturns = Number.isFinite(length) ? Array.from({ length }, (_, index) => aligned.reduce((sum, item) => sum + item.weight * item.returns[index]!, 0)) : [];
  const sorted = [...portfolioReturns].sort((a, b) => a - b), cutoffIndex = Math.max(0, Math.floor(sorted.length * .05) - 1), cutoff = sorted[cutoffIndex] ?? 0, tail = sorted.filter(value => value <= cutoff);
  const average = mean(portfolioReturns), variance = covariance(portfolioReturns, portfolioReturns), deviation = Math.sqrt(Math.max(0, variance));
  const historicalVar = Math.max(0, -cutoff * equity), expectedShortfall = Math.max(0, -mean(tail) * equity), parametricVar = Math.max(0, (1.644854 * deviation - average) * equity);
  const correlation = aligned.map(left => ({ symbol: left.symbol, values: aligned.map(right => {
    const denominator = Math.sqrt(covariance(left.returns, left.returns) * covariance(right.returns, right.returns));
    return { symbol: right.symbol, correlation: denominator ? covariance(left.returns, right.returns) / denominator : left.symbol === right.symbol ? 1 : 0 };
  }) }));
  const portfolioVariance = aligned.reduce((outer, left) => outer + aligned.reduce((inner, right) => inner + left.weight * right.weight * covariance(left.returns, right.returns), 0), 0);
  const riskContribution = aligned.map(left => {
    const marginal = aligned.reduce((sum, right) => sum + right.weight * covariance(left.returns, right.returns), 0);
    return { symbol: left.symbol, percent: portfolioVariance > 0 ? left.weight * marginal / portfolioVariance * 100 : 0 };
  }).sort((a, b) => b.percent - a.percent);
  const benchmarkReturns = returns(benchmarkCloses).slice(-portfolioReturns.length), comparableLength = Math.min(benchmarkReturns.length, portfolioReturns.length), portfolio = portfolioReturns.slice(-comparableLength), benchmark = benchmarkReturns.slice(-comparableLength), benchmarkVariance = covariance(benchmark, benchmark), beta = benchmarkVariance ? covariance(portfolio, benchmark) / benchmarkVariance : null, active = portfolio.map((value, index) => value - benchmark[index]!), trackingError = Math.sqrt(Math.max(0, covariance(active, active))) * Math.sqrt(252), annualizedActive = mean(active) * 252;
  return { observations: portfolioReturns.length, historicalVar95: historicalVar, parametricVar95: parametricVar, expectedShortfall95: expectedShortfall, correlation, riskContribution, benchmark: { beta, annualizedAlphaPercent: beta === null ? null : (mean(portfolio) - beta * mean(benchmark)) * 252 * 100, trackingErrorPercent: trackingError * 100, informationRatio: trackingError ? annualizedActive / trackingError : null } };
}

export function positionLiquidity(position: { symbol: string; qty: unknown; marketValue: unknown }, snapshot: any, closesAndVolume: { volume: number }[]) {
  const bid = Number(snapshot?.latestQuote?.bp), ask = Number(snapshot?.latestQuote?.ap), midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null, averageDailyVolume = mean(closesAndVolume.map(bar => Number(bar.volume)).filter(value => Number.isFinite(value) && value >= 0)), qty = Math.abs(Number(position.qty));
  return { symbol: position.symbol, spreadBps: midpoint && ask >= bid ? (ask - bid) / midpoint * 10_000 : null, averageDailyVolume, daysAtTenPercentAdv: averageDailyVolume > 0 ? qty / (averageDailyVolume * .1) : null, marketValue: Number(position.marketValue) };
}
