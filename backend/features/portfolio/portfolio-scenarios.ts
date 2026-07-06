/**
 * Deterministic portfolio stress scenarios with SIC-aware shocks and optional
 * user-supplied asset-class/sector overrides.
 */
import { z } from "zod";

export type PortfolioScenarioPosition = {
  symbol: string;
  marketValue: number;
  assetClass: string;
  sector?: string | null;
  sic?: string | null;
  volatility20dPercent?: number | null;
};

const CustomShock = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9./-]{1,15}$/),
  shockPercent: z.coerce.number().finite().min(-100).max(100),
});

export const CustomPortfolioScenario = z.object({
  name: z.string().trim().min(1).max(60).default("Custom shocks"),
  shocks: z.array(CustomShock).min(1).max(20),
}).superRefine((scenario, context) => {
  const symbols = scenario.shocks.map(shock => shock.symbol);
  if (new Set(symbols).size !== symbols.length) context.addIssue({ code: "custom", message: "A custom scenario may contain only one shock per symbol" });
});

export type CustomPortfolioScenario = z.infer<typeof CustomPortfolioScenario>;

const rateShockBySector: Record<string, number> = {
  "Agriculture, forestry and fishing": -4,
  Mining: -3,
  Construction: -9,
  Manufacturing: -7,
  "Transportation, communications and utilities": -8,
  "Wholesale trade": -5,
  "Retail trade": -6,
  "Finance, insurance and real estate": -10,
  Services: -8,
  "Public administration": -4,
  "Nonclassifiable establishments": -6,
};

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

export function isTechnologySic(rawSic: string | null | undefined) {
  const sic = Number(rawSic);
  return Number.isInteger(sic) && [[3570, 3579], [3660, 3679], [4810, 4899], [7370, 7379]].some(([start, end]) => sic >= start! && sic <= end!);
}

function scenarioResult(input: {
  id: string;
  name: string;
  description: string;
  assumptions: string[];
  equity: number;
  positions: PortfolioScenarioPosition[];
  shock: (position: PortfolioScenarioPosition) => { percent: number | null; rationale: string };
}) {
  const investedGross = input.positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  const positions = input.positions.map(position => {
    const applied = input.shock(position);
    const estimatedPnl = applied.percent === null ? null : round(position.marketValue * applied.percent / 100, 2);
    return { ...position, shockPercent: applied.percent, estimatedPnl, rationale: applied.rationale };
  });
  const coveredGross = positions.filter(position => position.shockPercent !== null).reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  const estimatedPnl = round(positions.reduce((sum, position) => sum + (position.estimatedPnl ?? 0), 0), 2);
  const coveragePercent = investedGross ? round(coveredGross / investedGross * 100) : 0;
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    assumptions: input.assumptions,
    estimatedPnl,
    estimatedLoss: round(Math.max(0, -estimatedPnl), 2),
    resultingEquity: round(input.equity + estimatedPnl, 2),
    equityImpactPercent: round(estimatedPnl / input.equity * 100),
    coveragePercent,
    positions: positions.sort((left, right) => Math.abs(right.estimatedPnl ?? 0) - Math.abs(left.estimatedPnl ?? 0) || left.symbol.localeCompare(right.symbol)),
  };
}

export function buildPortfolioScenarioReport(input: {
  equity: number;
  positions: PortfolioScenarioPosition[];
  custom?: CustomPortfolioScenario;
  asOf?: string;
}) {
  if (!Number.isFinite(input.equity) || input.equity <= 0) throw new Error("Valid portfolio equity is required");
  if (input.positions.some(position => !position.symbol || !Number.isFinite(position.marketValue))) throw new Error("Scenario positions must have a symbol and finite market value");
  const scenarios = [
    scenarioResult({
      id: "rates_up_200bp",
      name: "Rates +200 bps",
      description: "Illustrative parallel rate increase using broad SEC SIC division sensitivities.",
      assumptions: Object.entries(rateShockBySector).map(([sector, shock]) => `${sector}: ${shock}%`),
      equity: input.equity,
      positions: input.positions,
      shock: position => position.assetClass !== "US equity"
        ? { percent: null, rationale: `${position.assetClass} is outside this equity scenario.` }
        : position.sector && rateShockBySector[position.sector] !== undefined
          ? { percent: rateShockBySector[position.sector]!, rationale: `${position.sector} illustrative rate sensitivity.` }
          : { percent: null, rationale: "No usable SEC SIC division." },
    }),
    scenarioResult({
      id: "technology_crash",
      name: "Technology crash",
      description: "Technology SIC industries fall 25%; other classified US equities fall 8%.",
      assumptions: ["Technology SIC ranges 3570-3579, 3660-3679, 4810-4899 and 7370-7379: -25%", "Other classified US equities: -8%"],
      equity: input.equity,
      positions: input.positions,
      shock: position => position.assetClass !== "US equity"
        ? { percent: null, rationale: `${position.assetClass} is outside this equity scenario.` }
        : !position.sic
          ? { percent: null, rationale: "No usable SEC SIC classification." }
          : isTechnologySic(position.sic)
            ? { percent: -25, rationale: `SEC SIC ${position.sic} is in the defined technology set.` }
            : { percent: -8, rationale: `SEC SIC ${position.sic} receives the broad equity shock.` },
    }),
    scenarioResult({
      id: "volatility_spike",
      name: "Volatility spike",
      description: "One-day three-sigma downside using each position's annualized 20-session realized volatility.",
      assumptions: ["Shock = -3 x annualized volatility / sqrt(252)", "Per-position downside is capped at -35%"],
      equity: input.equity,
      positions: input.positions,
      shock: position => Number.isFinite(position.volatility20dPercent)
        ? { percent: round(-Math.min(35, 3 * Number(position.volatility20dPercent) / Math.sqrt(252))), rationale: "Three-sigma downside from recent realized volatility." }
        : { percent: null, rationale: "20-session realized volatility is unavailable." },
    }),
  ];

  if (input.custom) {
    const shockBySymbol = new Map(input.custom.shocks.map(shock => [shock.symbol, shock.shockPercent]));
    const held = new Set(input.positions.map(position => position.symbol));
    const unknown = [...shockBySymbol.keys()].filter(symbol => !held.has(symbol));
    if (unknown.length) throw new Error(`Custom shocks must reference held symbols: ${unknown.join(", ")}`);
    scenarios.unshift(scenarioResult({
      id: "custom",
      name: input.custom.name,
      description: "User-entered shocks applied only to the named current positions.",
      assumptions: input.custom.shocks.map(shock => `${shock.symbol}: ${shock.shockPercent}%`),
      equity: input.equity,
      positions: input.positions,
      shock: position => shockBySymbol.has(position.symbol)
        ? { percent: shockBySymbol.get(position.symbol)!, rationale: "Explicit user-entered symbol shock." }
        : { percent: 0, rationale: "No custom shock entered; position held unchanged." },
    }));
  }

  const coverageWarnings = scenarios.filter(scenario => scenario.coveragePercent < 100).map(scenario => `${scenario.name} covers ${scenario.coveragePercent}% of gross invested exposure; uncovered positions contribute zero.`);
  return {
    asOf: new Date(input.asOf ?? Date.now()).toISOString(),
    scenarios,
    warnings: [
      "Scenario shocks are deterministic illustrations, not forecasts or probability estimates.",
      "Linear market-value shocks do not model option convexity, liquidity, taxes, correlation changes or path-dependent losses.",
      ...coverageWarnings,
    ],
  };
}
