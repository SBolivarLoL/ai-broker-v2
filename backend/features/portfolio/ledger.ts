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
  groupId?: string;
  cusip?: string;
  [key: string]: unknown;
};

export type CorporateActionDetails = {
  groupId: string | null;
  cusip: string | null;
  oldCusip: string | null;
  newCusip: string | null;
  oldSymbol: string | null;
  newSymbol: string | null;
  oldQuantity: number | null;
  newQuantity: number | null;
  oldRate: number | null;
  newRate: number | null;
  basisAllocations: CorporateActionBasisAllocation[];
};

export type CorporateActionBasisAllocation = {
  symbol: string;
  quantity: number;
  totalCostBasis: number;
  acquiredAt: string | null;
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
  corporateAction?: CorporateActionDetails | null;
};

export type FifoLot = { symbol: string; quantity: number; price: number; acquiredAt: string };

const activityCategoryByType: Record<string, LedgerCategory> = {
  FILL: "trade",
  CGD: "dividend", DIV: "dividend", DIVCGL: "dividend", DIVCGS: "dividend", DIVFT: "dividend", DIVNRA: "dividend", DIVROC: "dividend", DIVTW: "dividend", DIVTXEX: "dividend",
  CFEE: "fee", DIVFEE: "fee", FEE: "fee", PTC: "fee",
  INT: "interest", INTNRA: "interest", INTTW: "interest",
  ACATC: "transfer", CSD: "transfer", CSW: "transfer", TRANS: "transfer", JNLC: "transfer",
  ACATS: "corporate_action", FOPT: "corporate_action", JNLS: "corporate_action", MA: "corporate_action", NC: "corporate_action", OPCA: "corporate_action", REORG: "corporate_action", SPIN: "corporate_action", SPLIT: "corporate_action",
  OPASN: "option", OPCSH: "option", OPEXC: "option", OPEXP: "option", OPTRD: "option",
};

export function activityCategory(type: string): LedgerCategory {
  return activityCategoryByType[type] ?? "other";
}

const optionalNumber = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Activity contains a non-finite number");
  return parsed;
};

const optionalString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const field = (activity: BrokerActivity, camel: string, snake: string) => activity[camel] ?? activity[snake];

