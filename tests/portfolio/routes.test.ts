import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { handlePortfolioRequest } from "../../backend/features/portfolio/routes";
import { createStore } from "../../backend/persistence/store";

const route = async (
  path: string,
  envOrInit: Record<string, string | undefined> | RequestInit = {},
) => {
  const isRequestInit =
    "method" in envOrInit || "body" in envOrInit || "headers" in envOrInit;
  const request = new Request(
    `http://localhost${path}`,
    isRequestInit ? (envOrInit as RequestInit) : undefined,
  );
  return handlePortfolioRequest(request, new URL(request.url), {
    alpaca: {} as Alpaca,
    store: createStore(":memory:"),
    actor: "test-operator",
    allow: () => true,
    syncAccountActivities: async () => ({ imported: 0, truncated: false }),
    currentPortfolioExposure: async () => {
      throw new Error("unexpected exposure request");
    },
    capturePortfolioSnapshot: async () => {
      throw new Error("unexpected snapshot capture");
    },
    env: isRequestInit ? {} : (envOrInit as Record<string, string | undefined>),
  });
};

test("portfolio routes reject invalid inputs before broker calls", async () => {
  expect(await route("/api/research/metrics")).toBeNull();
  expect(
    (await route("/api/account/activities?category=invalid"))?.status,
  ).toBe(400);
  expect((await route("/api/portfolio/snapshots?limit=367"))?.status).toBe(400);
  expect((await route("/api/portfolio/performance?period=2Y"))?.status).toBe(
    400,
  );
  expect(
    (
      await route("/api/portfolio/performance?period=1M", {
        PORTFOLIO_BENCHMARK: "not-a-symbol",
      })
    )?.status,
  ).toBe(500);

  const optimizer = await route("/api/portfolio/optimizer?minObservations=9");
  expect(optimizer?.status).toBe(400);

  const scenarios = await route("/api/portfolio/scenarios", {
    method: "POST",
    body: JSON.stringify({ custom: { name: "", shocks: [] } }),
  });
  expect(scenarios?.status).toBe(400);

  const rebalance = await route("/api/portfolio/rebalance-plan", {
    method: "POST",
    body: JSON.stringify({ targets: [] }),
  });
  expect(rebalance?.status).toBe(400);
});
