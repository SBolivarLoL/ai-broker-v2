import { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createApp } from "./app";
import { createStore } from "./persistence/store";
import { resolveCodeIdentity } from "./features/strategies/strategy-provenance";

process.on("uncaughtException", (error) => {
  if (
    error instanceof Error &&
    error.message.startsWith("WebSocket is not open")
  ) {
    console.error("market stream websocket not ready", error.message);
    return;
  }
  throw error;
});

const port = Number(process.env.PORT ?? 3000);
const app = createApp({
  alpaca: new Alpaca({ paper: true, timeoutMs: 10_000 }),
  store: createStore(),
  codeIdentity: resolveCodeIdentity(),
  env: process.env,
});

Bun.serve({ port, idleTimeout: 60, fetch: app.fetch });
app.startRuntime();
console.log(`AI Broker running at http://localhost:${port}`);
