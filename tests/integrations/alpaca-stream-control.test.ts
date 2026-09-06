import { expect, test } from "bun:test";
import { Alpaca } from "@alpacahq/alpaca-ts-alpha";
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
