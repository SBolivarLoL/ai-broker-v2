import { getOfficialMacroContext } from "../backend/integrations/macro-context";

const context = await getOfficialMacroContext();
for (const provider of ["treasury", "bls"] as const) {
  if (context.coverage[provider].status !== "available")
    throw new Error(`${provider} public macro coverage is unavailable`);
}
if (process.env.FRED_API_KEY && context.coverage.fred.status !== "available")
  throw new Error("Configured FRED macro coverage is unavailable");
if (process.env.BEA_USER_ID && context.coverage.bea.status !== "available")
  throw new Error("Configured BEA macro coverage is unavailable");
if (
  !context.indicators.length ||
  context.sources.some(
    (source) => source.authority !== "official" || source.category !== "macro",
  )
)
  throw new Error("Macro evidence contract is invalid");
if (
  context.regime.evidence.some(
    (id) => !context.sources.some((source) => source.id === id),
  )
)
  throw new Error("Macro regime cites unknown evidence");

console.log(
  JSON.stringify(
    {
      asOf: context.asOf,
      coverage: context.coverage,
      indicators: context.indicators.map((item) => ({
        id: item.id,
        value: item.value,
        unit: item.unit,
        period: item.period,
        evidenceId: item.evidenceId,
      })),
      regime: context.regime.summary,
      warnings: context.warnings,
    },
    null,
    2,
  ),
);
