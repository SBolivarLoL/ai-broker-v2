import { getGdeltCompanySignals } from "../backend/integrations/gdelt";

const result = await getGdeltCompanySignals("AAPL", "Apple Inc.");
if (result.available) {
  if (result.sources.length !== result.articles.length)
    throw new Error(
      "GDELT article evidence count does not match normalized signals",
    );
  if (
    result.sources.some(
      (source) =>
        source.authority !== "public_web" ||
        source.claimStatus !== "media_signal" ||
        source.category !== "news",
    )
  )
    throw new Error("GDELT evidence trust labels are invalid");
  if (
    result.articles.some(
      (article) =>
        !result.sources.some((source) => source.id === article.evidenceId),
    )
  )
    throw new Error("GDELT article cites unknown evidence");
} else if (
  !result.rateLimited ||
  !result.warnings.some((warning) => warning.includes("no absence of events"))
) {
  throw new Error(
    "GDELT is unavailable without an explicit rate-limit fallback",
  );
}

console.log(
  JSON.stringify(
    {
      status: result.available ? "available" : "rate_limited",
      query: result.query,
      windowDays: result.windowDays,
      articles: result.articles.length,
      filteredOut: result.filteredOut,
      evidence: result.sources.length,
      warnings: result.warnings,
      asOf: result.asOf,
    },
    null,
    2,
  ),
);
