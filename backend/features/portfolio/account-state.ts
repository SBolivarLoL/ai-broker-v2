import type { trading } from "@alpacahq/alpaca-ts-alpha";
import { managedOrderDto } from "../orders/order-management";
import { providerTimeFields } from "../../shared/time-provenance";

type BrokerAccountState = {
  equity?: unknown;
  cash?: unknown;
  buyingPower?: unknown;
  currency?: unknown;
  status?: unknown;
};

type BrokerPositionState = {
  symbol: unknown;
  qty: unknown;
  avgEntryPrice: unknown;
  currentPrice: unknown;
  marketValue: unknown;
  unrealizedPl: unknown;
  unrealizedPlpc: unknown;
};

type AccountStateInput = {
  account: BrokerAccountState;
  positions: BrokerPositionState[];
  orders: trading.Order[];
  retrievedAt: string | Date | number;
  serverRespondedAt: string | Date | number;
};

/** Normalizes one coherent broker account read with explicit time semantics. */
export function accountStateDto({
  account,
  positions,
  orders,
  retrievedAt,
  serverRespondedAt,
}: AccountStateInput) {
  const unavailableProviderObservation = {
    observationTime: null,
    publicationTime: null,
    effectivePeriod: null,
    retrievalTime: retrievedAt,
    serverResponseTime: serverRespondedAt,
  } as const;
  const stateTime = providerTimeFields(unavailableProviderObservation);
  return {
    account: {
      equity: account.equity,
      cash: account.cash,
      buyingPower: account.buyingPower,
      currency: account.currency,
      status: account.status,
      ...stateTime,
    },
    positions: positions.map((position) => ({
      symbol: position.symbol,
      qty: position.qty,
      avgEntryPrice: position.avgEntryPrice,
      currentPrice: position.currentPrice,
      marketValue: position.marketValue,
      unrealizedPl: position.unrealizedPl,
      unrealizedPlpc: position.unrealizedPlpc,
      ...stateTime,
    })),
    orders: orders.map((order) =>
      managedOrderDto(order, retrievedAt, serverRespondedAt),
    ),
    ...stateTime,
  };
}