function basisAllocations(activity: BrokerActivity): CorporateActionBasisAllocation[] {
  const raw = activity.basisAllocations ?? activity.basis_allocations;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("Corporate-action basis allocations must be an array");
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Corporate-action basis allocation ${index + 1} is invalid`);
    const record = entry as Record<string, unknown>;
    const symbol = optionalString(record.symbol);
    const quantity = optionalNumber(record.quantity ?? record.qty);
    const totalCostBasis = optionalNumber(record.totalCostBasis ?? record.costBasis ?? record.total_cost_basis ?? record.cost_basis);
    const acquiredAt = optionalString(record.acquiredAt ?? record.acquired_at);
    if (!symbol || quantity === null || quantity <= 0 || totalCostBasis === null || totalCostBasis < 0) throw new Error(`Corporate-action basis allocation ${index + 1} is incomplete`);
    return { symbol, quantity, totalCostBasis, acquiredAt };
  });
}

function corporateActionDetails(activity: BrokerActivity): CorporateActionDetails {
  return {
    groupId: optionalString(activity.groupId ?? activity.group_id),
    cusip: optionalString(activity.cusip),
    oldCusip: optionalString(field(activity, "oldCusip", "old_cusip")),
    newCusip: optionalString(field(activity, "newCusip", "new_cusip")),
    oldSymbol: optionalString(field(activity, "oldSymbol", "old_symbol")),
    newSymbol: optionalString(field(activity, "newSymbol", "new_symbol")),
    oldQuantity: optionalNumber(field(activity, "oldQty", "old_qty")),
    newQuantity: optionalNumber(field(activity, "newQty", "new_qty")),
    oldRate: optionalNumber(field(activity, "oldRate", "old_rate")),
    newRate: optionalNumber(field(activity, "newRate", "new_rate")),
    basisAllocations: basisAllocations(activity),
  };
}

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
  const category = activityCategory(type);
  return {
    id: activity.id,
    type,
    subType: activity.activitySubType ?? null,
    category,
    status: activity.status ?? "executed",
    occurredAt: date.toISOString(),
    symbol: activity.symbol ?? null,
    side,
    quantity,
    price,
    amount,
    orderId: activity.orderId ?? null,
    corporateAction: category === "corporate_action" ? corporateActionDetails(activity) : null,
  };
}

export function ledgerSummary(activities: LedgerActivity[], truncated = false) {
  const executed = activities.filter(activity => activity.status !== "canceled");
  const lots = new Map<string, Omit<FifoLot, "symbol">[]>();
  let realizedProfitLoss = 0, realizedProceeds = 0, realizedCostBasis = 0, unmatchedSellQuantity = 0;
  let corporateActionsApplied = 0;
  let tradeCount = 0, dividends = 0, interest = 0, fees = 0, netTransfers = 0, totalCashImpact = 0;
  const unresolvedCorporateActions: { id: string; type: string; subType: string | null; symbol: string | null; reason: string }[] = [];
  for (const activity of [...executed].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))) {
    totalCashImpact += activity.amount;
    if (activity.category === "trade") tradeCount++;
    if (activity.category === "dividend") dividends += activity.amount;
    if (activity.category === "interest") interest += activity.amount;
    if (activity.category === "fee") fees += activity.amount;
    if (activity.category === "transfer") netTransfers += activity.amount;
    if (activity.category === "corporate_action") {
      const details = activity.corporateAction;
      const oldSymbol = details?.oldSymbol ?? activity.symbol;
      const newSymbol = details?.newSymbol ?? activity.symbol;
      if (details?.basisAllocations.length) {
        if (!oldSymbol) {
          unresolvedCorporateActions.push({ id: activity.id, type: activity.type, subType: activity.subType, symbol: activity.symbol, reason: "Broker basis allocation is missing the source security symbol." });
          continue;
        }
        const sourceLots = lots.get(oldSymbol) ?? [];
        if (!sourceLots.length) {
          unresolvedCorporateActions.push({ id: activity.id, type: activity.type, subType: activity.subType, symbol: activity.symbol, reason: "Broker basis allocation has no imported source FIFO lots to replace." });
          continue;
        }
        lots.delete(oldSymbol);
        for (const allocation of details.basisAllocations) {
          const targetLots = lots.get(allocation.symbol) ?? [];
          targetLots.push({
            quantity: allocation.quantity,
            price: allocation.totalCostBasis / allocation.quantity,
            acquiredAt: allocation.acquiredAt ?? activity.occurredAt,
          });
          lots.set(allocation.symbol, targetLots);
        }
        corporateActionsApplied++;
        continue;
      }
      if (activity.type === "SPLIT" && ["FSPLIT", "RSPLIT"].includes(activity.subType ?? "")) {
        const oldValue = details?.oldRate ?? details?.oldQuantity;
        const newValue = details?.newRate ?? details?.newQuantity;
        const ratio = oldValue && newValue ? newValue / oldValue : NaN;
        if (!oldSymbol || !newSymbol || !Number.isFinite(ratio) || ratio <= 0) {
          unresolvedCorporateActions.push({ id: activity.id, type: activity.type, subType: activity.subType, symbol: activity.symbol, reason: "Missing a positive split ratio or security symbol." });
          continue;
        }
        const adjustedLots = lots.get(oldSymbol) ?? [];
        for (const lot of adjustedLots) {
          lot.quantity *= ratio;
          lot.price /= ratio;
        }
        if (newSymbol !== oldSymbol) {
          const targetLots = lots.get(newSymbol) ?? [];
          targetLots.push(...adjustedLots);
          lots.set(newSymbol, targetLots);
          lots.delete(oldSymbol);
        }
        corporateActionsApplied++;
        continue;
      }
      if (activity.type === "NC" && details?.oldSymbol && details.newSymbol) {
        const renamedLots = lots.get(details.oldSymbol) ?? [];
        const targetLots = lots.get(details.newSymbol) ?? [];
        targetLots.push(...renamedLots);
        lots.set(details.newSymbol, targetLots);
        lots.delete(details.oldSymbol);
        corporateActionsApplied++;
        continue;
      }
      unresolvedCorporateActions.push({ id: activity.id, type: activity.type, subType: activity.subType, symbol: activity.symbol, reason: "This action needs broker-provided basis allocation details or manual review." });
      continue;
    }
    if (activity.category !== "trade" || !activity.symbol || !activity.side || activity.quantity === null || activity.price === null) continue;
    const symbolLots = lots.get(activity.symbol) ?? [];
    lots.set(activity.symbol, symbolLots);
    if (activity.side === "buy") {
      symbolLots.push({ quantity: activity.quantity, price: activity.price, acquiredAt: activity.occurredAt });
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
  const warnings: string[] = [];
  if (truncated) warnings.push("Only the most recent broker activities were imported; lifetime totals may be incomplete.");
  if (unmatchedSellQuantity > 1e-10) warnings.push("Some sales predate the imported purchase history; realized P&L excludes their unmatched quantity.");
  if (corporateActionsApplied) warnings.push(`${corporateActionsApplied} corporate action${corporateActionsApplied === 1 ? " was" : "s were"} applied to open FIFO lots while preserving total cost basis.`);
  if (unresolvedCorporateActions.length) warnings.push(`${unresolvedCorporateActions.length} corporate action${unresolvedCorporateActions.length === 1 ? " requires" : "s require"} manual cost-basis review before relying on realized P&L.`);
  const openLots = [...lots.entries()].flatMap(([symbol, symbolLots]) => symbolLots.map(lot => ({ symbol, ...lot }))).filter(lot => lot.quantity > 1e-10).sort((left, right) => left.symbol.localeCompare(right.symbol) || left.acquiredAt.localeCompare(right.acquiredAt));
  return {
    activityCount: executed.length,
    tradeCount,
    realizedProfitLoss,
    realizedProceeds,
    realizedCostBasis,
    dividends,
    interest,
    feesPaid: Math.max(0, -fees),
    netTransfers,
    totalCashImpact,
    corporateActionsApplied,
    unresolvedCorporateActions,
    openLots,
    unmatchedSellQuantity,
    activityHistoryTruncated: truncated,
    warnings,
    method: "FIFO from imported Alpaca fills with explicit split and symbol-change adjustments; informational, not tax reporting",
  };
}
