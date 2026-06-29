import { z } from "zod";
import type { ComparableValuationEvidence, ComparableValuationRow } from "./comparable-valuation";
import { canonicalEvidence, dedupeEvidence, type CanonicalEvidence } from "./evidence";

const Assumption = z.object({
  revenueGrowthPercent: z.number().finite().min(-99).max(200),
  netMarginPercent: z.number().finite().min(-100).max(100),
  priceToEarnings: z.number().finite().min(0.1).max(200),
});

const cases = ["bear", "base", "bull"] as const;
const metrics = ["revenueGrowthPercent", "netMarginPercent", "priceToEarnings"] as const;
const metricLabels = { revenueGrowthPercent: "revenue growth", netMarginPercent: "net margin", priceToEarnings: "P/E" } as const;
export const ValuationScenarioInput = z.object({ bear: Assumption, base: Assumption, bull: Assumption }).superRefine((value, context) => {
  for (const metric of metrics) {
    if (value.bear[metric] <= value.base[metric] && value.base[metric] <= value.bull[metric]) continue;
    context.addIssue({ code: "custom", path: [metric], message: `Bear, base and bull ${metricLabels[metric]} assumptions must be ordered from low to high` });
  }
});

const round = (value: number) => Number(value.toFixed(6));
const label = (scenario: typeof cases[number]) => scenario[0].toUpperCase() + scenario.slice(1);
type ScenarioEvidence = CanonicalEvidence<unknown, "fundamentals" | "market" | "valuation">;

export function buildValuationScenarioMemo(
  row: ComparableValuationRow,
  sources: ComparableValuationEvidence[],
  rawAssumptions: unknown,
  retrievedAt = new Date().toISOString(),
) {
  const assumptions = ValuationScenarioInput.parse(rawAssumptions);
  const asOf = new Date(retrievedAt).toISOString();
  const evidenceId = `valuation:scenarios:${row.symbol}:${asOf}`;
  const inputEvidence = [row.evidence.sec, row.evidence.price];
  const warnings = ["These are user-entered assumptions, not company guidance or predictions."];
  if (row.annualRevenue === null || row.annualRevenue <= 0) warnings.push("Directly reported annual SEC revenue is unavailable or non-positive.");
  if (row.sharesOutstanding === null || row.sharesOutstanding <= 0) warnings.push("Latest SEC shares outstanding are unavailable or non-positive.");
  if (row.sharesOutstanding !== null) warnings.push("Latest SEC shares outstanding do not model future dilution, every share class or ADR conversion terms.");

  const scenarios = cases.map(scenario => {
    const input = assumptions[scenario];
    const projectedRevenue = row.annualRevenue !== null && row.annualRevenue > 0 ? round(row.annualRevenue * (1 + input.revenueGrowthPercent / 100)) : null;
    const projectedNetIncome = projectedRevenue !== null ? round(projectedRevenue * input.netMarginPercent / 100) : null;
    const impliedMarketCap = projectedNetIncome !== null && projectedNetIncome > 0 ? round(projectedNetIncome * input.priceToEarnings) : null;
    const impliedPrice = impliedMarketCap !== null && row.sharesOutstanding !== null && row.sharesOutstanding > 0 ? round(impliedMarketCap / row.sharesOutstanding) : null;
    const returnPercent = impliedPrice !== null ? round((impliedPrice / row.price - 1) * 100) : null;
    const assumptionText = `${label(scenario)} assumes ${input.revenueGrowthPercent}% revenue growth, ${input.netMarginPercent}% net margin and a ${input.priceToEarnings}x P/E after 12 months.`;
    const memo = impliedPrice === null
      ? `${assumptionText} A mechanical implied price is unavailable because the source inputs or projected earnings are not positive.`
      : `${assumptionText} Applied to the latest annual SEC revenue and SEC shares outstanding, the model implies $${impliedPrice.toFixed(2)} per share, ${returnPercent! >= 0 ? "+" : ""}${returnPercent!.toFixed(1)}% versus the current Alpaca IEX price.`;
    return { case: scenario, horizonMonths: 12, assumptions: input, projectedRevenue, projectedNetIncome, impliedMarketCap, impliedPrice, returnPercent, status: impliedPrice === null ? "unavailable" as const : "available" as const, memo, evidence: [...inputEvidence, evidenceId] };
  });

  const formulas = {
    projectedRevenue: "latest annual SEC revenue * (1 + user revenue growth assumption)",
    projectedNetIncome: "projected revenue * user net margin assumption",
    impliedMarketCap: "positive projected net income * user P/E assumption",
    impliedPrice: "implied market cap / latest SEC shares outstanding",
    returnPercent: "(implied price / current Alpaca IEX price - 1) * 100",
  };
  const sourceUrl = sources.find(source => source.id === row.evidence.sec)?.url ?? "https://www.sec.gov/edgar";
  const scenarioSource = canonicalEvidence({
    id: evidenceId, provider: "ai-broker", sourceId: `${row.symbol}:scenarios:${asOf}`, category: "valuation", authority: "derived", claimStatus: "derived_analysis",
    title: `${row.symbol} user-assumption valuation scenarios`, url: sourceUrl, asOf, retrievedAt: asOf, entityIds: { symbol: row.symbol },
    data: { symbol: row.symbol, horizonMonths: 12, assumptionSource: "user-entered", assumptions, scenarios, formulas, inputs: inputEvidence },
  });
  const selectedSources = sources.filter(source => inputEvidence.includes(source.id));
  const deduped = dedupeEvidence([...selectedSources, scenarioSource] as ScenarioEvidence[]);
  return {
    symbol: row.symbol, companyName: row.companyName, currentPrice: row.price,
    baseline: { annualRevenue: row.annualRevenue, netMarginPercent: row.netMarginPercent, priceToEarnings: row.priceToEarnings, sharesOutstanding: row.sharesOutstanding, periods: row.periods },
    scenarios, sources: deduped.records, warnings: [...new Set(warnings)], formulas, asOf,
  };
}
