import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createOrderRoutes } from "../../backend/features/orders/routes";
import { createOrderRuntime } from "../../backend/features/orders/runtime";
import { createStore } from "../../backend/persistence/store";

function routes(allow = () => true, alpaca = {} as Alpaca) {
  const store = createStore(":memory:");
  return createOrderRoutes({
    alpaca,
    store,
    runtime: createOrderRuntime(alpaca, store),
    allow,
    previewSecret: "p".repeat(32),
    getMarketClock: async () => ({}),
  });
}

test("order routes reject invalid requests before broker calls", async () => {
  const handle = routes();
  const unrelated = new Request("http://localhost/api/research/metrics");
  expect(await handle(unrelated, new URL(unrelated.url), "test")).toBeNull();

  for (const path of [
    "/api/options/chain?symbol=not-a-symbol",
    "/api/orders?status=invalid",
    "/api/decision-audit?limit=0",
  ]) {
    const request = new Request(`http://localhost${path}`);
    expect((await handle(request, new URL(request.url), "test"))?.status).toBe(
      400,
    );
  }

  const receipt = new Request("http://localhost/api/receipts/missing");
  expect((await handle(receipt, new URL(receipt.url), "test"))?.status).toBe(
    404,
  );
});

test("order routes enforce mutation limits before broker calls", async () => {
  const handle = routes(() => false);
  for (const [path, method] of [
    ["/api/orders", "DELETE"],
    ["/api/orders/preview", "POST"],
    ["/api/orders/basket/preview", "POST"],
    ["/api/options/orders/preview", "POST"],
  ]) {
    const request = new Request(`http://localhost${path}`, { method });
    expect((await handle(request, new URL(request.url), "test"))?.status).toBe(
      429,
    );
  }
});

test("option chain route preserves cached retrieval time separately from response time", async () => {
  let chainCalls = 0;
  const alpaca = {
    trading: {
      account: {
        getAccount: async () => ({
          optionsApprovedLevel: 3,
          optionsTradingLevel: 3,
          optionsBuyingPower: "5000",
        }),
      },
      assets: {
        getOptionsContracts: async () => ({
          optionContracts: [
            {
              symbol: "AAPL260717C00300000",
              type: "call",
              expirationDate: new Date("2026-07-17"),
              strikePrice: "300",
              multiplier: "100",
              tradable: true,
              openInterest: "120",
            },
          ],
        }),
      },
    },
    marketData: {
      getLatestPrice: async () => 299,
      options: {
        optionChain: async () => {
          chainCalls++;
          return {
            snapshots: {
              AAPL260717C00300000: {
                latestQuote: {
                  bp: 4,
                  ap: 6,
                  t: "2026-06-22T14:30:00Z",
                },
                dailyBar: { v: 50 },
                impliedVolatility: 0.25,
              },
            },
          };
        },
      },
    },
  } as unknown as Alpaca;
  const handle = routes(() => true, alpaca);
  const request = new Request("http://localhost/api/options/chain?symbol=AAPL");
  const first = await handle(request, new URL(request.url), "test");
  const firstBody = await first?.json();
  await Bun.sleep(5);
  const second = await handle(request, new URL(request.url), "test");
  const secondBody = await second?.json();

  expect(firstBody.contracts[0]).toMatchObject({
    symbol: "AAPL260717C00300000",
    observedAt: "2026-06-22T14:30:00.000Z",
  });
  expect(secondBody.retrievedAt).toBe(firstBody.retrievedAt);
  expect(secondBody.contracts[0].retrievedAt).toBe(firstBody.retrievedAt);
  expect(secondBody.time.retrievalTime).toBe(firstBody.retrievedAt);
  expect(new Date(secondBody.serverRespondedAt).getTime()).toBeGreaterThan(
    new Date(firstBody.serverRespondedAt).getTime(),
  );
  expect(secondBody.asOf).toBe(secondBody.serverRespondedAt);
  expect(chainCalls).toBe(1);
});
