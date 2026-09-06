/** Process entry point: construct runtime dependencies, listen, then start jobs. */
import { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { createApp } from "./app";
import { createStore } from "./persistence/store";
import { resolveCodeIdentity } from "./features/strategies/strategy-provenance";

const port = Number(process.env.PORT ?? 3000);
const store = createStore();
const app = createApp({
  alpaca: new Alpaca({ paper: true, timeoutMs: 10_000 }),
  store,
  codeIdentity: resolveCodeIdentity(),
  env: process.env,
});

const server = Bun.serve({ port, idleTimeout: 60, fetch: app.fetch });
app.startRuntime();
console.log(`AI Broker running at http://localhost:${port}`);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Stopping AI Broker after ${signal}`);
  let failed = false;
  try {
    app.stopRuntime();
  } catch (error) {
    failed = true;
    console.error(
      "runtime shutdown failed",
      error instanceof Error ? error.message : error,
    );
  }
  try {
    await server.stop();
  } catch (error) {
    failed = true;
    console.error(
      "HTTP shutdown failed",
      error instanceof Error ? error.message : error,
    );
  }
  if (failed) process.exitCode = 1;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
