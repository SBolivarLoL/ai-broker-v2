import { expect, test } from "bun:test";
import { accountStateDto } from "../../backend/features/portfolio/account-state";

test("account state preserves explicit times across account positions and orders", () => {
  const result = accountStateDto({
    account: {
      equity: "1000",
      cash: "500",
      buyingPower: "750",
      currency: "USD",
      status: "ACTIVE",
    },
    positions: [
      {
        symbol: "AAPL",
        qty: "2",
        avgEntryPrice: "190",
        currentPrice: "200",
        marketValue: "400",
        unrealizedPl: "20",
        unrealizedPlpc: "0.0526",
      },
    ],
    orders: [
      {
        id: "order-1",
        symbol: "AAPL",
        side: "buy",
        qty: "1",
        filledQty: "0",
        notional: null,
        type: "limit",
        timeInForce: "day",
        status: "new",
        updatedAt: new Date("2026-07-11T09:59:59Z"),
      } as any,
    ],
    retrievedAt: new Date("2026-07-11T10:00:00Z"),
    serverRespondedAt: new Date("2026-07-11T10:00:01Z"),
  });

  expect(result).toMatchObject({
    observedAt: null,
    retrievedAt: "2026-07-11T10:00:00.000Z",
    serverRespondedAt: "2026-07-11T10:00:01.000Z",
    account: {
      equity: "1000",
      observedAt: null,
      retrievedAt: "2026-07-11T10:00:00.000Z",
    },
    positions: [
      {
        symbol: "AAPL",
        observedAt: null,
        retrievedAt: "2026-07-11T10:00:00.000Z",
      },
    ],
    orders: [
      {
        id: "order-1",
        observedAt: "2026-07-11T09:59:59.000Z",
        retrievedAt: "2026-07-11T10:00:00.000Z",
      },
    ],
  });
});
