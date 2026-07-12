/** Explicit timestamp taxonomy for normalized provider DTOs. */
export type NormalizedEffectivePeriod = {
  start: string | null;
  end: string | null;
  label: string | null;
};

export type NormalizedTimeProvenance = {
  observationTime: string | null;
  publicationTime: string | null;
  effectivePeriod: NormalizedEffectivePeriod | null;
  retrievalTime: string;
  serverResponseTime: string;
};

export type EffectivePeriodInput = {
  start?: string | Date | number | null;
  end?: string | Date | number | null;
  label?: string | null;
};

export type TimeProvenanceInput = {
  observationTime?: string | Date | number | null;
  publicationTime?: string | Date | number | null;
  effectivePeriod?: EffectivePeriodInput | null;
  retrievalTime: string | Date | number;
  serverResponseTime?: string | Date | number | null;
};

export type ProviderTimeFields = {
  observedAt: string | null;
  publishedAt: string | null;
  effectivePeriod: NormalizedEffectivePeriod | null;
  retrievedAt: string;
  serverRespondedAt: string;
  time: NormalizedTimeProvenance;
  asOf: string;
};

export type UnavailableProviderTimeFields = {
  observedAt: null;
  publishedAt: null;
  effectivePeriod: null;
  retrievedAt: null;
  serverRespondedAt: string;
  time: {
    observationTime: null;
    publicationTime: null;
    effectivePeriod: null;
    retrievalTime: null;
    serverResponseTime: string;
  };
  asOf: string;
};

export type LocalResponseTimeFields = UnavailableProviderTimeFields;

export function normalizeIsoTime(value: string | Date | number, label: string) {
  const time = new Date(value);
  if (!String(value) || !Number.isFinite(time.getTime()))
    throw new Error(`${label} must be a valid timestamp`);
  return time.toISOString();
}

function optionalIsoTime(
  value: string | Date | number | null | undefined,
  label: string,
) {
  return value === null || value === undefined
    ? null
    : normalizeIsoTime(value, label);
}

function normalizedEffectivePeriod(
  value: EffectivePeriodInput | null | undefined,
) {
  if (!value) return null;
  const start = optionalIsoTime(value.start, "Effective period start");
  const end = optionalIsoTime(value.end, "Effective period end");
  const label = value.label?.trim() || null;
  if (!start && !end && !label)
    throw new Error("Effective period must include a start, end, or label");
  if (start && end && new Date(start).getTime() > new Date(end).getTime())
    throw new Error("Effective period start cannot be after end");
  return { start, end, label };
}

export function normalizeTimeProvenance(
  input: TimeProvenanceInput,
): NormalizedTimeProvenance {
  const retrievalTime = normalizeIsoTime(input.retrievalTime, "Retrieval time");
  return {
    observationTime: optionalIsoTime(
      input.observationTime,
      "Observation time",
    ),
    publicationTime: optionalIsoTime(
      input.publicationTime,
      "Publication time",
    ),
    effectivePeriod: normalizedEffectivePeriod(input.effectivePeriod),
    retrievalTime,
    serverResponseTime: normalizeIsoTime(
      input.serverResponseTime ?? retrievalTime,
      "Server response time",
    ),
  };
}

export function providerTimeFields(
  input: TimeProvenanceInput,
): ProviderTimeFields {
  const time = normalizeTimeProvenance(input);
  return {
    observedAt: time.observationTime,
    publishedAt: time.publicationTime,
    effectivePeriod: time.effectivePeriod,
    retrievedAt: time.retrievalTime,
    serverRespondedAt: time.serverResponseTime,
    time,
    asOf: time.serverResponseTime,
  };
}

/** Represents a provider that was not successfully queried for this DTO. */
export function unavailableProviderTimeFields(
  serverResponseTime: string | Date | number,
): UnavailableProviderTimeFields {
  const serverRespondedAt = normalizeIsoTime(
    serverResponseTime,
    "Server response time",
  );
  return {
    observedAt: null,
    publishedAt: null,
    effectivePeriod: null,
    retrievedAt: null,
    serverRespondedAt,
    time: {
      observationTime: null,
      publicationTime: null,
      effectivePeriod: null,
      retrievalTime: null,
      serverResponseTime: serverRespondedAt,
    },
    asOf: serverRespondedAt,
  };
}

/** Represents a local-only response for which no provider retrieval occurred. */
export function localResponseTimeFields(
  serverResponseTime: string | Date | number,
): LocalResponseTimeFields {
  return unavailableProviderTimeFields(serverResponseTime);
}
