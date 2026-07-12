/**
 * Executable inventory of data entitlements, retention, redistribution, and
 * live-use constraints for every external source and stored output.
 */
export type DataGovernanceSource = {
  id: string;
  category: "broker_records" | "market_data" | "news" | "fundamentals" | "macro" | "identity" | "model_service" | "derived_analytics";
  provider: string;
  coverage: string[];
  currentUse: string[];
  entitlement: "available" | "paper_limited" | "requires_api_key" | "requires_subscription" | "requires_partner_access" | "internal_only";
  approvedUse: string[];
  restrictions: string[];
  evidenceUrl: string;
  evidenceNote: string;
  termsUrl: string | null;
  termsStatus: "official_api_terms" | "public_access_policy" | "account_terms_external_review_required" | "internal_policy";
  retentionDecision: "transient_cache_only" | "persist_with_provenance" | "persist_public_identifier" | "internal_record";
  redistributionDecision: "blocked" | "attribution_required" | "public_identifiers_allowed";
  liveUseDecision: "blocked" | "external_review_required" | "internal_only";
  storedOutputIds: string[];
};

export type StoredOutputCategory = {
  id: string;
  tables: string[];
  contents: string[];
  sourceIds: string[];
  retentionDecision: "application_lifetime" | "until_manual_deletion" | "until_replaced_or_deleted" | "retention_metadata_without_automatic_purge";
  redistributionDecision: "internal_only";
  liveUseDecision: "paper_only" | "operations_only";
};

export type DataGovernanceReport = {
  generatedAt: string;
  sources: DataGovernanceSource[];
  storedOutputs: StoredOutputCategory[];
  summary: {
    totalSources: number;
    availableSources: number;
    restrictedSources: number;
    blockedForLivePromotion: string[];
    storedOutputCategories: number;
    termsExternalReviewRequired: string[];
  };
  runbook: string[];
};

