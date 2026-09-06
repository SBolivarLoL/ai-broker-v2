import { expect, test } from "bun:test";
import { Alpaca, streaming } from "@alpacahq/alpaca-ts-alpha";
import { containAlpacaSocketRace } from "../../backend/integrations/alpaca/stream-control";

test("Alpaca stream guard contains only the installed SDK socket race", () => {
  const deferred: string[] = [];
  const stream = {
    connect() {},
    send() {
      throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
    },
  };
  containAlpacaSocketRace(stream, (error) => deferred.push(error.message));
  expect(() => stream.send()).not.toThrow();

  for (const message of [
    "WebSocket is not open: readyState 2 (CLOSING)",
    "WebSocket is not open for an unrelated reason",
  ]) {
    const unrelated = {
      connect() {},
      send() {
        throw new Error(message);
      },
    };
    containAlpacaSocketRace(unrelated, () => {
      throw new Error("should not defer");
    });
    expect(() => unrelated.send()).toThrow(message);
  }
  expect(deferred).toEqual([
    "WebSocket is not open: readyState 0 (CONNECTING)",
  ]);
});

test("Alpaca 0.2.0 stream guard contains connect-time send and ping races", () => {
  const deferred: string[] = [];
  const callbacks: Record<string, () => void> = {};
  const socket = {
    on(event: string, callback: () => void) {
      callbacks[event] = callback;
    },
    send() {
      throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
    },
    ping() {
      throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
    },
    close() {},
  };
  const stream = new Alpaca({
    keyId: "fixture-key",
    secret: "fixture-secret",
    paper: true,
  }).trading.stream({
    pingIntervalMs: 0,
    wsFactory: () => socket,
  });
  containAlpacaSocketRace(stream, (error) => deferred.push(error.message));
  stream.connect();

  expect(() => callbacks.open!()).not.toThrow();
  expect(() => socket.ping()).not.toThrow();
  expect(deferred).toEqual([
    "WebSocket is not open: readyState 0 (CONNECTING)",
    "WebSocket is not open: readyState 0 (CONNECTING)",
  ]);
  stream.disconnect();
});

test("Alpaca 0.2.0 trading stream restores trade updates after reconnect", async () => {
  type Listener = (...args: unknown[]) => void;
  const sockets: Array<{
    sent: Array<Record<string, unknown>>;
    emit: (event: string, ...args: unknown[]) => void;
    on: (event: string, callback: Listener) => void;
    send: (data: string | Uint8Array) => void;
    close: () => void;
  }> = [];
  const stream = new Alpaca({
    keyId: "fixture-key",
    secret: "fixture-secret",
    paper: true,
  }).trading.stream({
    pingIntervalMs: 0,
    reconnect: true,
    wsFactory: () => {
      const listeners = new Map<string, Listener[]>();
      const socket = {
        sent: [] as Array<Record<string, unknown>>,
        on(event: string, callback: Listener) {
          const registered = listeners.get(event) ?? [];
          registered.push(callback);
          listeners.set(event, registered);
        },
        emit(event: string, ...args: unknown[]) {
          for (const listener of listeners.get(event) ?? []) listener(...args);
        },
        send(data: string | Uint8Array) {
          socket.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
        },
        close() {},
      };
      sockets.push(socket);
      return socket;
    },
  });
  containAlpacaSocketRace(stream, () => {
    throw new Error("fixture sockets are open before authentication");
  });
  stream.subscribeTradeUpdates();

  try {
    stream.connect();
    sockets[0]!.emit("open");
    sockets[0]!.emit(
      "message",
      JSON.stringify({
        stream: "authorization",
        data: { status: "authorized" },
      }),
    );
    expect(sockets[0]!.sent).toEqual([
      {
        action: "authenticate",
        data: { key_id: "fixture-key", secret_key: "fixture-secret" },
      },
      { action: "listen", data: { streams: ["trade_updates"] } },
    ]);

    sockets[0]!.emit("close");
    await Bun.sleep(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("open");
    sockets[1]!.emit(
      "message",
      JSON.stringify({
        stream: "authorization",
        data: { status: "authorized" },
      }),
    );
    expect(sockets[1]!.sent).toEqual([
      {
        action: "authenticate",
        data: { key_id: "fixture-key", secret_key: "fixture-secret" },
      },
      { action: "listen", data: { streams: ["trade_updates"] } },
    ]);
    expect(stream.getState()).toBe(streaming.STATE.AUTHENTICATED);
  } finally {
    stream.disconnect();
  }
});
