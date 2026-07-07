/** Normalizes entitled index, FX, and crypto snapshots for one dashboard DTO. */
import { normalizeTimeProvenance } from "../../shared/time-provenance";

type DateInput = string | number | Date;

export type MultiAssetDtoInput = {
  indices?: Record<string, any>;
  forex?: Record<string, any>;
  crypto?: Record<string, any>;
  warnings?: string[];
  retrievedAt?: DateInput;
  serverRespondedAt?: DateInput;
};

const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const iso = (value: DateInput) => new Date(value).toISOString();

const optionalIso = (value: unknown) => (value ? iso(value as DateInput) : null);

const latest = (times: (string | null)[]) =>
  times
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

export function multiAssetDto(input: MultiAssetDtoInput) {
  const retrievedAt = iso(input.retrievedAt ?? new Date());
  const serverRespondedAt = iso(input.serverRespondedAt ?? retrievedAt);
  const indices = Object.entries(input.indices ?? {}).map(
    ([symbol, value]) => {
      const observedAt = optionalIso(value.t);
      return {
        symbol,
        value: finite(value.v),
        asOf: observedAt,
        observedAt,
        retrievedAt,
        serverRespondedAt,
        time: normalizeTimeProvenance({
          observationTime: observedAt,
          retrievalTime: retrievedAt,
          serverResponseTime: serverRespondedAt,
        }),
      };
    },
  );
  const forex = Object.entries(input.forex ?? {}).map(([symbol, rate]) => {
    const observedAt = optionalIso(rate.t);
    return {
      symbol,
      bid: finite(rate.bp),
      ask: finite(rate.ap),
      midpoint: finite(rate.mp),
      asOf: observedAt,
      observedAt,
      retrievedAt,
      serverRespondedAt,
      time: normalizeTimeProvenance({
        observationTime: observedAt,
        retrievalTime: retrievedAt,
        serverResponseTime: serverRespondedAt,
      }),
    };
  });
  const crypto = Object.entries(input.crypto ?? {}).map(
    ([symbol, snapshot]) => {
      const quote = snapshot.latestQuote ?? {},
        daily = snapshot.dailyBar ?? {},
        previous = snapshot.prevDailyBar ?? {},
        bid = finite(quote.bp),
        ask = finite(quote.ap),
        midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null,
        previousClose = finite(previous.c),
        close = finite(daily.c);
      const observedAt = optionalIso(quote.t);
      return {
        symbol,
        bid,
        ask,
        midpoint,
        spreadBps:
          midpoint && ask !== null && bid !== null
            ? ((ask - bid) / midpoint) * 10_000
            : null,
        dayChangePercent:
          close !== null && previousClose
            ? (close / previousClose - 1) * 100
            : null,
        dayHigh: finite(daily.h),
        dayLow: finite(daily.l),
        volume: finite(daily.v),
        asOf: observedAt,
        observedAt,
        retrievedAt,
        serverRespondedAt,
        time: normalizeTimeProvenance({
          observationTime: observedAt,
          retrievalTime: retrievedAt,
          serverResponseTime: serverRespondedAt,
        }),
      };
    },
  );
  const observedAt = latest([
    ...indices.map((item) => item.observedAt),
    ...forex.map((item) => item.observedAt),
    ...crypto.map((item) => item.observedAt),
  ]);
  return {
    indices,
    forex,
    crypto,
    observedAt,
    retrievedAt,
    serverRespondedAt,
    time: normalizeTimeProvenance({
      observationTime: observedAt,
      retrievalTime: retrievedAt,
      serverResponseTime: serverRespondedAt,
    }),
    warnings: input.warnings ?? [],
    source: "Alpaca market data",
    cryptoRisk:
      "Crypto trades 24/7, has no equity market close, is cash-only collateral at Alpaca, and can gap through thin liquidity.",
    asOf: serverRespondedAt,
  };
}
