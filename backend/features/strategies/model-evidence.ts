import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { normalizeCryptoBar } from "./crypto-strategy-data";
import pins from "../../../scripts/kronos-shadow/pins.json";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const shadowProtocol = {
  id: "btc-usd-kronos-hourly-v1",
  mode: "shadow",
  symbol: "BTC/USD",
  source: "Alpaca Crypto Data API",
  feed: "us",
  model: pins.model.id,
  modelRevision: pins.model.revision,
  tokenizerRevision: pins.tokenizer.revision,
  sourceRevision: pins.revision,
  inference: { seed: 42, temperature: 1, topP: 0.9, samples: 1 },
  contextHours: 64,
  horizonHours: 1,
  durationHours: 30 * 24,
  minimumMatched: 336,
  openMinute: 2,
  cutoffMinute: 25,
  entryMinute: 30,
  settleMinute: 20,
  maximumOutcomeDelayHours: 24,
  roundTripBps: 40,
  stressRoundTripBps: 80,
} as const;

export const defaultStudyDirectory = "data/model-evidence/btc-usd-kronos-hourly-v1";
const epoch = z.number().int().safe().nonnegative();
const price = z.number().positive();
const bar = z.object({
  timestamp: z.iso.datetime(), symbol: z.literal(shadowProtocol.symbol),
  open: price, high: price, low: price, close: price, volume: z.number().nonnegative(),
  vwap: price.nullable(), tradeCount: z.number().int().nonnegative().nullable(),
}).strict();
const registrationSchema = z.object({
  protocol: z.literal(shadowProtocol.id),
  protocolHash: z.literal(hash(shadowProtocol)),
  registered: epoch,
  start: epoch,
}).strict().refine(r => r.start % HOUR === 0 && r.registered < r.start + shadowProtocol.cutoffMinute * MINUTE);
export const forecastSchema = z.object({
  slot: epoch,
  retrieved: epoch,
  recorded: epoch,
  inputs: z.array(bar).length(shadowProtocol.contextHours),
  predictedClose: price,
}).strict().refine(f =>
  f.slot % HOUR === 0 && f.retrieved >= f.slot + shadowProtocol.openMinute * MINUTE &&
  f.recorded >= f.retrieved && f.recorded < f.slot + shadowProtocol.cutoffMinute * MINUTE &&
  f.inputs.every((b, index) => Date.parse(b.timestamp) === f.slot - (f.inputs.length - index) * HOUR),
);
export const outcomeSchema = z.object({
  slot: epoch,
  retrieved: epoch,
  forecastHash: z.string().regex(/^[a-f0-9]{64}$/),
  target: bar,
  entry: bar,
  exit: bar,
}).strict().refine(o =>
  o.slot % HOUR === 0 && o.retrieved >= o.slot + HOUR + shadowProtocol.settleMinute * MINUTE &&
  o.retrieved < o.slot + shadowProtocol.maximumOutcomeDelayHours * HOUR &&
  Date.parse(o.target.timestamp) === o.slot &&
  Date.parse(o.entry.timestamp) === o.slot + shadowProtocol.entryMinute * MINUTE &&
  Date.parse(o.exit.timestamp) === o.slot + HOUR &&
  (o.entry.tradeCount ?? 0) > 0 && (o.exit.tradeCount ?? 0) > 0,
);

type Forecast = z.infer<typeof forecastSchema>;
type Outcome = z.infer<typeof outcomeSchema>;

