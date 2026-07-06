/** Builds the durable broker snapshot used for reconciliation and evidence. */
import type { RiskSnapshot } from "../../shared/risk";

type AccountInput = {
  equity?: string | number;
  cash?: string | number;
  buyingPower?: string | number;
  status?: unknown;
};
type PositionInput = {
  symbol?: string;
  qty?: string | number;
  marketValue?: string | number;
  currentPrice?: string | number;
  avgEntryPrice?: string | number;
};
type OrderSyncInput = {
  streamState?: string;
  lastEventAt?: string | null;
  lastRecoveryAt?: string | null;
  stale?: boolean;
  lastError?: string | null;
};
export type QualityFlag = {
  severity: "warning" | "error";
  code: string;
  message: string;
};

const finite = (value: unknown, label: string) => {
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(`${label} is not a finite number`);
  return number;
};

export function buildPortfolioSnapshot(
  account: AccountInput,
  positions: PositionInput[],
  risk: RiskSnapshot,
  orderSync: OrderSyncInput,
  now = new Date(),
) {
  const equity = finite(account.equity, "Equity"),
    cash = finite(account.cash, "Cash"),
    buyingPower = finite(account.buyingPower, "Buying power");
  const flags: QualityFlag[] = [];
  const seen = new Set<string>();
  const normalizedPositions = positions.map((position, index) => {
    const symbol = String(position.symbol ?? "")
      .trim()
      .toUpperCase();
    if (!symbol)
      flags.push({
        severity: "error",
        code: "missing_symbol",
        message: `Position ${index + 1} has no symbol.`,
      });
    if (seen.has(symbol))
      flags.push({
        severity: "error",
        code: "duplicate_symbol",
        message: `${symbol} appears more than once in broker positions.`,
      });
    seen.add(symbol);
    const qty = finite(position.qty, `${symbol || "Position"} quantity`),
      marketValue = finite(
        position.marketValue,
        `${symbol || "Position"} market value`,
      );
    const currentPrice = finite(
        position.currentPrice,
        `${symbol || "Position"} current price`,
      ),
      avgEntryPrice = finite(
        position.avgEntryPrice,
        `${symbol || "Position"} average entry price`,
      );
    if (qty < 0)
      flags.push({
        severity: "warning",
        code: "short_position",
        message: `${symbol} is a short position and requires margin-specific risk treatment.`,
      });
    if (currentPrice <= 0)
      flags.push({
        severity: "error",
        code: "invalid_price",
        message: `${symbol} has a non-positive current price.`,
      });
    return { symbol, qty, marketValue, currentPrice, avgEntryPrice };
  });
  const positionValue = normalizedPositions.reduce(
    (sum, position) => sum + position.marketValue,
    0,
  );
  const reconciliationGap = equity - cash - positionValue;
  const reconciliationGapPercent = equity
    ? (reconciliationGap / equity) * 100
    : 0;
  if (Math.abs(reconciliationGap) > Math.max(1, Math.abs(equity) * 0.001))
    flags.push({
      severity: "warning",
      code: "equity_reconciliation_gap",
      message: `Cash plus position value differs from equity by ${reconciliationGap.toFixed(2)}.`,
    });
  if (cash < 0)
    flags.push({
      severity: "warning",
      code: "negative_cash",
      message: "Cash is negative; margin or unsettled activity may be present.",
    });
  if (String(account.status ?? "").toUpperCase() !== "ACTIVE")
    flags.push({
      severity: "error",
      code: "account_not_active",
      message: `Broker account status is ${String(account.status ?? "unknown")}.`,
    });
  if (orderSync.stale)
    flags.push({
      severity: "warning",
      code: "order_state_stale",
      message: "Order stream and recovery snapshot are stale.",
    });
  if (orderSync.lastError)
    flags.push({
      severity: "warning",
      code: "order_stream_error",
      message: `Order stream reported: ${orderSync.lastError}`,
    });
  const status = flags.some((flag) => flag.severity === "error")
    ? "error"
    : flags.length
      ? "warning"
      : "healthy";
  return {
    snapshotDate: now.toISOString().slice(0, 10),
    capturedAt: now.toISOString(),
    equity,
    cash,
    buyingPower,
    positionValue,
    positionCount: normalizedPositions.length,
    reconciliationGap,
    reconciliationGapPercent,
    risk,
    positions: normalizedPositions,
    orderSync,
    quality: { status, flags },
    source: "alpaca-paper",
  };
}
