import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import type { createStore } from "../../persistence/store";
import type { createOrderRuntime } from "../orders/runtime";
import type { createStrategyRuntime } from "./runtime";

type Store = ReturnType<typeof createStore>;
type StrategyRuntime = ReturnType<typeof createStrategyRuntime>;
type OrderRuntime = ReturnType<typeof createOrderRuntime>;
type RateLimit = (key: string, maximum: number) => boolean;

export type StrategyRouteContext = {
  alpaca: Alpaca;
  store: Store;
  runtime: StrategyRuntime;
  orderRuntime: OrderRuntime;
  actor: string;
  allow: RateLimit;
  previewSecret: string;
};
