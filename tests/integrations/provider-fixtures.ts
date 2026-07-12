import { z } from "zod";

export const ProviderScenarioClass = z.enum([
  "baseline",
  "malformed",
  "partial",
  "rate_limit",
  "revision",
  "timestamp_edge",
]);
export type ProviderScenarioClass = z.infer<typeof ProviderScenarioClass>;

const RecordingOrigin = z.object({
  endpoint: z.string().min(1),
  kind: z.enum([
    "live_redacted",
    "official_documentation_redacted",
    "application_capability_contract",
  ]),
  recordedAt: z.string().datetime(),
  sourceUrl: z.string().url(),
  rawSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  digestOmissionReason: z.string().min(1).nullable(),
});

const ProviderCase = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  class: ProviderScenarioClass,
  derivation: z.enum([
    "redacted_recording",
    "redacted_recording_mutation",
    "official_documentation_mutation",
    "synthetic_transport_envelope",
    "application_contract",
  ]),
  payload: z.string().min(1),
  expected: z.string().min(1),
});

export const ProviderContractFixture = z.object({
  fixtureVersion: z.literal("provider-contract-fixture-v1"),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  provider: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
  origins: z.array(RecordingOrigin).min(1),
  redaction: z.object({
    removed: z.array(z.string().min(1)),
    replaced: z.array(z.string().min(1)),
    review: z.string().min(1),
  }),
  payloads: z.record(z.string(), z.unknown()),
  cases: z.array(ProviderCase).min(1),
});
export type ProviderContractFixture = z.infer<
  typeof ProviderContractFixture
>;

const ManifestEntry = z.object({
  file: z.string().regex(/^[a-z0-9][a-z0-9_-]*\.json$/),
  sourceIds: z.array(z.string().min(1)).min(1),
});
export const ProviderFixtureManifest = z.object({
  manifestVersion: z.literal("provider-fixture-manifest-v1"),
  reviewedAt: z.string().date(),
  fixtures: z.array(ManifestEntry).min(1),
});

const fixtureDirectory = new URL("../fixtures/providers/", import.meta.url);

export async function loadProviderFixture(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]*\.json$/.test(name))
    throw new Error("Invalid provider fixture name");
  return ProviderContractFixture.parse(
    await Bun.file(new URL(name, fixtureDirectory)).json(),
  );
}

export async function loadProviderFixtureManifest() {
  return ProviderFixtureManifest.parse(
    await Bun.file(new URL("manifest.json", fixtureDirectory)).json(),
  );
}

export function fixturePayload<T = unknown>(
  fixture: ProviderContractFixture,
  name: string,
) {
  if (!(name in fixture.payloads))
    throw new Error(`Provider fixture payload ${name} is missing`);
  return fixture.payloads[name] as T;
}

export function fixtureCase(
  fixture: ProviderContractFixture,
  id: string,
) {
  const contractCase = fixture.cases.find((item) => item.id === id);
  if (!contractCase) throw new Error(`Provider fixture case ${id} is missing`);
  return {
    ...contractCase,
    payload: fixturePayload(fixture, contractCase.payload),
  };
}
