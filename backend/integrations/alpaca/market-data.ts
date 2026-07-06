/**
 * Retrieves stock bars with entitlement-aware provenance: real-time SIP,
 * real-time IEX, then delayed SIP as the final fallback.
 */
import { TimeFrame } from "@alpacahq/alpaca-ts-alpha";

export type StockBarSource = {
  provider: "alpaca";
  feed: "sip" | "iex";
  delayed: boolean;
  fallback: boolean;
  attempts: string[];
  warning: string | null;
};

const minutes = (value: number) => value * 60_000;
const entitlementPattern =
  /subscription|SIP|entitlement|permit|permission|forbidden|unauthorized/i;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isEntitlementError(error: unknown) {
  return entitlementPattern.test(message(error));
}

export async function getStockBarsWithFallback(
  marketData: {
    getStockBarsFor(
      symbol: string,
      options: Record<string, unknown>,
    ): Promise<any[]>;
  },
  symbol: string,
  input: { start: Date; end?: Date; timeframe?: unknown; now?: Date } & Record<
    string,
    unknown
  >,
) {
  const {
    start,
    end,
    timeframe = TimeFrame.Day,
    now = new Date(),
    ...rest
  } = input;
  const attempts: string[] = [];
  const base = { ...rest, timeframe, start, ...(end ? { end } : {}) };
  async function fetch(feed: "sip" | "iex", delayed: boolean) {
    const adjustedEnd = delayed
      // Alpaca delayed SIP requires the request window to end outside the
      // real-time entitlement boundary.
      ? new Date(Math.min((end ?? now).getTime(), now.getTime() - minutes(16)))
      : end;
    const options = {
      ...base,
      feed,
      ...(adjustedEnd ? { end: adjustedEnd } : {}),
    };
    attempts.push(`${feed}${delayed ? ":delayed" : ""}`);
    const bars = await marketData.getStockBarsFor(symbol, options);
    return {
      bars,
      source: {
        provider: "alpaca" as const,
        feed,
        delayed,
        fallback: attempts.length > 1,
        attempts: [...attempts],
        warning:
          attempts.length > 1
            ? `Using ${feed.toUpperCase()}${delayed ? " delayed" : ""} bars after ${attempts.slice(0, -1).join(", ")} was unavailable.`
            : null,
      },
    };
  }
  try {
    return await fetch("sip", false);
  } catch (error) {
    if (!isEntitlementError(error)) throw error;
  }
  try {
    return await fetch("iex", false);
  } catch (error) {
    if (!isEntitlementError(error)) throw error;
  }
  return fetch("sip", true);
}
