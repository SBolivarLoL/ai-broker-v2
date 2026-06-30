import { expect, test } from "bun:test";
import { buildFixedIncomeResearchStatus } from "./fixed-income-research";

test("keeps fixed-income research unavailable without Broker API fixed-income access", () => {
  const status = buildFixedIncomeResearchStatus("2026-06-30T10:00:00.000Z");

  expect(status).toMatchObject({
    generatedAt: "2026-06-30T10:00:00.000Z",
    status: "unavailable",
    accountSupport: {
      currentClient: "alpaca_trading_api_paper",
      brokerApiPartnerRequired: true,
      enabledForThisAccount: false,
    },
  });
  expect(status.dataSupport.supportedProducts).toEqual(["U.S. Treasury Bills", "U.S. Corporate Bonds"]);
  expect(status.restrictions).toContain("Do not infer bond coverage from equity, option or crypto entitlements.");
  expect(status.requiredBeforeEnable).toContain("Broker API partner access with fixed-income products enabled.");
  expect(status.evidence[0]?.url).toBe("https://docs.alpaca.markets/us/docs/fixed-income");
});
