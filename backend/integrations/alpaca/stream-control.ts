const socketNotOpen = "WebSocket is not open: readyState 0 (CONNECTING)";

type GuardedStream = object;

const guardedStreams = new WeakSet<GuardedStream>();
const guardedConnections = new WeakSet<GuardedStream>();

function guardMethod(
  target: GuardedStream,
  method: "send" | "ping",
  onDeferred: (error: Error) => void,
) {
  const operation = Reflect.get(target, method);
  if (typeof operation !== "function") return;
  const installed = Reflect.set(
    target,
    method,
    function (this: GuardedStream, ...args: unknown[]) {
      try {
        return Reflect.apply(operation, this, args);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== socketNotOpen)
          throw error;
        onDeferred(error);
      }
    },
  );
  if (!installed)
    throw new Error(`The Alpaca socket ${method} boundary could not be guarded`);
}

function guardConnection(
  connection: GuardedStream,
  onDeferred: (error: Error) => void,
) {
  if (guardedConnections.has(connection)) return;
  guardMethod(connection, "send", onDeferred);
  guardMethod(connection, "ping", onDeferred);
  guardedConnections.add(connection);
}

/**
 * Alpaca SDK 0.2.0 sends and pings without checking the socket ready state.
 * Guard those provider operations while preserving every unrelated exception.
 */
export function containAlpacaSocketRace(
  stream: GuardedStream,
  onDeferred: (error: Error) => void,
) {
  if (guardedStreams.has(stream)) return;
  const send = Reflect.get(stream, "send");
  const connect = Reflect.get(stream, "connect");
  if (typeof send !== "function")
    throw new Error("The Alpaca stream send boundary is unavailable");
  if (typeof connect !== "function")
    throw new Error("The Alpaca stream connect boundary is unavailable");

  guardMethod(stream, "send", onDeferred);
  const installed = Reflect.set(stream, "connect", function (
    this: GuardedStream,
    ...args: unknown[]
  ) {
    const result = Reflect.apply(connect, this, args);
    const connection = Reflect.get(this, "conn");
    if (connection && typeof connection === "object")
      guardConnection(connection, onDeferred);
    return result;
  });
  if (!installed)
    throw new Error("The Alpaca stream connect boundary could not be guarded");
  guardedStreams.add(stream);
}
