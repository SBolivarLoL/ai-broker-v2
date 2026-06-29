import type { StrategyRunStatus } from "./store";

type StrategyPerformanceRun = {
  id: string;
  strategyId: string;
  strategyVersion: string;
  status: StrategyRunStatus;
  symbols: string[];
  budget: number;
  config?: any;
};
type StrategyPerformanceOrder = {
  id: string;
  paperOrderId: string;
  status: string;
  payload: any;
  createdAt: string;
  updatedAt: string;
};
type PerformanceBar = { timestamp?: Date | string | number; t?: Date | string | number; close?: number | string | null; c?: number | string | null };

const finiteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const validDate = (value: unknown) => {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date : null;
};
const percent = (value: number, base: number) => base > 0 ? value / base * 100 : null;

function normalizedBars(bars: PerformanceBar[] = []) {
  return bars.map(bar => {
    const timestamp = validDate(bar.timestamp ?? bar.t);
    const close = finiteNumber(bar.close ?? bar.c);
    return timestamp && close && close > 0 ? { timestamp, close } : null;
  }).filter((bar): bar is { timestamp: Date; close: number } => Boolean(bar)).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function filledOrder(order: StrategyPerformanceOrder) {
  const payload = order.payload ?? {};
  const broker = payload.broker ?? {};
  const status = String(broker.status ?? order.status ?? "");
  const symbol = String(payload.symbol ?? broker.symbol ?? "");
  const side = String(payload.side ?? broker.side ?? "").toLowerCase();
  const filledAt = validDate(broker.filledAt ?? payload.filledAt ?? (status === "filled" ? order.updatedAt : null));
  const price = finiteNumber(broker.filledAvgPrice ?? payload.filledAvgPrice);
  const qty = finiteNumber(broker.filledQty ?? payload.filledQty ?? payload.qty);
  const notional = finiteNumber(payload.notional) ?? (qty && price ? qty * price : null);
  if (status !== "filled" || !symbol || !filledAt || !price || !qty || qty <= 0 || !notional || !["buy", "sell"].includes(side)) return null;
  return { id: order.id, paperOrderId: order.paperOrderId, symbol, side, filledAt, price, qty, notional };
}

function maxDrawdownPercent(equity: number[]) {
  let peak = equity[0] ?? 0;
  let drawdown = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - value) / peak);
  }
  return drawdown * 100;
}

