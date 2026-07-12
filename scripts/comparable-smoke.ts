import { Alpaca } from "@alpacahq/alpaca-ts-alpha";
import { getComparableValuations } from "../backend/features/research/research";

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const table = await getComparableValuations(alpaca, "AAPL", ["MSFT"]);
if (table.schemaVersion !== "comparable-valuations-v3")
  throw new Error("Comparable valuation response schema is outdated");
if (
  !table.rows.some((row) => row.symbol === "AAPL" && row.subject) ||
  !table.rows.some((row) => row.symbol === "MSFT" && !row.subject)
)
  throw new Error("Comparable valuation did not return the subject and peer");
for (const row of table.rows) {
  if (!Number.isFinite(row.price) || row.price <= 0)
    throw new Error(`${row.symbol} has no valid broker price`);
  if (
    !table.sources.some(
      (source) =>
        source.id === row.evidence.sec && source.authority === "official",
    )
  )
    throw new Error(`${row.symbol} SEC evidence is missing`);
  if (
    !table.sources.some(
      (source) =>
        source.id === row.evidence.price &&
        source.authority === "regulated_broker" &&
        source.observedAt === null &&
        source.retrievedAt !== null,
    )
  )
    throw new Error(
      `${row.symbol} price evidence must preserve retrieval without inventing observation`,
    );
  if (
    !table.sources.some(
      (source) =>
        source.id === row.evidence.valuation && source.authority === "derived",
    )
  )
    throw new Error(`${row.symbol} valuation evidence is missing`);
}
if (
  table.quality.expected.companies !== 2 ||
  table.quality.received.companies !== 2 ||
  table.quality.expected.marketPriceObservations !== 2 ||
  table.quality.received.marketPriceObservations !== 0 ||
  table.quality.freshness.status !== "retrieval_time_only"
)
  throw new Error("Comparable valuation coverage is incomplete or misleading");

console.log(
  JSON.stringify(
    {
      subject: table.subject,
      peers: table.peers,
      schemaVersion: table.schemaVersion,
      rows: table.rows.length,
      evidenceRecords: table.sources.length,
      coverageStatus: table.quality.status,
      expected: table.quality.expected,
      received: table.quality.received,
      omitted: table.quality.omitted,
      freshness: table.quality.freshness.status,
      serverRespondedAt: table.serverRespondedAt,
    },
    null,
    2,
  ),
);
