export type FixedIncomeResearchStatus = {
  generatedAt: string;
  status: "unavailable";
  reason: string;
  accountSupport: {
    currentClient: "alpaca_trading_api_paper";
    brokerApiPartnerRequired: true;
    enabledForThisAccount: false;
  };
  dataSupport: {
    supportedProducts: string[];
    requiredEndpoints: string[];
    identifiers: string[];
  };
  restrictions: string[];
  requiredBeforeEnable: string[];
  evidence: { title: string; url: string; note: string }[];
};

export function buildFixedIncomeResearchStatus(generatedAt = new Date().toISOString()): FixedIncomeResearchStatus {
  return {
    generatedAt,
    status: "unavailable",
    reason: "Fixed-income research is gated because Alpaca fixed-income products are documented for Broker API partners, while this app uses a personal Alpaca paper Trading API account.",
    accountSupport: {
      currentClient: "alpaca_trading_api_paper",
      brokerApiPartnerRequired: true,
      enabledForThisAccount: false,
    },
    dataSupport: {
      supportedProducts: ["U.S. Treasury Bills", "U.S. Corporate Bonds"],
      requiredEndpoints: [
        "Broker API fixed-income asset endpoints",
        "Broker API fixed-income order and execution lifecycle",
        "Fixed-income pricing, yield, accrued-interest and settlement evidence",
      ],
      identifiers: ["CUSIP", "ISIN"],
    },
    restrictions: [
      "Do not infer bond coverage from equity, option or crypto entitlements.",
      "Do not create synthetic yield, duration, credit or accrued-interest data from stock market feeds.",
      "Do not enable fixed-income orders without Broker API partner access and technical sign-off.",
    ],
    requiredBeforeEnable: [
      "Broker API partner access with fixed-income products enabled.",
      "Tradable asset inventory for Treasuries and corporate bonds with CUSIP/ISIN provenance.",
      "Clean price, accrued interest, yield, settlement and liquidity evidence from an approved fixed-income source.",
      "Compliance and disclosure review for fixed-income risk, liquidity, credit, settlement and markup language.",
    ],
    evidence: [{
      title: "Alpaca fixed income documentation",
      url: "https://docs.alpaca.markets/us/docs/fixed-income",
      note: "Alpaca documents fixed income as U.S. Treasury Bills and U.S. Corporate Bonds available through the Broker API for partners.",
    }],
  };
}