export function buildStrategyPerformance(input: {
  run: StrategyPerformanceRun;
  orders: StrategyPerformanceOrder[];
  barsBySymbol?: Record<string, PerformanceBar[]>;
  generatedAt?: string;
}) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const barsBySymbol = Object.fromEntries(Object.entries(input.barsBySymbol ?? {}).map(([symbol, bars]) => [symbol, normalizedBars(bars)]));
  const fills = input.orders.map(filledOrder).filter((fill): fill is NonNullable<typeof fill> => Boolean(fill)).sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());
  const approvalBudget = finiteNumber(input.run.config?.paperApproval?.budget);
  const totalBuyNotional = fills.filter(fill => fill.side === "buy").reduce((sum, fill) => sum + fill.notional, 0);
  const initialCapital = approvalBudget && approvalBudget > 0 ? approvalBudget : input.run.budget > 0 ? input.run.budget : totalBuyNotional;
  const warnings = [
    fills.length ? null : "No filled strategy paper orders are available for active-run performance yet.",
    initialCapital > 0 ? null : "Strategy performance needs a positive budget or filled buy notional.",
  ].filter(Boolean) as string[];

  if (!fills.length || initialCapital <= 0) {
    return {
      performanceVersion: "strategy-performance-v1",
      generatedAt,
      run: { id: input.run.id, strategyId: input.run.strategyId, strategyVersion: input.run.strategyVersion, status: input.run.status, symbols: input.run.symbols },
      summary: {
        status: "insufficient_data",
        initialCapital,
        currentEquity: null,
        totalPnl: null,
        totalReturnPercent: null,
        maxDrawdownPercent: null,
        filledOrders: fills.length,
        firstFillAt: null,
        lastMarkAt: null,
      },
      baselines: { cash: null, buyAndHold: null, equalWeight: null },
      points: [],
      warnings,
    };
  }

  const firstFillAt = fills[0]!.filledAt;
  const symbols = [...new Set([...input.run.symbols, ...fills.map(fill => fill.symbol)])];
  const timeline = [...new Set(Object.values(barsBySymbol).flatMap(bars => bars.filter(bar => bar.timestamp.getTime() >= firstFillAt.getTime()).map(bar => bar.timestamp.toISOString())))].sort();
  if (!timeline.length) {
    warnings.push("No crypto bars are available after the first strategy fill.");
    return {
      performanceVersion: "strategy-performance-v1",
      generatedAt,
      run: { id: input.run.id, strategyId: input.run.strategyId, strategyVersion: input.run.strategyVersion, status: input.run.status, symbols: input.run.symbols },
      summary: {
        status: "insufficient_data",
        initialCapital,
        currentEquity: null,
        totalPnl: null,
        totalReturnPercent: null,
        maxDrawdownPercent: null,
        filledOrders: fills.length,
        firstFillAt: firstFillAt.toISOString(),
        lastMarkAt: null,
      },
      baselines: { cash: null, buyAndHold: null, equalWeight: null },
      points: [],
      warnings,
    };
  }

  let cash = initialCapital;
  const units = Object.fromEntries(symbols.map(symbol => [symbol, 0]));
  const lastPrices: Record<string, number> = {};
  const applied = new Set<string>();
  const firstPrices: Record<string, number> = {};
  const points = timeline.map(timestamp => {
    const at = new Date(timestamp);
    for (const [symbol, bars] of Object.entries(barsBySymbol)) {
      const bar = bars.find(item => item.timestamp.toISOString() === timestamp);
      if (bar) {
        lastPrices[symbol] = bar.close;
        firstPrices[symbol] ??= bar.close;
      }
    }
    for (const fill of fills) {
      if (applied.has(fill.id) || fill.filledAt.getTime() > at.getTime()) continue;
      cash += fill.side === "sell" ? fill.notional : -fill.notional;
      units[fill.symbol] = (units[fill.symbol] ?? 0) + (fill.side === "sell" ? -fill.qty : fill.qty);
      applied.add(fill.id);
      lastPrices[fill.symbol] ??= fill.price;
      firstPrices[fill.symbol] ??= fill.price;
    }
    const holdingsValue = Object.entries(units).reduce((sum, [symbol, qty]) => sum + qty * (lastPrices[symbol] ?? 0), 0);
    const equity = cash + holdingsValue;
    return { timestamp, equity, cash, holdingsValue, pnl: equity - initialCapital, returnPercent: percent(equity - initialCapital, initialCapital) };
  });
  const current = points.at(-1)!;
  const primarySymbol = symbols[0]!;
  const primaryStart = firstPrices[primarySymbol] ?? null;
  const primaryEnd = lastPrices[primarySymbol] ?? null;
  const buyAndHoldEquity = primaryStart && primaryEnd ? initialCapital * primaryEnd / primaryStart : null;
  const baselineSymbols = symbols.filter(symbol => firstPrices[symbol] && lastPrices[symbol]);
  const equalWeightEquity = baselineSymbols.length ? baselineSymbols.reduce((sum, symbol) => sum + initialCapital / baselineSymbols.length * (lastPrices[symbol]! / firstPrices[symbol]!), 0) : null;
  if (!primaryStart || !primaryEnd) warnings.push("Buy-and-hold baseline needs start and end prices for the primary symbol.");
  if (!baselineSymbols.length) warnings.push("Equal-weight baseline needs start and end prices for at least one symbol.");

  return {
    performanceVersion: "strategy-performance-v1",
    generatedAt,
    run: { id: input.run.id, strategyId: input.run.strategyId, strategyVersion: input.run.strategyVersion, status: input.run.status, symbols: input.run.symbols },
    summary: {
      status: "available",
      initialCapital,
      currentEquity: current.equity,
      totalPnl: current.pnl,
      totalReturnPercent: current.returnPercent,
      maxDrawdownPercent: maxDrawdownPercent(points.map(point => point.equity)),
      filledOrders: fills.length,
      firstFillAt: firstFillAt.toISOString(),
      lastMarkAt: current.timestamp,
    },
    baselines: {
      cash: { equity: initialCapital, returnPercent: 0, activeReturnPercent: current.returnPercent },
      buyAndHold: buyAndHoldEquity === null ? null : { symbol: primarySymbol, equity: buyAndHoldEquity, returnPercent: percent(buyAndHoldEquity - initialCapital, initialCapital), activeReturnPercent: current.returnPercent! - percent(buyAndHoldEquity - initialCapital, initialCapital)! },
      equalWeight: equalWeightEquity === null ? null : { symbols: baselineSymbols, equity: equalWeightEquity, returnPercent: percent(equalWeightEquity - initialCapital, initialCapital), activeReturnPercent: current.returnPercent! - percent(equalWeightEquity - initialCapital, initialCapital)! },
    },
    points,
    warnings,
  };
}
