import { describe, expect, test } from "bun:test";
import { riskReservationStatusForBrokerStatus, workingBrokerOrderStatuses } from "../../backend/shared/broker-status";

describe("broker status mapping", () => {
  test("maps only terminal broker statuses to risk reservation outcomes", () => {
    expect(riskReservationStatusForBrokerStatus("filled")).toBe("filled");
    expect(riskReservationStatusForBrokerStatus("rejected")).toBe("rejected");
    for (const status of ["canceled", "expired", "replaced"]) {
      expect(riskReservationStatusForBrokerStatus(status)).toBe("canceled");
    }
  });

  test("leaves working and unknown statuses open", () => {
    for (const status of workingBrokerOrderStatuses) {
      expect(riskReservationStatusForBrokerStatus(status)).toBeNull();
    }
    expect(riskReservationStatusForBrokerStatus(undefined)).toBeNull();
    expect(riskReservationStatusForBrokerStatus("partially_canceled")).toBeNull();
  });
});
