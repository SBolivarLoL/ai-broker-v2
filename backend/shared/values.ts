/** Small normalization helpers used at provider and calculation boundaries. */
export type PriceBarInput = {
  timestamp?: Date | string | number;
  t?: Date | string | number;
  close?: number | string | null;
  c?: number | string | null;
};

export function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validDate(value: unknown) {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function normalizePriceBars(bars: PriceBarInput[] = []) {
  // Provider rows are untrusted: discard non-finite or non-positive prices
  // before chronological calculations consume them.
  return bars
    .map((bar) => {
      const timestamp = validDate(bar.timestamp ?? bar.t);
      const close = finiteNumber(bar.close ?? bar.c);
      return timestamp && close && close > 0 ? { timestamp, close } : null;
    })
    .filter((bar): bar is { timestamp: Date; close: number } => Boolean(bar))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
