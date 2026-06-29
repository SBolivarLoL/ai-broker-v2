import { getFinnhubCompanyEnrichment } from "../src/finnhub";

const result = await getFinnhubCompanyEnrichment("AAPL");
const keyConfigured = Boolean(process.env.FINNHUB_API_KEY?.trim());
if (!keyConfigured) {
  if (result.configured || result.status !== "missing_key" || result.sources.length) throw new Error("Finnhub missing-key fallback is invalid");
} else {
  if (!result.configured) throw new Error("Configured Finnhub key was not accepted");
  if (!result.profile && !result.earnings.length && !result.news.length) throw new Error("Configured Finnhub returned no usable profile, earnings, or news enrichment");
  if (result.sources.some(source => source.authority !== "licensed_provider")) throw new Error("Finnhub evidence authority is invalid");
  if (result.sources.some(source => source.category === "news" ? source.claimStatus !== "media_signal" : source.claimStatus !== "provider_record")) throw new Error("Finnhub evidence claim labels are invalid");
  if (JSON.stringify(result).includes(process.env.FINNHUB_API_KEY!.trim())) throw new Error("Finnhub API key leaked into normalized output");
}

console.log(JSON.stringify({
  status: result.status,
  configured: result.configured,
  coverage: result.coverage,
  profile: result.profile?.name ?? null,
  earnings: result.earnings.length,
  news: result.news.length,
  evidence: result.sources.length,
  warnings: result.warnings,
  asOf: result.asOf,
}, null, 2));