export const DATA_GOVERNANCE_SOURCES: DataGovernanceSource[] = [
  {
    id: "alpaca_paper_trading",
    category: "broker_records",
    provider: "Alpaca Trading API",
    coverage: ["paper account", "positions", "orders", "activities", "watchlists", "clock", "calendar"],
    currentUse: ["paper-account state", "order submission and reconciliation", "account activity ledger"],
    entitlement: "paper_limited",
    approvedUse: ["Internal paper-trading operations", "risk and reconciliation evidence"],
    restrictions: ["Paper account only; no live client exists.", "Do not redistribute account, order or activity records.", "External legal and broker review is required before any live use."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/paper-trading",
    evidenceNote: "Alpaca documents paper trading as a simulation that does not model every live-market behavior.",
    termsUrl: "https://files.alpaca.markets/disclosures/alpaca_terms_and_conditions.pdf",
    termsStatus: "account_terms_external_review_required",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["order_authority", "advisor_plans", "trade_journal", "broker_account_ledger", "portfolio_snapshots", "strategy_experiments"],
  },
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
    termsUrl: "https://files.alpaca.markets/disclosures/alpaca_terms_and_conditions.pdf",
    termsStatus: "account_terms_external_review_required",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["order_authority", "advisor_plans", "trade_journal", "research_runs", "portfolio_snapshots"],
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
    termsUrl: "https://files.alpaca.markets/disclosures/alpaca_terms_and_conditions.pdf",
    termsStatus: "account_terms_external_review_required",
    retentionDecision: "transient_cache_only",
    redistributionDecision: "blocked",
    liveUseDecision: "blocked",
    storedOutputIds: [],
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
    termsUrl: "https://files.alpaca.markets/disclosures/alpaca_terms_and_conditions.pdf",
    termsStatus: "account_terms_external_review_required",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["order_authority", "strategy_experiments"],
  },
  {
    id: "alpaca_fixed_income_broker_api",
    category: "market_data",
    provider: "Alpaca Broker API",
    coverage: ["U.S. Treasury Bills", "U.S. Corporate Bonds", "CUSIP", "ISIN", "fixed-income trading lifecycle"],
    currentUse: ["Unavailable fixed-income research status only"],
    entitlement: "requires_partner_access",
    approvedUse: ["Capability gate", "explicit unavailable state"],
    restrictions: ["Requires Broker API partner access and fixed-income enablement.", "Do not infer fixed-income research coverage from personal paper Trading API credentials."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/fixed-income",
    evidenceNote: "Alpaca documents fixed-income products for Broker API partners, not the personal paper Trading API client used here.",
    termsUrl: "https://files.alpaca.markets/disclosures/alpaca_terms_and_conditions.pdf",
    termsStatus: "account_terms_external_review_required",
    retentionDecision: "transient_cache_only",
    redistributionDecision: "blocked",
    liveUseDecision: "blocked",
    storedOutputIds: [],
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
    termsUrl: "https://files.alpaca.markets/disclosures/alpaca_terms_and_conditions.pdf",
    termsStatus: "account_terms_external_review_required",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["advisor_plans", "research_runs"],
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
    termsUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
    termsStatus: "public_access_policy",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["research_runs"],
  },
  {
    id: "finnhub_free_enrichment",
    category: "fundamentals",
    provider: "Finnhub API",
    coverage: ["Company Profile 2", "company news", "last four earnings surprises", "US coverage"],
    currentUse: ["optional company identity context", "provider-reported earnings enrichment", "secondary company-news media signals"],
    entitlement: "requires_api_key",
    approvedUse: ["Internal personal paper-trading research with an account API key", "Canonical provider records and article-level media signals with attribution"],
    restrictions: ["The free plan is limited to 60 API calls per minute and personal use under Finnhub terms.", "Do not redistribute provider data or promote this integration to commercial/live use without a licensing review.", "Never override official SEC fundamentals with Finnhub enrichment."],
    evidenceUrl: "https://finnhub.io/pricing",
    evidenceNote: "Finnhub lists free US Company Profile 2, one year of company news, the last four earnings surprises and a 60-call-per-minute allowance for personal use.",
    termsUrl: "https://finnhub.io/pricing",
    termsStatus: "account_terms_external_review_required",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["research_runs"],
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
    termsUrl: "https://www.openfigi.com/docs/terms-of-service",
    termsStatus: "official_api_terms",
    retentionDecision: "persist_public_identifier",
    redistributionDecision: "public_identifiers_allowed",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["research_runs"],
  },
  {
    id: "sec_edgar",
    category: "fundamentals",
    provider: "U.S. SEC EDGAR",
    coverage: ["company submissions", "XBRL company facts", "10-K", "10-Q", "8-K", "SEC SIC"],
    currentUse: ["company fundamentals", "filing evidence", "material-event monitoring", "industry classification"],
    entitlement: "available",
    approvedUse: ["Internal research with accession, CIK, observation and retrieval provenance"],
    restrictions: ["Identify the application and monitored contact in SEC_USER_AGENT.", "Stay below the SEC fair-access request limit and cache bounded requests.", "Do not treat a filing published later as point-in-time evidence for an earlier date."],
    evidenceUrl: "https://data.sec.gov/",
    evidenceNote: "The SEC provides free public API access and requires automated access to follow its privacy, security and fair-access policies.",
    termsUrl: "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
    termsStatus: "public_access_policy",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "attribution_required",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["research_runs", "portfolio_snapshots"],
  },
  {
    id: "treasury_fiscal_data",
    category: "macro",
    provider: "U.S. Treasury Fiscal Data",
    coverage: ["Debt to the Penny", "total public debt", "debt held by the public", "intragovernmental holdings"],
    currentUse: ["official fiscal context in company research"],
    entitlement: "available",
    approvedUse: ["Internal descriptive macro context with dataset and retrieval provenance"],
    restrictions: ["Treat revisions and observation dates as first-class evidence.", "Redistribution and live use remain blocked until an external terms review is recorded."],
    evidenceUrl: "https://fiscaldata.treasury.gov/api-documentation/",
    evidenceNote: "Treasury Fiscal Data documents a public REST API for published fiscal datasets.",
    termsUrl: "https://fiscaldata.treasury.gov/api-documentation/",
    termsStatus: "public_access_policy",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["research_runs"],
  },
  {
    id: "bls_public_data",
    category: "macro",
    provider: "U.S. Bureau of Labor Statistics",
    coverage: ["CPI-U", "unemployment rate", "published BLS time series"],
    currentUse: ["official inflation and labor context in company research"],
    entitlement: "available",
    approvedUse: ["Internal descriptive macro context with series, period and retrieval provenance"],
    restrictions: ["Cite the API retrieval date.", "State that BLS cannot vouch for analyses after retrieval.", "Do not use the BLS logo or imply endorsement."],
    evidenceUrl: "https://www.bls.gov/developers/",
    evidenceNote: "The BLS Public Data API provides published survey data and documents citation requirements for secondary use.",
    termsUrl: "https://www.bls.gov/developers/termsOfService.htm",
    termsStatus: "official_api_terms",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "attribution_required",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["research_runs"],
  },
  {
    id: "fred_api",
    category: "macro",
    provider: "Federal Reserve Bank of St. Louis FRED API",
    coverage: ["interest rates", "Treasury curve spread", "effective federal funds rate"],
    currentUse: ["optional rates context in company research"],
    entitlement: "requires_api_key",
    approvedUse: ["Internal personal research with API key, series provenance and required disclosure"],
    restrictions: ["Display the required FRED non-endorsement notice.", "Retain copyright notices and source attribution.", "Third-party series require owner permission beyond personal use."],
    evidenceUrl: "https://fred.stlouisfed.org/docs/api/fred/overview.html",
    evidenceNote: "FRED aggregates government and third-party series; series-level copyright restrictions remain in force.",
    termsUrl: "https://fred.stlouisfed.org/docs/api/terms_of_use.html",
    termsStatus: "official_api_terms",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["research_runs"],
  },
  {
    id: "bea_data_api",
    category: "macro",
    provider: "U.S. Bureau of Economic Analysis",
    coverage: ["NIPA real GDP", "published BEA economic statistics"],
    currentUse: ["optional official growth context in company research"],
    entitlement: "requires_api_key",
    approvedUse: ["Internal descriptive macro context with registered API key and source provenance"],
    restrictions: ["Display the required BEA non-endorsement notice.", "Do not modify or falsely represent API content while claiming BEA as source.", "Respect API limits and retain observation metadata."],
    evidenceUrl: "https://apps.bea.gov/api/signup/",
    evidenceNote: "BEA provides registered API access to published economic statistics under its API Terms of Service.",
    termsUrl: "https://apps.bea.gov/API/_pdf/bea_api_tos.pdf",
    termsStatus: "official_api_terms",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "attribution_required",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["research_runs"],
  },
  {
    id: "openai_api",
    category: "model_service",
    provider: "OpenAI API",
    coverage: ["company research agent", "portfolio Q&A", "counter-thesis review", "advisor plan drafting"],
    currentUse: ["optional grounded analysis and read-only explanation"],
    entitlement: "requires_api_key",
    approvedUse: ["Internal paper-trading analysis with typed tools, output schemas and evidence validation"],
    restrictions: ["Do not send secrets or unnecessary personal data.", "Standard abuse-monitoring logs may retain customer content for up to 30 days; endpoint application-state retention varies.", "Model output is untrusted analysis and cannot authorize orders."],
    evidenceUrl: "https://platform.openai.com/docs/guides/your-data",
    evidenceNote: "OpenAI documents that API data is not used for training by default and describes endpoint-specific retention and approved retention controls.",
    termsUrl: "https://openai.com/policies/services-agreement/",
    termsStatus: "official_api_terms",
    retentionDecision: "persist_with_provenance",
    redistributionDecision: "blocked",
    liveUseDecision: "external_review_required",
    storedOutputIds: ["advisor_plans", "research_runs"],
  },
  {
    id: "local_derived_analytics",
    category: "derived_analytics",
    provider: "AI Broker local calculations",
    coverage: ["risk metrics", "strategy features", "backtest results", "execution replay", "research scores"],
    currentUse: ["portfolio analytics", "Strategy Lab reports", "decision receipts"],
    entitlement: "internal_only",
    approvedUse: ["Internal paper-trading decisions when every source input keeps provenance"],
    restrictions: ["Derived outputs inherit upstream data restrictions.", "Do not present paper backtest output as live edge or investment advice."],
    evidenceUrl: "https://docs.alpaca.markets/us/docs/historical-api",
    evidenceNote: "Alpaca historical API covers stocks, crypto, options and news used for charting, backtesting and strategies.",
    termsUrl: null,
    termsStatus: "internal_policy",
    retentionDecision: "internal_record",
    redistributionDecision: "blocked",
    liveUseDecision: "internal_only",
    storedOutputIds: ["operations_events", "order_authority", "advisor_plans", "trade_journal", "operations_policy", "decision_audit", "portfolio_snapshots", "research_runs", "strategy_experiments"],
  },
];

export const STORED_OUTPUT_CATEGORIES: StoredOutputCategory[] = [
  { id: "schema_migration_history", tables: ["schema_migrations"], contents: ["migration identity", "checksum", "application time"], sourceIds: [], retentionDecision: "application_lifetime", redistributionDecision: "internal_only", liveUseDecision: "operations_only" },
  { id: "operations_events", tables: ["events"], contents: ["operational events", "local spans", "scheduler and incident evidence"], sourceIds: ["local_derived_analytics"], retentionDecision: "until_manual_deletion", redistributionDecision: "internal_only", liveUseDecision: "operations_only" },
  { id: "order_authority", tables: ["submissions", "receipts", "risk_reservations"], contents: ["idempotency records", "paper-order receipts", "risk capacity reservations"], sourceIds: ["alpaca_paper_trading", "alpaca_equity_iex", "alpaca_crypto_data", "local_derived_analytics"], retentionDecision: "until_manual_deletion", redistributionDecision: "internal_only", liveUseDecision: "paper_only" },
  { id: "advisor_plans", tables: ["plans"], contents: ["agent-drafted plans", "exact bounded cited proposal and independent-review typed-tool snapshots with canonical hashes", "simulation-bound intent and authority evidence"], sourceIds: ["alpaca_paper_trading", "alpaca_equity_iex", "alpaca_news_benzinga", "openai_api", "local_derived_analytics"], retentionDecision: "until_manual_deletion", redistributionDecision: "internal_only", liveUseDecision: "paper_only" },
  { id: "trade_journal", tables: ["trade_journal_entries"], contents: ["receipt-linked thesis", "human review history", "market and position context"], sourceIds: ["alpaca_paper_trading", "alpaca_equity_iex", "local_derived_analytics"], retentionDecision: "until_manual_deletion", redistributionDecision: "internal_only", liveUseDecision: "paper_only" },
  { id: "operations_policy", tables: ["operations_policy"], contents: ["global kill switch", "order and exposure limits", "operator identity"], sourceIds: ["local_derived_analytics"], retentionDecision: "until_replaced_or_deleted", redistributionDecision: "internal_only", liveUseDecision: "operations_only" },
  { id: "encrypted_secrets", tables: ["encrypted_secrets"], contents: ["AES-256-GCM provider credential envelopes", "updater identity"], sourceIds: [], retentionDecision: "until_replaced_or_deleted", redistributionDecision: "internal_only", liveUseDecision: "operations_only" },
  { id: "decision_audit", tables: ["decision_audit_log"], contents: ["hash-chained receipt, plan and journal decisions", "retention metadata"], sourceIds: ["local_derived_analytics"], retentionDecision: "retention_metadata_without_automatic_purge", redistributionDecision: "internal_only", liveUseDecision: "operations_only" },
  { id: "broker_account_ledger", tables: ["account_activities"], contents: ["paper fills", "cash activity", "corporate-action evidence"], sourceIds: ["alpaca_paper_trading"], retentionDecision: "until_manual_deletion", redistributionDecision: "internal_only", liveUseDecision: "paper_only" },
  { id: "research_runs", tables: ["research_runs"], contents: ["model output", "research metrics", "provider evidence and limitations", "point-in-time comparable valuation and user-assumption scenario reports with canonical replay hashes"], sourceIds: ["alpaca_equity_iex", "alpaca_news_benzinga", "gdelt_doc_2", "finnhub_free_enrichment", "openfigi_v3", "sec_edgar", "treasury_fiscal_data", "bls_public_data", "fred_api", "bea_data_api", "openai_api", "local_derived_analytics"], retentionDecision: "until_manual_deletion", redistributionDecision: "internal_only", liveUseDecision: "paper_only" },
  { id: "portfolio_snapshots", tables: ["portfolio_snapshots"], contents: ["daily paper portfolio snapshot", "risk and exposure evidence"], sourceIds: ["alpaca_paper_trading", "alpaca_equity_iex", "sec_edgar", "local_derived_analytics"], retentionDecision: "until_manual_deletion", redistributionDecision: "internal_only", liveUseDecision: "paper_only" },
  { id: "strategy_experiments", tables: ["strategy_backtests", "strategy_bar_datasets", "strategy_bars", "strategy_runs", "strategy_data_snapshots", "strategy_decisions", "strategy_orders", "strategy_metrics", "strategy_notes", "strategy_audit_log"], contents: ["immutable backtests and provenance", "versioned normalized crypto bars and dataset-quality evidence", "strategy configuration", "market snapshots", "decisions", "paper orders", "metrics", "notes", "hash-chained audit"], sourceIds: ["alpaca_paper_trading", "alpaca_crypto_data", "local_derived_analytics"], retentionDecision: "retention_metadata_without_automatic_purge", redistributionDecision: "internal_only", liveUseDecision: "paper_only" },
];

export function buildDataGovernanceReport(generatedAt = new Date().toISOString()): DataGovernanceReport {
  const restricted = DATA_GOVERNANCE_SOURCES.filter(source => source.entitlement !== "available");
  return {
    generatedAt,
    sources: DATA_GOVERNANCE_SOURCES,
    storedOutputs: STORED_OUTPUT_CATEGORIES,
    summary: {
      totalSources: DATA_GOVERNANCE_SOURCES.length,
      availableSources: DATA_GOVERNANCE_SOURCES.filter(source => source.entitlement === "available" || source.entitlement === "paper_limited").length,
      restrictedSources: restricted.length,
      blockedForLivePromotion: DATA_GOVERNANCE_SOURCES.filter(source => source.liveUseDecision !== "internal_only").map(source => source.id),
      storedOutputCategories: STORED_OUTPUT_CATEGORIES.length,
      termsExternalReviewRequired: DATA_GOVERNANCE_SOURCES.filter(source => source.termsStatus === "account_terms_external_review_required").map(source => source.id),
    },
    runbook: [
      "Before enabling a new data feature, add its provider, coverage, entitlement and restrictions to this registry.",
      "Preserve source/feed/timestamp provenance in derived analytics and decision receipts.",
      "Treat paper-only IEX, limited crypto data, Benzinga news, public-web GDELT signals and optional Finnhub enrichment as internal evidence, not standalone data products.",
      "Keep fixed-income research unavailable until Broker API partner access, fixed-income enablement and approved bond-pricing evidence exist.",
      "Resolve ticker joins through OpenFIGI where possible and retain symbol-only scope when mapping is ambiguous, missing or unavailable.",
      "Do not add a SQLite table or stored provider output without assigning it to one stored-output category with retention, redistribution and live-use decisions.",
      "Treat retention metadata as evidence, not automatic deletion; no purge job exists today.",
      "Re-review paid feed, SIP, OPRA, crypto and news subscriptions before any live-trading deployment.",
    ],
  };
}
