import { z } from "zod";
import type { FifoLot } from "./ledger";

const Target = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z.]{1,10}$/),
  targetWeightPercent: z.coerce.number().finite().min(0).max(100),
});

const optionalCap = z.preprocess(value => value === "" || value === null || value === undefined ? null : value, z.coerce.number().finite().nonnegative().nullable()).default(null);

export const ConstrainedRebalancePlanRequest = z.object({
  targets: z.array(Target).min(1).max(10),
  maxTurnoverPercent: z.coerce.number().finite().min(0).max(100).default(10),
  feeBps: z.coerce.number().finite().min(0).max(1_000).default(0),
  shortTermTaxRatePercent: z.coerce.number().finite().min(0).max(100).default(0),
  longTermTaxRatePercent: z.coerce.number().finite().min(0).max(100).default(0),
  maxEstimatedTax: optionalCap,
  cashBufferPercent: z.coerce.number().finite().min(0).max(100).default(5),
  minTradeNotional: z.coerce.number().finite().min(0).max(100_000).default(25),
}).superRefine((request, context) => {
  const symbols = request.targets.map(target => target.symbol);
  if (new Set(symbols).size !== symbols.length) context.addIssue({ code: "custom", message: "A rebalance plan may contain only one target per symbol" });
  if (request.targets.reduce((sum, target) => sum + target.targetWeightPercent, 0) > 100 + 1e-9) context.addIssue({ code: "custom", message: "Target weights cannot exceed 100%" });
});

export type ConstrainedRebalancePlanRequest = z.infer<typeof ConstrainedRebalancePlanRequest>;

export type RebalancePlannerPosition = {
  symbol: string;
  qty: number;
  marketValue: number;
  price?: number;
  fractionable?: boolean;
};

export type RebalancePlannerMarket = {
  symbol: string;
  price: number;
  fractionable: boolean;
};

type Leg = { symbol: string; side: "buy" | "sell"; quantity: number; price: number; plannedNotional: number };
type PositionState = { symbol: string; qty: number; currentValue: number; price: number; fractionable: boolean };

const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const floorQuantity = (quantity: number, fractionable: boolean) => fractionable ? Math.floor(quantity * 1_000_000) / 1_000_000 : Math.floor(quantity);
const formatQuantity = (quantity: number) => quantity.toFixed(6).replace(/\.?0+$/, "");

function assertFinitePositive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function longTerm(acquiredAt: string, soldAt: Date) {
  const acquired = new Date(acquiredAt);
  if (!Number.isFinite(acquired.getTime())) return null;
  const anniversary = new Date(acquired);
  anniversary.setFullYear(anniversary.getFullYear() + 1);
  return soldAt.getTime() > anniversary.getTime();
}

function estimateFifoTax(input: {
  legs: Leg[];
  lots: FifoLot[];
  soldAt: Date;
  shortTermRate: number;
  longTermRate: number;
}) {
  const lots = new Map<string, FifoLot[]>(input.lots.map(lot => ({ ...lot })).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.acquiredAt.localeCompare(b.acquiredAt)).reduce<[string, FifoLot[]][]>((entries, lot) => {
    const entry = entries.find(([symbol]) => symbol === lot.symbol);
    if (entry) entry[1].push(lot);
    else entries.push([lot.symbol, [lot]]);
    return entries;
  }, []));
  let realizedGainLoss = 0, taxableShortTermGain = 0, taxableLongTermGain = 0, estimatedTax = 0, coveredQuantity = 0, uncoveredQuantity = 0;
  for (const leg of input.legs.filter(leg => leg.side === "sell")) {
    let remaining = leg.quantity;
    const symbolLots = lots.get(leg.symbol) ?? [];
    while (remaining > 1e-8 && symbolLots.length) {
      const lot = symbolLots[0]!;
      const matched = Math.min(remaining, lot.quantity);
      const gain = matched * (leg.price - lot.price);
      const isLongTerm = longTerm(lot.acquiredAt, input.soldAt);
      realizedGainLoss += gain;
      coveredQuantity += matched;
      if (gain > 0 && isLongTerm !== null) {
        if (isLongTerm) {
          taxableLongTermGain += gain;
          estimatedTax += gain * input.longTermRate;
        } else {
          taxableShortTermGain += gain;
          estimatedTax += gain * input.shortTermRate;
        }
      }
      if (isLongTerm === null) uncoveredQuantity += matched;
      remaining -= matched;
      lot.quantity -= matched;
      if (lot.quantity <= 1e-8) symbolLots.shift();
    }
    uncoveredQuantity += Math.max(0, remaining);
  }
  return {
    realizedGainLoss: round(realizedGainLoss, 2),
    taxableShortTermGain: round(taxableShortTermGain, 2),
    taxableLongTermGain: round(taxableLongTermGain, 2),
    estimatedTax: round(estimatedTax, 2),
    coveredQuantity: round(coveredQuantity, 6),
    uncoveredQuantity: round(uncoveredQuantity, 6),
    complete: uncoveredQuantity <= 1e-8,
  };
}

