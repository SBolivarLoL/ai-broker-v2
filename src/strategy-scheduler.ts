type ScheduledRun = { status: string; config: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function validDate(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function parseStrategyIntervalMinutes(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const minutes = Number(value);
  if (minutes === 0) return null;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) throw new Error("Strategy schedule interval must be 1 to 1440 minutes, or 0 to disable scheduling");
  return minutes;
}

export function normalizeStrategySchedule(config: unknown) {
  if (!isRecord(config) || !isRecord(config.schedule)) return null;
  if (config.schedule.enabled === false) return null;
  const intervalMinutes = parseStrategyIntervalMinutes(config.schedule.intervalMinutes);
  if (!intervalMinutes) return null;
  return {
    enabled: true,
    intervalMinutes,
    nextRunAt: validDate(config.schedule.nextRunAt),
    lastRunAt: validDate(config.schedule.lastRunAt),
  };
}

export function strategyRunIsDue(run: ScheduledRun, now = new Date(), latestDecisionCreatedAt: string | null = null) {
  if (!["shadow", "paper"].includes(run.status)) return false;
  const schedule = normalizeStrategySchedule(run.config);
  if (!schedule) return false;
  if (schedule.nextRunAt) return schedule.nextRunAt.getTime() <= now.getTime();
  const latestDecision = validDate(latestDecisionCreatedAt);
  return !latestDecision || latestDecision.getTime() + schedule.intervalMinutes * 60_000 <= now.getTime();
}

export function withNextStrategySchedule(config: unknown, completedAt = new Date()) {
  const schedule = normalizeStrategySchedule(config);
  if (!schedule || !isRecord(config)) throw new Error("Strategy run is not scheduled");
  return {
    ...config,
    schedule: {
      ...(config.schedule as Record<string, unknown>),
      enabled: true,
      intervalMinutes: schedule.intervalMinutes,
      lastRunAt: completedAt.toISOString(),
      nextRunAt: new Date(completedAt.getTime() + schedule.intervalMinutes * 60_000).toISOString(),
    },
  };
}
