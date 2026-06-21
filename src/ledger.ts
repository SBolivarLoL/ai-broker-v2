export type LedgerCategory = "trade" | "dividend" | "interest" | "fee" | "transfer" | "corporate_action" | "option" | "other";

export type BrokerActivity = {
  id?: string;
  activityType?: string;
  activitySubType?: string;
  status?: string;
  symbol?: string;
  side?: string;
  qty?: string | number;
  price?: string | number;
  netAmount?: string | number;
  perShareAmount?: string | number;
  transactionTime?: Date;
  createdAt?: Date;
  date?: Date;
  orderId?: string;
};

export type LedgerActivity = {
  id: string;
  type: string;
  subType: string | null;
  category: LedgerCategory;
  status: string;
  occurredAt: string;
  symbol: string | null;
  side: "buy" | "sell" | null;
  quantity: number | null;
  price: number | null;
  amount: number;
  orderId: string | null;
};

const dividendTypes = new Set(["CGD", "DIV", "DIVCGL", "DIVCGS", "DIVFT", "DIVNRA", "DIVROC", "DIVTW", "DIVTXEX"]);
const feeTypes = new Set(["CFEE", "DIVFEE", "FEE", "PTC"]);
const interestTypes = new Set(["INT", "INTNRA", "INTTW"]);
const transferTypes = new Set(["ACATC", "CSD", "CSW", "TRANS", "JNLC"]);
const corporateActionTypes = new Set(["ACATS", "FOPT", "JNLS", "MA", "NC", "OPCA", "REORG", "SPIN", "SPLIT"]);
const optionTypes = new Set(["OPASN", "OPCSH", "OPEXC", "OPEXP", "OPTRD"]);

export function activityCategory(type: string): LedgerCategory {
  if (type === "FILL") return "trade";
  if (dividendTypes.has(type)) return "dividend";
  if (feeTypes.has(type)) return "fee";
  if (interestTypes.has(type)) return "interest";
  if (transferTypes.has(type)) return "transfer";
  if (corporateActionTypes.has(type)) return "corporate_action";
  if (optionTypes.has(type)) return "option";
  return "other";
}

const optionalNumber = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Activity contains a non-finite number");
  return parsed;
};

export function normalizeActivity(activity: BrokerActivity): LedgerActivity {
  const type = String(activity.activityType ?? "").toUpperCase();
  const side = activity.side === "buy" || activity.side === "sell" ? activity.side : null;
  const quantity = optionalNumber(activity.qty);
  const price = optionalNumber(activity.price);
  const date = activity.transactionTime ?? activity.createdAt ?? activity.date;
  if (!activity.id || !type || !date || !Number.isFinite(date.getTime())) throw new Error("Activity is missing its broker identity, type, or timestamp");
  if (type === "FILL" && (!side || quantity === null || quantity <= 0 || price === null || price <= 0 || !activity.symbol)) throw new Error("Fill activity is incomplete");
  const netAmount = optionalNumber(activity.netAmount);
  const amount = type === "FILL" ? quantity! * price! * (side === "buy" ? -1 : 1) : (netAmount ?? 0);
  return {
    id: activity.id,
    type,
    subType: activity.activitySubType ?? null,
    category: activityCategory(type),
    status: activity.status ?? "executed",
    occurredAt: date.toISOString(),
    symbol: activity.symbol ?? null,
    side,
    quantity,
    price,
    amount,
    orderId: activity.orderId ?? null,
  };
}

export function ledgerSummary(activities: LedgerActivity[], truncated = false) {
  const executed = activities.filter(activity => activity.status !== "canceled");
  const lots = new Map<string, { quantity: number; price: number }[]>();
  let realizedProfitLoss = 0, realizedProceeds = 0, realizedCostBasis = 0, unmatchedSellQuantity = 0;
  for (const activity of [...executed].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))) {
    if (activity.category !== "trade" || !activity.symbol || !activity.side || activity.quantity === null || activity.price === null) continue;
    const symbolLots = lots.get(activity.symbol) ?? [];
    lots.set(activity.symbol, symbolLots);
    if (activity.side === "buy") {
      symbolLots.push({ quantity: activity.quantity, price: activity.price });
      continue;
    }
    let remaining = activity.quantity;
    while (remaining > 1e-10 && symbolLots.length) {
      const lot = symbolLots[0];
      const matched = Math.min(remaining, lot.quantity);
      realizedProceeds += matched * activity.price;
      realizedCostBasis += matched * lot.price;
      realizedProfitLoss += matched * (activity.price - lot.price);
      remaining -= matched;
      lot.quantity -= matched;
      if (lot.quantity <= 1e-10) symbolLots.shift();
    }
    unmatchedSellQuantity += remaining;
  }
  const sumCategory = (category: LedgerCategory) => executed.filter(activity => activity.category === category).reduce((sum, activity) => sum + activity.amount, 0);
  const hasCorporateActions = executed.some(activity => activity.category === "corporate_action");
  const warnings: string[] = [];
  if (truncated) warnings.push("Only the most recent broker activities were imported; lifetime totals may be incomplete.");
  if (unmatchedSellQuantity > 1e-10) warnings.push("Some sales predate the imported purchase history; realized P&L excludes their unmatched quantity.");
  if (hasCorporateActions) warnings.push("Corporate actions are present; FIFO fill cost basis may require adjustment before tax use.");
  return {
    activityCount: executed.length,
    tradeCount: executed.filter(activity => activity.category === "trade").length,
    realizedProfitLoss,
    realizedProceeds,
    realizedCostBasis,
    dividends: sumCategory("dividend"),
    interest: sumCategory("interest"),
    feesPaid: Math.max(0, -sumCategory("fee")),
    netTransfers: sumCategory("transfer"),
    totalCashImpact: executed.reduce((sum, activity) => sum + activity.amount, 0),
    warnings,
    method: "FIFO from imported Alpaca fills; informational, not tax reporting",
  };
}
