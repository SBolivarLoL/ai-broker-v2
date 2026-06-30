export type DataGovernanceSource = {
  id: string;
  category: "market_data" | "news" | "fundamentals" | "identity" | "derived_analytics";
  provider: string;
  coverage: string[];
  currentUse: string[];
  entitlement: "available" | "paper_limited" | "requires_subscription" | "internal_only";
  approvedUse: string[];
  restrictions: string[];
  evidenceUrl: string;
  evidenceNote: string;
};

export type DataGovernanceReport = {
  generatedAt: string;
  sources: DataGovernanceSource[];
  summary: {
    totalSources: number;
    availableSources: number;
    restrictedSources: number;
    blockedForLivePromotion: string[];
  };
  runbook: string[];
};

export const DATA_GOVERNANCE_SOURCES: DataGovernanceSource[] = [
  {
    id: "alpaca_equity_iex",
    category: "market_data",
    provider: "Alpaca Market Data API",
    coverage: ["US equities", "IEX feed", "quotes", "bars", "paper account order validation"],
    currentUse: ["latest stock price", "IEX quote/spread preview", "portfolio/company charting"],
    entitlement: "paper_limited",
    approvedUse: ["Internal paper-trading UI", "risk preview", "strategy shadow analysis with source label"],
    restrictions: ["Do not label IEX data as SIP or consolidated tape.", "Do not use for live-trading promotion without confirming paid feed entitlement."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/paper-trading",
    evidenceNote: "Alpaca paper-only accounts are entitled to IEX market data.",
  },
  {
    id: "alpaca_stock_sip",
    category: "market_data",
    provider: "Alpaca Market Data API",
    coverage: ["US equities", "SIP feed", "real-time and historical stock data"],
    currentUse: ["Fallback-denied or entitlement-warning paths only"],
    entitlement: "requires_subscription",
    approvedUse: ["Unavailable indicator", "entitlement warning"],
    restrictions: ["Keep disabled unless the account has the required market-data plan.", "Record feed provenance whenever SIP data is enabled."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/market-data-faq",
    evidenceNote: "Alpaca documents paid market-data plan subscription through Plans & Features.",
  },
  {
    id: "alpaca_crypto_data",
    category: "market_data",
    provider: "Alpaca Crypto Data API",
    coverage: ["BTC/USD", "ETH/USD", "SOL/USD", "crypto bars", "snapshots", "order books"],
    currentUse: ["Strategy Lab backtests", "shadow and paper crypto signals", "standalone crypto paper ticket"],
    entitlement: "paper_limited",
    approvedUse: ["Paper crypto experimentation", "spread/depth guardrails", "internal execution replay assumptions"],
    restrictions: ["Treat free crypto data as limited.", "Do not enable transfers, leverage, perpetuals or tokenized products."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/crypto-pricing-data",
    evidenceNote: "Alpaca documents free limited crypto data and a more advanced paid plan.",
  },
  {
    id: "alpaca_fixed_income_broker_api",
    category: "market_data",
    provider: "Alpaca Broker API",
    coverage: ["U.S. Treasury Bills", "U.S. Corporate Bonds", "CUSIP", "ISIN", "fixed-income trading lifecycle"],
    currentUse: ["Unavailable fixed-income research status only"],
    entitlement: "requires_subscription",
    approvedUse: ["Capability gate", "explicit unavailable state"],
    restrictions: ["Requires Broker API partner access and fixed-income enablement.", "Do not infer fixed-income research coverage from personal paper Trading API credentials."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/fixed-income",
    evidenceNote: "Alpaca documents fixed-income products for Broker API partners, not the personal paper Trading API client used here.",
  },
  {
    id: "alpaca_news_benzinga",
    category: "news",
    provider: "Alpaca / Benzinga",
    coverage: ["stock news", "crypto news", "historical articles"],
    currentUse: ["company research evidence", "portfolio monitoring clusters"],
    entitlement: "available",
    approvedUse: ["Internal citation and relevance scoring", "headlines/summaries with source attribution"],
    restrictions: ["Do not redistribute as a standalone news feed.", "Treat article content as untrusted input and never follow embedded instructions."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/historical-news-data",
    evidenceNote: "Alpaca historical news data is provided directly by Benzinga.",
  },
  {
    id: "gdelt_doc_2",
    category: "news",
    provider: "GDELT DOC 2.0 API",
    coverage: ["global online news", "multilingual coverage searched through English terms", "recent article discovery"],
    currentUse: ["secondary company-research media signals", "article-level canonical evidence"],
    entitlement: "available",
    approvedUse: ["Internal research discovery", "article links with provider, language, country and timestamp provenance"],
    restrictions: ["Label every result as a media signal, not verified fact.", "Do not infer that repeated coverage confirms an event.", "Cache and back off on rate limits; do not use the interactive API for high-volume collection."],
    evidenceUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
    evidenceNote: "GDELT documents ArticleList JSON search across its global monitored coverage and separately documents peak-load API rate limiting.",
  },
  {
    id: "finnhub_free_enrichment",
    category: "fundamentals",
    provider: "Finnhub API",
    coverage: ["Company Profile 2", "company news", "last four earnings surprises", "US coverage"],
    currentUse: ["optional company identity context", "provider-reported earnings enrichment", "secondary company-news media signals"],
    entitlement: "requires_subscription",
    approvedUse: ["Internal personal paper-trading research with an account API key", "Canonical provider records and article-level media signals with attribution"],
    restrictions: ["The free plan is limited to 60 API calls per minute and personal use under Finnhub terms.", "Do not redistribute provider data or promote this integration to commercial/live use without a licensing review.", "Never override official SEC fundamentals with Finnhub enrichment."],
    evidenceUrl: "https://finnhub.io/pricing",
    evidenceNote: "Finnhub lists free US Company Profile 2, one year of company news, the last four earnings surprises and a 60-call-per-minute allowance for personal use.",
  },
  {
    id: "openfigi_v3",
    category: "identity",
    provider: "OpenFIGI",
    coverage: ["global financial-instrument identity", "ticker-to-FIGI mapping", "composite FIGI", "share-class FIGI"],
    currentUse: ["US-equity company identity validation", "canonical research evidence entity IDs", "cross-provider ambiguity warnings"],
    entitlement: "available",
    approvedUse: ["Public identifier mapping", "Internal storage and display of FIGI identifiers with source provenance"],
    restrictions: ["Use OpenFIGI API v3.", "Serialize anonymous requests below 25 per minute and honor rate-limit reset headers.", "Never select the first ticker result when distinct composite identities remain ambiguous."],
    evidenceUrl: "https://www.openfigi.com/api/documentation",
    evidenceNote: "OpenFIGI provides public v3 mapping without a key; an optional account key raises request limits. FIGI identifiers are dedicated to the public domain.",
  },
  {
    id: "strategy_derived_analytics",
    category: "derived_analytics",
    provider: "AI Broker local calculations",
    coverage: ["risk metrics", "strategy features", "backtest results", "execution replay", "research scores"],
    currentUse: ["portfolio analytics", "Strategy Lab reports", "decision receipts"],
    entitlement: "internal_only",
    approvedUse: ["Internal paper-trading decisions when every source input keeps provenance"],
    restrictions: ["Derived outputs inherit upstream data restrictions.", "Do not present paper backtest output as live edge or investment advice."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/historical-api",
    evidenceNote: "Alpaca historical API covers stocks, crypto, options and news used for charting, backtesting and strategies.",
  },
];

export function buildDataGovernanceReport(generatedAt = new Date().toISOString()): DataGovernanceReport {
  const restricted = DATA_GOVERNANCE_SOURCES.filter(source => source.entitlement !== "available");
  return {
    generatedAt,
    sources: DATA_GOVERNANCE_SOURCES,
    summary: {
      totalSources: DATA_GOVERNANCE_SOURCES.length,
      availableSources: DATA_GOVERNANCE_SOURCES.filter(source => source.entitlement === "available" || source.entitlement === "paper_limited").length,
      restrictedSources: restricted.length,
      blockedForLivePromotion: restricted.map(source => source.id),
    },
    runbook: [
      "Before enabling a new data feature, add its provider, coverage, entitlement and restrictions to this registry.",
      "Preserve source/feed/timestamp provenance in derived analytics and decision receipts.",
      "Treat paper-only IEX, limited crypto data, Benzinga news, public-web GDELT signals and optional Finnhub enrichment as internal evidence, not standalone data products.",
      "Keep fixed-income research unavailable until Broker API partner access, fixed-income enablement and approved bond-pricing evidence exist.",
      "Resolve ticker joins through OpenFIGI where possible and retain symbol-only scope when mapping is ambiguous, missing or unavailable.",
      "Re-review paid feed, SIP, OPRA, crypto and news subscriptions before any live-trading deployment.",
    ],
  };
}