export function hash(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function writeStudyRecord<T>(
  directory: string, name: string, value: T, canPublish = () => true,
) {
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ payload: value, sha256: hash(value) }), { flag: "wx" });
    if (!canPublish()) throw new Error("Study record missed its publication deadline");
    // Publish a complete record without overwriting one won by another process.
    await link(temporary, join(directory, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function readStudyRecord<T>(directory: string, name: string, schema: z.ZodType<T>) {
  let raw: string;
  try {
    raw = await readFile(join(directory, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const { payload, sha256 } = z.object({ payload: z.unknown(), sha256: z.string() }).parse(JSON.parse(raw));
  if (hash(payload) !== sha256) throw new Error("Study record integrity check failed");
  return schema.parse(payload);
}

export const forecastFile = (slot: number) => `${slot}.forecast.json`;
export const outcomeFile = (slot: number) => `${slot}.outcome.json`;
export const hourFloor = (time: number) => Math.floor(time / HOUR) * HOUR;

export function studyRegistration(now: number) {
  const hour = hourFloor(now);
  const start = now < hour + shadowProtocol.cutoffMinute * MINUTE - MINUTE ? hour : hour + HOUR;
  return registrationSchema.parse({
    protocol: shadowProtocol.id, protocolHash: hash(shadowProtocol), registered: now, start,
  });
}

export function readStudyRegistration(directory: string) {
  return readStudyRecord(directory, "study.json", registrationSchema);
}

export function selectStudyBars(raw: unknown[], start: number, count: number, spacing: number) {
  const selected = new Map<number, z.infer<typeof bar>>();
  const end = start + count * spacing;
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const fields = row as Record<string, unknown>;
    if (![fields.o, fields.h, fields.l, fields.c, fields.v].every(value => typeof value === "number")) continue;
    const dto = normalizeCryptoBar(shadowProtocol.symbol, fields);
    if (!dto) continue;
    const time = Date.parse(dto.timestamp);
    if (time < start || time >= end || (time - start) % spacing !== 0) continue;
    if (selected.has(time)) throw new Error("Duplicate study bar");
    selected.set(time, bar.parse(dto));
  }
  const result = Array.from({ length: count }, (_, index) => selected.get(start + index * spacing));
  if (result.some(item => !item)) throw new Error("Study bar missing or malformed");
  return result as z.infer<typeof bar>[];
}

const cases = [
  { id: "kronos", label: "Kronos-mini", predict: (f: Forecast) => f.predictedClose, opens: true },
  { id: "persistence", label: "Persistence / cash", predict: (f: Forecast) => f.inputs.at(-1)!.close, opens: false },
  { id: "momentum", label: "Last-hour momentum", predict: (f: Forecast) => {
    const last = f.inputs.at(-1)!.close;
    return last * (last / f.inputs.at(-2)!.close);
  }, opens: true },
  { id: "always-long", label: "Always long per window", predict: null, opens: true },
] as const;

function compare(rows: { forecast: Forecast; outcome: Outcome }[]) {
  return cases.map(rule => {
    let absoluteError = 0, equity = 1, stressed = 1, peak = 1, drawdown = 0, roundTrips = 0;
    for (const { forecast, outcome } of rows) {
      const prediction = rule.predict?.(forecast);
      const last = forecast.inputs.at(-1)!.close;
      if (prediction !== undefined) absoluteError += Math.abs(prediction / last - outcome.target.close / last);
      const enters = rule.opens && (prediction === undefined ||
        (prediction / last - 1) * 10_000 > shadowProtocol.roundTripBps);
      if (!enters) continue;
      const gross = outcome.exit.open / outcome.entry.open;
      equity *= gross * (1 - shadowProtocol.roundTripBps / 10_000);
      stressed *= gross * (1 - shadowProtocol.stressRoundTripBps / 10_000);
      peak = Math.max(peak, equity);
      drawdown = Math.max(drawdown, 1 - equity / peak);
      roundTrips++;
    }
    return {
      id: rule.id, label: rule.label,
      forecastMaeBps: rows.length && rule.predict ? absoluteError / rows.length * 10_000 : null,
      netReturnPct: rows.length ? (equity - 1) * 100 : null,
      stressedReturnPct: rows.length ? (stressed - 1) * 100 : null,
      maxDrawdownPct: rows.length ? drawdown * 100 : null,
      roundTrips,
    };
  });
}

export async function modelEvidenceScorecard(directory: string, now: number) {
  const registration = await readStudyRegistration(directory);
  const rows: { forecast: Forecast; outcome: Outcome }[] = [];
  const end = registration ? registration.start + shadowProtocol.durationHours * HOUR : null;
  const coverage = { due: 0, recorded: 0, pending: 0, missed: 0, outcomeMissing: 0, invalid: 0 };
  let latestForecast: Forecast | null = null;
  if (registration && end !== null) {
    for (let slot = registration.start; slot < end && slot <= now; slot += HOUR) {
      const due = now >= slot + shadowProtocol.cutoffMinute * MINUTE;
      if (due) coverage.due++;
      try {
        const forecast = await readStudyRecord(directory, forecastFile(slot), forecastSchema);
        if (!forecast) {
          if (due) coverage.missed++;
          continue;
        }
        if (forecast.slot !== slot || forecast.recorded < registration.registered || forecast.recorded > now)
          throw new Error("Forecast is outside the registered study");
        latestForecast = forecast;
        coverage.recorded++;
        const outcome = await readStudyRecord(directory, outcomeFile(slot), outcomeSchema);
        if (!outcome) {
          if (now < slot + shadowProtocol.maximumOutcomeDelayHours * HOUR) coverage.pending++;
          else coverage.outcomeMissing++;
          continue;
        }
        if (outcome.slot !== slot || outcome.retrieved > now || outcome.forecastHash !== hash(forecast))
          throw new Error("Outcome does not match the original forecast");
        rows.push({ forecast, outcome });
      } catch {
        coverage.invalid++;
      }
    }
  }
  const blockers = [
    ...(end === null || now < end ? ["Study window has not finished."] : []),
    ...(rows.length < shadowProtocol.minimumMatched ?
      [`Collect at least ${shadowProtocol.minimumMatched} matched observations before review.`] : []),
    ...(coverage.invalid ? ["Investigate invalid evidence records."] : []),
    ...(coverage.pending ? ["Wait for pending outcomes to settle or expire."] : []),
    "This study records observations in shadow mode.",
  ];
  const iso = (t: number) => new Date(t).toISOString();
  return {
    protocol: shadowProtocol, status: !registration ? "not_started" : now < registration.start ? "scheduled" :
      now < end! ? "collecting" : coverage.pending ? "settling" : "window_ended",
    window: registration && end !== null ? {
      registered: iso(registration.registered), starts: iso(registration.start), ends: iso(end),
    } : null,
    coverage: { ...coverage, matched: rows.length },
    latestForecast: latestForecast ? {
      targetHour: iso(latestForecast.slot), retrieved: iso(latestForecast.retrieved),
      recorded: iso(latestForecast.recorded), predictedClose: latestForecast.predictedClose,
      inputHash: hash(latestForecast.inputs),
    } : null,
    comparisons: compare(rows), blockers,
  };
}
