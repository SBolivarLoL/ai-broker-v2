import { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { getComparableValuations } from "../src/research";

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const table = await getComparableValuations(alpaca, "AAPL", ["MSFT"]);
if (!table.rows.some(row => row.symbol === "AAPL" && row.subject) || !table.rows.some(row => row.symbol === "MSFT" && !row.subject)) throw new Error("Comparable valuation did not return the subject and peer");
for (const row of table.rows) {
  if (!Number.isFinite(row.price) || row.price <= 0) throw new Error(`${row.symbol} has no valid broker price`);
  if (!table.sources.some(source => source.id === row.evidence.sec && source.authority === "official")) throw new Error(`${row.symbol} SEC evidence is missing`);
  if (!table.sources.some(source => source.id === row.evidence.price && source.authority === "regulated_broker")) throw new Error(`${row.symbol} price evidence is missing`);
  if (!table.sources.some(source => source.id === row.evidence.valuation && source.authority === "derived")) throw new Error(`${row.symbol} valuation evidence is missing`);
}

console.log(JSON.stringify({
  subject: table.subject,
  peers: table.peers,
  rows: table.rows.map(row => ({
    symbol: row.symbol,
    price: row.price,
    marketCap: row.marketCap,
    annualRevenue: row.annualRevenue,
    revenueGrowthPercent: row.revenueGrowthPercent,
    netMarginPercent: row.netMarginPercent,
    priceToSales: row.priceToSales,
    priceToEarnings: row.priceToEarnings,
    priceToBook: row.priceToBook,
    warnings: row.warnings,
  })),
  warnings: table.warnings,
  evidence: table.sources.length,
  asOf: table.asOf,
}, null, 2));
