import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createOrderRoutes } from "../../backend/features/orders/routes";
import { createOrderRuntime } from "../../backend/features/orders/runtime";
import { createStore } from "../../backend/persistence/store";

function routes(allow = () => true) {
  const alpaca = {} as Alpaca;
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
