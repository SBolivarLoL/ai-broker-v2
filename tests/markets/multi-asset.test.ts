import { expect, test } from "bun:test";
import { multiAssetDto } from "../../backend/features/markets/multi-asset";

test("normalizes entitled multi-asset data and explicit coverage warnings", () => {
  const dto = multiAssetDto({
    indices: { SPX: { v: 6000, t: "2026-06-22T20:00:00Z" } },
    forex: {
      "EUR/USD": { bp: 1.1, ap: 1.1002, mp: 1.1001, t: "2026-06-22T20:00:00Z" },
    },
    crypto: {
      "BTC/USD": {
        latestQuote: { bp: 99, ap: 101, t: "2026-06-22T20:00:00Z" },
        dailyBar: { c: 105, h: 110, l: 90, v: 12 },
        prevDailyBar: { c: 100 },
      },
    },
    warnings: ["FX entitlement unavailable"],
  });
  expect(dto.indices[0]).toMatchObject({ symbol: "SPX", value: 6000 });
  expect(dto.forex[0]).toMatchObject({ midpoint: 1.1001 });
  expect(dto.crypto[0]).toMatchObject({ midpoint: 100, spreadBps: 200 });
  expect(dto.crypto[0]?.dayChangePercent).toBeCloseTo(5);
  expect(dto.warnings).toEqual(["FX entitlement unavailable"]);
});
