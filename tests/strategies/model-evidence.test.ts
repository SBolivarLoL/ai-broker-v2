import { expect, test } from "bun:test";
import { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../backend/app";
import { createStore } from "../../backend/persistence/store";
import {
  forecastFile, forecastSchema, hash, HOUR, MINUTE, outcomeFile, outcomeSchema,
  selectStudyBars, studyRegistration, writeStudyRecord,
} from "../../backend/features/strategies/model-evidence";

const slot = Date.parse("2026-11-17T00:00:00Z");
const rawBar = (time: number, close: number) => ({
  t: new Date(time).toISOString(), o: close, h: close, l: close, c: close, v: 1, n: 1,
});

test("prospective scorecard scores only the matched, immutable forecast and outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kronos-evidence-"));
  const store = createStore(":memory:");
  const url = "http://local/api/strategy/model-evidence";
  let now = slot + 15 * MINUTE;
  const app = createApp({
    alpaca: new Alpaca({ paper: true, keyId: "test", secret: "test" }),
    store, codeIdentity: { gitCommit: "b".repeat(40), workingTreeDirty: false },
    env: { NODE_ENV: "test", KRONOS_SHADOW_DIR: directory },
    now: () => new Date(now),
  });
  const files = ["study.json", forecastFile(slot), outcomeFile(slot)];
  try {
    const load = async () => {
      const response = await app.fetch(new Request(url));
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await load()).toMatchObject({
      status: "not_started", protocol: { mode: "shadow", symbol: "BTC/USD" }, coverage: { matched: 0 },
    });
    await writeStudyRecord(directory, files[0]!, studyRegistration(slot + MINUTE));
    const start = slot - 64 * HOUR;
    const inputs = selectStudyBars(
      Array.from({ length: 65 }, (_, index) => rawBar(start + index * HOUR, index === 64 ? 1000 : 100)),
      start, 64, HOUR,
    );
    expect(inputs.at(-1)?.close).toBe(100);
    const forecast = forecastSchema.parse({
      slot, retrieved: slot + 4 * MINUTE, recorded: slot + 5 * MINUTE, inputs, predictedClose: 105,
    });
    expect(forecastSchema.safeParse({ ...forecast, recorded: slot + 25 * MINUTE }).success).toBe(false);
    expect(await writeStudyRecord(directory, files[1]!, forecast)).toBe(true);
    expect(await writeStudyRecord(directory, files[1]!, { ...forecast, predictedClose: 999 })).toBe(false);
    expect(await load()).toMatchObject({
      status: "collecting", coverage: { matched: 0, recorded: 1, pending: 1 },
      latestForecast: { predictedClose: 105 },
    });

    const normalized = (time: number, close: number) =>
      selectStudyBars([rawBar(time, close)], time, 1, MINUTE)[0]!;
    const outcome = outcomeSchema.parse({
      slot, retrieved: slot + HOUR + 21 * MINUTE, forecastHash: hash(forecast),
      target: normalized(slot, 106), entry: normalized(slot + 30 * MINUTE, 102),
      exit: normalized(slot + HOUR, 103),
    });
    await writeStudyRecord(directory, files[2]!, outcome);
    expect(await load()).toMatchObject({ coverage: { matched: 0, invalid: 1 } });
    now = slot + HOUR + 30 * MINUTE;
    const scored = await load();
    expect(scored.coverage).toMatchObject({ matched: 1, missed: 1, invalid: 0 });
    const [kronos, persistence, momentum, alwaysLong] = scored.comparisons;
    expect(kronos.forecastMaeBps).toBeCloseTo(100);
    expect(kronos.netReturnPct).toBeCloseTo((103 / 102 * 0.996 - 1) * 100);
    expect(kronos.stressedReturnPct).toBeLessThan(kronos.netReturnPct);
    expect(persistence.forecastMaeBps).toBeCloseTo(600);
    expect(momentum.netReturnPct).toBe(0);
    expect(alwaysLong.netReturnPct).toBe(kronos.netReturnPct);
    expect(kronos.roundTrips).toBe(1);
    await writeFile(join(directory, files[2]!), JSON.stringify({
      payload: { ...outcome, forecastHash: "a".repeat(64) },
      sha256: hash({ ...outcome, forecastHash: "a".repeat(64) }),
    }));
    expect(await load()).toMatchObject({ coverage: { matched: 0, invalid: 1 } });
    expect((await app.fetch(new Request(url, { method: "POST" }))).status).not.toBe(200);
  } finally {
    store.close();
    await Promise.all(files.map(file => unlink(join(directory, file)).catch(() => {})));
    await rmdir(directory);
  }
});

test("study bar selection requires complete, unique observations", () => {
  expect(() => selectStudyBars([rawBar(slot, 100)], slot, 2, HOUR)).toThrow("missing");
  expect(() => selectStudyBars([rawBar(slot, 100), rawBar(slot, 101)], slot, 1, HOUR)).toThrow("Duplicate");
  expect(() => selectStudyBars([{ ...rawBar(slot, 100), v: null }], slot, 1, HOUR)).toThrow("missing");
  expect(studyRegistration(slot + 25 * MINUTE).start).toBe(slot + HOUR);
});
