export type RiskReservationTerminalStatus = "filled" | "rejected" | "canceled";

export const workingBrokerOrderStatuses = new Set([
  "new",
  "accepted",
  "pending_new",
  "pending_replace",
  "accepted_for_bidding",
  "partially_filled",
  "held",
  "calculated",
  "stopped",
]);

const canceledBrokerOrderStatuses = new Set([
  "canceled",
  "expired",
  "replaced",
]);

export function riskReservationStatusForBrokerStatus(
  status: unknown,
): RiskReservationTerminalStatus | null {
  const value = String(status ?? "");
  if (value === "filled") return "filled";
  if (value === "rejected") return "rejected";
  return canceledBrokerOrderStatuses.has(value) ? "canceled" : null;
}
