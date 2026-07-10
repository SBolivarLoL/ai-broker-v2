import { getOpenFigiIdentity } from "../backend/integrations/openfigi";

const result = await getOpenFigiIdentity("AAPL", "Apple Inc. Common Stock");
if (
  !result.retrievedAt ||
  !result.serverRespondedAt ||
  result.time.retrievalTime !== result.retrievedAt ||
  result.time.serverResponseTime !== result.serverRespondedAt
)
  throw new Error("OpenFIGI root time provenance is incomplete");
if (result.status === "matched") {
  if (!result.canonicalFigi || result.selected?.ticker !== "AAPL")
    throw new Error("OpenFIGI selected identity is invalid");
  if (
    result.sources.length !== 1 ||
    result.sources[0]?.entityIds.figi !== result.canonicalFigi
  )
    throw new Error(
      "OpenFIGI canonical evidence does not retain the selected FIGI",
    );
  if (
    result.sources[0]?.authority !== "official" ||
    result.sources[0]?.claimStatus !== "official_record" ||
    result.sources[0]?.category !== "identity"
  )
    throw new Error("OpenFIGI evidence trust labels are invalid");
  if (
    result.selected?.retrievedAt !== result.retrievedAt ||
    result.selected.serverRespondedAt !== result.serverRespondedAt ||
    result.candidates.some(
      (candidate) =>
        candidate.retrievedAt !== result.retrievedAt ||
        candidate.serverRespondedAt !== result.serverRespondedAt,
    )
  )
    throw new Error("OpenFIGI instrument time provenance is incomplete");
} else if (
  result.status !== "rate_limited" ||
  result.selected ||
  result.canonicalFigi ||
  result.sources.length ||
  !result.warnings.some((warning) => warning.includes("no ticker-to-FIGI join"))
) {
  throw new Error(`OpenFIGI live mapping failed with status ${result.status}`);
}

console.log(
  JSON.stringify(
    {
      status: result.status,
      keyStatus: result.keyStatus,
      canonicalFigi: result.canonicalFigi,
      matchQuality: result.matchQuality,
      selected: result.selected
        ? {
            ticker: result.selected.ticker,
            name: result.selected.name,
            figi: result.selected.figi,
            compositeFigi: result.selected.compositeFigi,
          }
        : null,
      candidates: result.candidateCount,
      evidence: result.sources.length,
      warnings: result.warnings,
      retrievedAt: result.retrievedAt,
      serverRespondedAt: result.serverRespondedAt,
      asOf: result.asOf,
    },
    null,
    2,
  ),
);
