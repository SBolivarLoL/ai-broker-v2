import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  defaultStudyDirectory, forecastFile, forecastSchema, hash, hourFloor, HOUR, MINUTE,
  modelEvidenceScorecard, outcomeFile, outcomeSchema, readStudyRecord, readStudyRegistration,
  selectStudyBars, shadowProtocol, studyRegistration, writeStudyRecord,
} from "../backend/features/strategies/model-evidence";

const directory = resolve(process.env.KRONOS_SHADOW_DIR ?? defaultStudyDirectory);
const candles = z.object({ bars: z.record(z.string(), z.array(z.unknown())), next_page_token: z.string().nullable().optional() });

async function marketBars(timeframe: "1Hour" | "1Min", start: number, end: number) {
  const url = new URL("https://data.alpaca.markets/v1beta3/crypto/us/bars");
  const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");
  url.search = new URLSearchParams({
    symbols: shadowProtocol.symbol, timeframe, start: iso(start), end: iso(end),
  }).toString();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Alpaca crypto data returned HTTP ${response.status}`);
  const payload = candles.parse(await response.json());
  if (payload.next_page_token) throw new Error("Unexpected pagination for bounded study data");
  return payload.bars[shadowProtocol.symbol] ?? [];
}

function predict(slot: number, inputs: ReturnType<typeof selectStudyBars>) {
  const required = ["KRONOS_PYTHON", "KRONOS_SOURCE", "KRONOS_MODEL", "KRONOS_TOKENIZER"] as const;
  const paths = required.map(name => {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name} before running the Kronos collector`);
    return resolve(value);
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SYSTEMROOT|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(name)));
  return new Promise<number>((accept, reject) => {
    const child = execFile(paths[0]!, [
      "-I", join(import.meta.dir, "kronos-shadow/predict.py"), "--source", paths[1]!,
      "--model", paths[2]!, "--tokenizer", paths[3]!,
    ], { env, timeout: 90_000, windowsHide: true, maxBuffer: 128_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`Kronos inference failed (${error.code ?? error.signal ?? "worker"}): ${stderr.trim().slice(-800)}`));
      try {
        accept(z.object({ predictedClose: z.number().positive() }).parse(JSON.parse(stdout)).predictedClose);
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(JSON.stringify({ slot, inputs }));
  });
}

async function obtainForecast(slot: number) {
  const start = slot - shadowProtocol.contextHours * HOUR;
  const raw = await marketBars("1Hour", start, slot - HOUR);
  const retrieved = Date.now();
  const inputs = selectStudyBars(raw, start, shadowProtocol.contextHours, HOUR);
  const predictedClose = await predict(slot, inputs);
  return { slot, retrieved, recorded: Date.now(), inputs, predictedClose };
}

async function poll() {
  const registration = await readStudyRegistration(directory);
  if (!registration) throw new Error("Register the study with init before collecting");
  const now = Date.now();
  const slot = hourFloor(now);
  const end = registration.start + shadowProtocol.durationHours * HOUR;
  const cutoff = slot + shadowProtocol.cutoffMinute * MINUTE;
  if (slot >= registration.start && slot < end && now >= slot + shadowProtocol.openMinute * MINUTE &&
      now < cutoff && !await readStudyRecord(directory, forecastFile(slot), forecastSchema)) {
    try {
      const forecast = forecastSchema.parse(await obtainForecast(slot));
      if (await writeStudyRecord(directory, forecastFile(slot), forecast, () => Date.now() < cutoff))
        console.log(`${new Date().toISOString()} Forecast recorded for ${new Date(slot).toISOString()}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} Forecast pending: ${String(error)}`);
    }
  }

  const earliest = Math.max(registration.start, slot - shadowProtocol.maximumOutcomeDelayHours * HOUR);
  for (let targetSlot = Math.min(slot - HOUR, end - HOUR); targetSlot >= earliest; targetSlot -= HOUR) {
    const targetEnd = targetSlot + HOUR;
    if (now < targetEnd + shadowProtocol.settleMinute * MINUTE ||
        now >= targetSlot + shadowProtocol.maximumOutcomeDelayHours * HOUR) continue;
    try {
      const forecast = await readStudyRecord(directory, forecastFile(targetSlot), forecastSchema);
      if (!forecast || forecast.slot !== targetSlot || forecast.recorded < registration.registered ||
          await readStudyRecord(directory, outcomeFile(targetSlot), outcomeSchema)) continue;
      const entryTime = targetSlot + shadowProtocol.entryMinute * MINUTE;
      const hours = await marketBars("1Hour", targetSlot, targetSlot);
      const entryBars = await marketBars("1Min", entryTime, entryTime);
      const exitBars = await marketBars("1Min", targetEnd, targetEnd);
      const entry = selectStudyBars(entryBars, entryTime, 1, MINUTE)[0]!;
      const exit = selectStudyBars(exitBars, targetEnd, 1, MINUTE)[0]!;
      if (!entry.tradeCount || !exit.tradeCount)
        throw new Error("Alpaca reported no trades in one of the execution-proxy minutes");
      const outcome = outcomeSchema.parse({
        slot: targetSlot, forecastHash: hash(forecast), retrieved: Date.now(),
        target: selectStudyBars(hours, targetSlot, 1, HOUR)[0],
        entry, exit,
      });
      if (await writeStudyRecord(directory, outcomeFile(targetSlot), outcome))
        console.log(`${new Date().toISOString()} Outcome recorded for ${new Date(targetSlot).toISOString()}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} Outcome pending: ${String(error)}`);
    }
  }
  return now < end + shadowProtocol.maximumOutcomeDelayHours * HOUR;
}

const [command] = Bun.argv.slice(2);
switch (command) {
  case "init": {
    await writeStudyRecord(directory, "study.json", studyRegistration(Date.now()));
    console.log(JSON.stringify(await readStudyRegistration(directory)));
    break;
  }
  case "probe": {
    const forecast = await obtainForecast(hourFloor(Date.now()));
    console.log(JSON.stringify({ inputs: forecast.inputs.length, predictedClose: forecast.predictedClose, persisted: false }));
    break;
  }
  case "tick": {
    await poll();
    break;
  }
  case "watch": {
    while (await poll()) await delay(60_000);
    break;
  }
  case "report": {
    console.log(JSON.stringify(await modelEvidenceScorecard(directory, Date.now()), null, 2));
    break;
  }
  default:
    throw new Error("Usage: bun scripts/kronos-shadow.ts <init|probe|tick|watch|report>");
}
