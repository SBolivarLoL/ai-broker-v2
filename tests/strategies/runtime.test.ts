import { expect, test } from "bun:test";
import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createStore } from "../../backend/persistence/store";
import { createStrategyRuntime } from "../../backend/features/strategies/runtime";

test("strategy runtime owns symbol normalization, config identity, and due-run evaluation", async () => {
  const store = createStore(":memory:");
  const runtime = createStrategyRuntime({} as Alpaca, store);

  expect(runtime.normalizeSymbols("moving-average-trend", "BTC/USD")).toEqual([
    "BTC/USD",
  ]);
  expect(
    runtime.normalizeSymbols("btc-eth-relative-strength", "ETH/USD"),
  ).toEqual(["ETH/USD", "BTC/USD"]);

  const config = { strategyId: "cash", symbols: ["BTC/USD"] };
  expect(await runtime.configHash(config)).toBe(
    await runtime.configHash(config),
  );
  expect(await runtime.evaluateDue("test-scheduler")).toMatchObject({
    checked: 0,
    due: 0,
  });
});
