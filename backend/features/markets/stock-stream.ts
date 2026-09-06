import type { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { securityHeaders } from "../../http/http";
import { containAlpacaSocketRace } from "../../integrations/alpaca/stream-control";
import { localResponseTimeFields } from "../../shared/time-provenance";
import { streamBarDto, streamQuoteDto } from "./market-stream";

type StreamLifecycleDependencies = {
  setIntervalFn?: (callback: () => void, milliseconds: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
};

/** Owns one shared Alpaca stock stream and fans it out to bounded SSE subscribers. */
export function createStockStreamService(
  alpaca: Alpaca,
  {
    setIntervalFn = setInterval,
    clearIntervalFn = (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  }: StreamLifecycleDependencies = {},
) {
  const stockUpdates = alpaca.marketData.stockStream({
    feed: "iex",
    reconnect: true,
    maxReconnectSec: 30,
  });
  const encoder = new TextEncoder();
  const subscribers = new Map<
    number,
    {
      symbols: Set<string>;
      controller: ReadableStreamDefaultController<Uint8Array>;
    }
  >();
  const symbolReferences = new Map<string, number>();
  let state = "connecting";
  let nextSubscriberId = 1;
  let started = false;
  let heartbeat: unknown | null = null;

  containAlpacaSocketRace(stockUpdates, (error) => {
    console.error("stock stream websocket not ready", error.message);
  });

  function send(
    controller: ReadableStreamDefaultController<Uint8Array>,
    value: unknown,
  ) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  }

  function remove(id: number) {
    const subscriber = subscribers.get(id);
    if (!subscriber) return;
    subscribers.delete(id);
    const unused: string[] = [];
    for (const symbol of subscriber.symbols) {
      const references = (symbolReferences.get(symbol) ?? 1) - 1;
      if (references <= 0) {
        symbolReferences.delete(symbol);
        unused.push(symbol);
      } else {
        symbolReferences.set(symbol, references);
      }
    }
    if (unused.length) {
      stockUpdates.unsubscribeFromQuotes(unused);
      stockUpdates.unsubscribeFromBars(unused);
    }
  }

  function broadcast(value: {
    kind: string;
    symbol?: string;
    [key: string]: unknown;
  }) {
    for (const [id, subscriber] of subscribers) {
      if (value.symbol && !subscriber.symbols.has(value.symbol)) continue;
      try {
        send(subscriber.controller, value);
      } catch {
        remove(id);
      }
    }
  }

  function add(
    symbols: string[],
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    const id = nextSubscriberId++;
    const added: string[] = [];
    subscribers.set(id, { symbols: new Set(symbols), controller });
    for (const symbol of symbols) {
      const references = symbolReferences.get(symbol) ?? 0;
      symbolReferences.set(symbol, references + 1);
      if (!references) added.push(symbol);
    }
    if (added.length) {
      stockUpdates.subscribeForQuotes(added);
      stockUpdates.subscribeForBars(added);
    }
    send(controller, {
      kind: "status",
      state,
      symbols,
      ...localResponseTimeFields(new Date()),
    });
    return id;
  }

  stockUpdates.onStateChange((nextState) => {
    state = String(nextState);
    broadcast({ kind: "status", state, ...localResponseTimeFields(new Date()) });
  });
  stockUpdates.onConnect(() => {
    state = "authenticated";
    broadcast({ kind: "status", state, ...localResponseTimeFields(new Date()) });
  });
  stockUpdates.onDisconnect(() => {
    state = "disconnected";
    broadcast({ kind: "status", state, ...localResponseTimeFields(new Date()) });
  });
  stockUpdates.onError((error) => {
    state = "error";
    console.error("stock stream error", error);
    broadcast({ kind: "status", state, ...localResponseTimeFields(new Date()) });
  });
  stockUpdates.onQuote((quote) => {
    try {
      broadcast(streamQuoteDto(quote));
    } catch (error) {
      console.error("invalid stock quote", error);
    }
  });
  stockUpdates.onBar((bar) => {
    try {
      broadcast(streamBarDto(bar));
    } catch (error) {
      console.error("invalid stock bar", error);
    }
  });

  function open(request: Request, symbols: string[]) {
    let subscriberId = 0;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      remove(subscriberId);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        subscriberId = add(symbols, controller);
        request.signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel: cleanup,
    });
    return new Response(stream, {
      headers: {
        ...securityHeaders,
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  function start() {
    if (started) return;
    started = true;
    try {
      stockUpdates.connect();
      heartbeat = setIntervalFn(() => {
        for (const [id, subscriber] of subscribers) {
          try {
            subscriber.controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            remove(id);
          }
        }
      }, 20_000);
    } catch (error) {
      started = false;
      try {
        stockUpdates.disconnect();
      } catch (cleanupError) {
        console.error("stock stream cleanup failed", cleanupError);
      }
      throw error;
    }
  }

  function stop() {
    if (!started && heartbeat === null) return;
    started = false;
    const subscribedSymbols = [...symbolReferences.keys()];
    let failure: unknown;
    if (heartbeat !== null) {
      const interval = heartbeat;
      heartbeat = null;
      try {
        clearIntervalFn(interval);
      } catch (error) {
        failure = error;
      }
    }
    try {
      stockUpdates.disconnect();
    } catch (error) {
      failure ??= error;
    }
    if (subscribedSymbols.length) {
      try {
        stockUpdates.unsubscribeFromQuotes(subscribedSymbols);
      } catch (error) {
        failure ??= error;
      }
      try {
        stockUpdates.unsubscribeFromBars(subscribedSymbols);
      } catch (error) {
        failure ??= error;
      }
    }
    state = "disconnected";
    const openSubscribers = [...subscribers.values()];
    subscribers.clear();
    symbolReferences.clear();
    for (const subscriber of openSubscribers) {
      try {
        subscriber.controller.close();
      } catch {
        // The browser may already have closed its side of the SSE stream.
      }
    }
    if (failure) throw failure;
  }

  return { open, size: () => subscribers.size, start, stop };
}