function plannedLegs(states: Map<string, PositionState>, deltas: Map<string, number>, minTradeNotional: number) {
  const legs: Leg[] = [];
  let droppedSmallLegs = 0, roundedLegs = 0;
  for (const [symbol, delta] of [...deltas.entries()].sort()) {
    const state = states.get(symbol);
    if (!state || Math.abs(delta) <= 1e-8) continue;
    const side = delta > 0 ? "buy" : "sell";
    const rawQuantity = side === "buy" ? delta / state.price : Math.min(state.qty, Math.abs(delta) / state.price);
    const quantity = floorQuantity(rawQuantity, state.fractionable);
    if (quantity <= 0) {
      if (Math.abs(delta) > 0) roundedLegs++;
      continue;
    }
    const plannedNotional = quantity * state.price;
    if (plannedNotional + 1e-8 < minTradeNotional) {
      droppedSmallLegs++;
      continue;
    }
    if (Math.abs(quantity - rawQuantity) > 1e-8) roundedLegs++;
    legs.push({ symbol, side, quantity, price: state.price, plannedNotional: round(plannedNotional, 2) });
  }
  return { legs, droppedSmallLegs, roundedLegs };
}

export function buildConstrainedRebalancePlan(input: {
  request: unknown;
  account: { equity: number; cash: number };
  positions: RebalancePlannerPosition[];
  market: RebalancePlannerMarket[];
  openLots?: FifoLot[];
  taxLotsComplete?: boolean;
  taxEvidenceWarnings?: string[];
  currentTurnoverNotional?: number;
  policyMaxTurnoverPercent?: number;
  asOf?: string;
}) {
  const request = ConstrainedRebalancePlanRequest.parse(input.request);
  const equity = Number(input.account.equity), cash = Number(input.account.cash);
  assertFinitePositive(equity, "Account equity");
  if (!Number.isFinite(cash)) throw new Error("Account cash must be finite");
  const warnings = [
    "Tax estimates use imported FIFO lots only and exclude wash sales, loss netting, carryovers, jurisdiction-specific taxes and advisory tax treatment.",
    "Buy sizing does not assume uncertain sell proceeds are available before execution; the basket preview still revalidates fresh broker state.",
    ...(input.taxEvidenceWarnings ?? []),
  ];
  const market = new Map(input.market.map(item => {
    assertFinitePositive(item.price, `${item.symbol} price`);
    return [item.symbol.toUpperCase(), { ...item, symbol: item.symbol.toUpperCase() }] as const;
  }));
  const states = new Map<string, PositionState>();
  for (const position of input.positions) {
    const symbol = position.symbol.toUpperCase();
    const qty = Number(position.qty), currentValue = Number(position.marketValue);
    if (!Number.isFinite(qty) || !Number.isFinite(currentValue) || qty < -1e-8 || currentValue < -1e-8) throw new Error("Current short positions are not supported by the constrained rebalance planner");
    const price = market.get(symbol)?.price ?? position.price ?? (qty > 0 ? currentValue / qty : NaN);
    if (qty > 0 || currentValue > 0) assertFinitePositive(price, `${symbol} price`);
    states.set(symbol, { symbol, qty, currentValue, price: Number.isFinite(price) && price > 0 ? price : market.get(symbol)?.price ?? 1, fractionable: market.get(symbol)?.fractionable ?? position.fractionable ?? true });
  }
  for (const target of request.targets) {
    const quote = market.get(target.symbol);
    if (!states.has(target.symbol)) {
      if (!quote) throw new Error(`${target.symbol} needs a current price`);
      states.set(target.symbol, { symbol: target.symbol, qty: 0, currentValue: 0, price: quote.price, fractionable: quote.fractionable });
    } else if (quote) {
      states.set(target.symbol, { ...states.get(target.symbol)!, price: quote.price, fractionable: quote.fractionable });
    }
  }

  const targetMap = new Map(request.targets.map(target => [target.symbol, target.targetWeightPercent]));
  const rawDeltas = new Map<string, number>();
  for (const [symbol, state] of states) {
    if (!targetMap.has(symbol)) continue;
    rawDeltas.set(symbol, equity * targetMap.get(symbol)! / 100 - state.currentValue);
  }
  const rawTurnoverNotional = [...rawDeltas.values()].reduce((sum, delta) => sum + Math.abs(delta), 0);
  const turnoverLimitPercent = Math.min(request.maxTurnoverPercent, input.policyMaxTurnoverPercent ?? request.maxTurnoverPercent);
  const currentTurnoverNotional = Math.max(0, input.currentTurnoverNotional ?? 0);
  const remainingTurnoverNotional = Math.max(0, equity * turnoverLimitPercent / 100 - currentTurnoverNotional);
  const turnoverScale = rawTurnoverNotional ? Math.min(1, remainingTurnoverNotional / rawTurnoverNotional) : 1;
  const turnoverDeltas = new Map([...rawDeltas].map(([symbol, delta]) => [symbol, delta * turnoverScale]));

  const soldAt = new Date(input.asOf ?? new Date().toISOString());
  const taxInput = { soldAt, shortTermRate: request.shortTermTaxRatePercent / 100, longTermRate: request.longTermTaxRatePercent / 100, lots: input.openLots ?? [] };
  const taxCoverageGloballyComplete = input.taxLotsComplete ?? true;
  const estimateAtScale = (scale: number) => estimateFifoTax({ ...taxInput, legs: plannedLegs(states, new Map([...turnoverDeltas].map(([symbol, delta]) => [symbol, delta * scale])), request.minTradeNotional).legs });
  const unrestrictedTax = estimateAtScale(1);
  const hasSellLegs = plannedLegs(states, turnoverDeltas, request.minTradeNotional).legs.some(leg => leg.side === "sell");
  let taxScale = 1;
  let taxEvidenceStatus: "complete" | "incomplete" | "not_needed" = hasSellLegs ? "complete" : "not_needed";
  if (hasSellLegs && (!taxCoverageGloballyComplete || !unrestrictedTax.complete)) taxEvidenceStatus = "incomplete";
  if (request.maxEstimatedTax !== null && taxEvidenceStatus === "complete" && unrestrictedTax.estimatedTax > request.maxEstimatedTax) {
    let low = 0, high = 1;
    for (let index = 0; index < 40; index++) {
      const middle = (low + high) / 2;
      if (estimateAtScale(middle).estimatedTax <= request.maxEstimatedTax + 0.005) low = middle;
      else high = middle;
    }
    taxScale = low;
  }
  const taxDeltas = new Map([...turnoverDeltas].map(([symbol, delta]) => [symbol, delta * taxScale]));
  const beforeCash = plannedLegs(states, taxDeltas, request.minTradeNotional);
  const feeRate = request.feeBps / 10_000;
  const sellNotionalBeforeCash = beforeCash.legs.filter(leg => leg.side === "sell").reduce((sum, leg) => sum + leg.plannedNotional, 0);
  const buyNotionalBeforeCash = beforeCash.legs.filter(leg => leg.side === "buy").reduce((sum, leg) => sum + leg.plannedNotional, 0);
  const cashBuffer = equity * request.cashBufferPercent / 100;
  const availableBuyCash = Math.max(0, cash - cashBuffer - sellNotionalBeforeCash * feeRate);
  const buyScale = buyNotionalBeforeCash ? Math.min(1, availableBuyCash / (buyNotionalBeforeCash * (1 + feeRate))) : 1;
  const finalDeltas = new Map([...taxDeltas].map(([symbol, delta]) => [symbol, delta > 0 ? delta * buyScale : delta]));
  const planned = plannedLegs(states, finalDeltas, request.minTradeNotional);
  const legs = planned.legs;
  const buyNotional = legs.filter(leg => leg.side === "buy").reduce((sum, leg) => sum + leg.plannedNotional, 0);
  const sellNotional = legs.filter(leg => leg.side === "sell").reduce((sum, leg) => sum + leg.plannedNotional, 0);
  const plannedTurnoverNotional = buyNotional + sellNotional;
  const feeEstimate = round(plannedTurnoverNotional * feeRate, 2);
  const tax = estimateFifoTax({ ...taxInput, legs });
  const resultingCash = round(cash + sellNotional - buyNotional - feeEstimate, 2);
  const turnoverAfterPercent = round((currentTurnoverNotional + plannedTurnoverNotional) / equity * 100);
  const bindingConstraints = [
    ...(turnoverScale < 0.999999 ? ["turnover_budget"] : []),
    ...(input.policyMaxTurnoverPercent !== undefined && input.policyMaxTurnoverPercent < request.maxTurnoverPercent ? ["operations_turnover_policy"] : []),
    ...(taxScale < 0.999999 ? ["tax_cap"] : []),
    ...(buyScale < 0.999999 ? ["cash_buffer"] : []),
    ...(planned.droppedSmallLegs + beforeCash.droppedSmallLegs ? ["minimum_trade_notional"] : []),
    ...(planned.roundedLegs ? ["quantity_rounding"] : []),
  ];
  if (planned.droppedSmallLegs) warnings.push(`${planned.droppedSmallLegs} planned leg${planned.droppedSmallLegs === 1 ? " was" : "s were"} below the minimum notional and omitted.`);
  if (taxEvidenceStatus === "incomplete") warnings.push("FIFO lot coverage is incomplete for at least one planned sale; an explicit tax cap cannot be verified.");

  const plannedDeltaBySymbol = new Map<string, number>();
  for (const leg of legs) plannedDeltaBySymbol.set(leg.symbol, (plannedDeltaBySymbol.get(leg.symbol) ?? 0) + (leg.side === "buy" ? 1 : -1) * leg.plannedNotional);
  const positions = [...states.values()].map(state => {
    const plannedDelta = plannedDeltaBySymbol.get(state.symbol) ?? 0;
    return {
      symbol: state.symbol,
      currentValue: round(state.currentValue, 2),
      currentWeightPercent: round(state.currentValue / equity * 100),
      targetWeightPercent: targetMap.get(state.symbol) ?? null,
      plannedDelta: round(plannedDelta, 2),
      resultingValue: round(state.currentValue + plannedDelta, 2),
      resultingWeightPercent: round((state.currentValue + plannedDelta) / equity * 100),
    };
  }).sort((left, right) => Math.abs(right.plannedDelta) - Math.abs(left.plannedDelta) || left.symbol.localeCompare(right.symbol));

  const taxCapVerified = request.maxEstimatedTax === null || taxEvidenceStatus !== "incomplete";
  const withinConstraints = taxCapVerified
    && (request.maxEstimatedTax === null || tax.estimatedTax <= request.maxEstimatedTax + 0.01)
    && turnoverAfterPercent <= turnoverLimitPercent + 1e-6
    && resultingCash + 0.01 >= cashBuffer;
  const basketDraft = withinConstraints && legs.length >= 2 && legs.length <= 10
    ? legs.map(leg => `${leg.symbol} ${leg.side} ${formatQuantity(leg.quantity)}`).join("\n")
    : null;
  if (withinConstraints && legs.length > 0 && !basketDraft) warnings.push("The plan has fewer than two executable legs, so it cannot be loaded as a rebalance basket.");

  return {
    asOf: input.asOf ?? new Date().toISOString(),
    withinConstraints,
    basketDraft,
    summary: {
      equity: round(equity, 2),
      startingCash: round(cash, 2),
      cashBuffer: round(cashBuffer, 2),
      resultingCash,
      rawTurnoverNotional: round(rawTurnoverNotional, 2),
      currentTurnoverNotional: round(currentTurnoverNotional, 2),
      remainingTurnoverNotional: round(remainingTurnoverNotional, 2),
      plannedTurnoverNotional: round(plannedTurnoverNotional, 2),
      turnoverLimitPercent: round(turnoverLimitPercent),
      turnoverAfterPercent,
      buyNotional: round(buyNotional, 2),
      sellNotional: round(sellNotional, 2),
      feeEstimate,
      estimatedTax: tax.estimatedTax,
    },
    scales: { turnoverScale: round(turnoverScale, 6), taxScale: round(taxScale, 6), buyScale: round(buyScale, 6) },
    bindingConstraints: [...new Set(bindingConstraints)],
    tax: { ...tax, evidenceStatus: taxEvidenceStatus, maxEstimatedTax: request.maxEstimatedTax },
    legs,
    positions,
    warnings,
    methodology: [
      "Targets are percent-of-equity values; omitted existing positions are left unchanged and zero-weight targets are reduced toward zero.",
      "Turnover is bounded by the stricter user and operations-policy limits after current rolling 24-hour filled-order turnover.",
      "Tax lots are consumed FIFO from imported Alpaca fills; gains held for more than one year use the long-term rate entered by the user.",
    ],
  };
}
