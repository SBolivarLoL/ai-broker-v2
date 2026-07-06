/**
 * Browser startup and refresh schedule.
 *
 * Cards load independently; expensive view-specific calls are deferred until
 * their workspace is opened directly.
 */
Promise.allSettled([
  location.hash === "#options"
    ? safeLoad(
        "Options",
        ensureOptionsLoaded,
        "#options-chain",
        "Options chain and portfolio Greeks could not be loaded from the deep link.",
      )
    : null,
  safeLoad(
    "Account",
    load,
    "#equity",
    "Account balances and positions are temporarily unavailable.",
  ),
  safeLoad(
    "Operations policy",
    loadOperationsPolicy,
    "#operations-policy",
    "Global order guardrails could not be loaded.",
  ),
  safeLoad(
    "Closed beta evidence",
    loadClosedBetaEvidence,
    "#closed-beta-evidence",
    "Paper beta evidence could not be measured.",
  ),
  safeLoad(
    "Orders",
    loadOrders,
    "#orders",
    "Order state could not be reconciled from Alpaca.",
  ),
  safeLoad(
    "Risk",
    loadRisk,
    "#risk",
    "Risk metrics need current positions and market data.",
  ),
  location.hash === "#portfolio"
    ? safeLoad(
        "Portfolio exposure",
        loadPortfolioExposure,
        "#exposure-factors",
        "Portfolio exposure classifications and factors could not be loaded.",
      )
    : null,
  location.hash === "#portfolio"
    ? safeLoad(
        "Portfolio scenarios",
        loadPortfolioScenarios,
        "#portfolio-scenarios",
        "Portfolio scenarios could not be loaded.",
      )
    : null,
  safeLoad(
    "Portfolio record",
    loadPortfolioRecord,
    "#snapshot-metrics",
    "Daily broker snapshot validation could not complete.",
  ),
  safeLoad(
    "Performance",
    loadPerformance,
    "#performance-metrics",
    "Performance needs portfolio history and benchmark coverage.",
  ),
  safeLoad(
    "Ledger",
    loadActivities,
    "#activity-ledger",
    "Account activities could not be synced.",
  ),
  safeLoad(
    "Receipts",
    loadReceipts,
    "#receipts",
    "Decision receipts are stored locally and can be retried.",
  ),
  safeLoad(
    "Research metrics",
    loadResearchMetrics,
    "#research-history",
    "Research reliability history is temporarily unavailable.",
  ),
  safeLoad(
    "Company market",
    loadCompanyMarket,
    "#company-metrics",
    "Company quote, chart and news data are temporarily unavailable.",
  ),
  location.hash === "#research"
    ? safeLoad(
        "OpenFIGI identity",
        loadOpenFigiIdentity,
        "#openfigi-identity",
        "OpenFIGI identity mapping is temporarily unavailable.",
      )
    : null,
  location.hash === "#research"
    ? safeLoad(
        "SEC evidence",
        loadSecEvidence,
        "#edgar-evidence",
        "Official SEC evidence is temporarily unavailable.",
      )
    : null,
  location.hash === "#research"
    ? safeLoad(
        "GDELT signals",
        loadGdeltSignals,
        "#gdelt-news",
        "Broad public-web media signals are temporarily unavailable.",
      )
    : null,
  location.hash === "#research"
    ? safeLoad(
        "Finnhub enrichment",
        loadFinnhubEnrichment,
        "#finnhub-enrichment",
        "Optional Finnhub enrichment is temporarily unavailable.",
      )
    : null,
  location.hash === "#research"
    ? safeLoad(
        "Macro context",
        loadMacroContext,
        "#macro-context",
        "Official macro context is temporarily unavailable.",
      )
    : null,
  safeLoad(
    "Market workspace",
    loadMarketWorkspace,
    "#market-discovery",
    "Market discovery and watchlists could not be loaded.",
  ),
  safeLoad(
    "Portfolio monitoring",
    loadMarketMonitoring,
    "#monitoring-news",
    "News, corporate-action and SEC filing monitoring could not be loaded.",
  ),
  safeLoad(
    "Multi-asset monitor",
    loadMultiAsset,
    "#multi-asset-data",
    "Crypto, FX or index entitlement data could not be loaded.",
  ),
  location.hash === "#strategies"
    ? safeLoad(
        "Strategy runs",
        loadStrategyRuns,
        "#strategy-runs",
        "Persisted strategy runs could not be loaded.",
      )
    : null,
  location.hash === "#advisor"
    ? safeLoad(
        "Trade journal",
        loadTradeJournal,
        "#trade-journal",
        "Trade journal entries could not be loaded.",
      )
    : null,
]);
setInterval(() => loadOrders().catch(() => {}), 5000);
setInterval(
  () =>
    Promise.allSettled([
      safeLoad("Account", load, "#equity"),
      safeLoad("Receipts", loadReceipts, "#receipts"),
    ]),
  15000,
);
setInterval(
  () =>
    safeLoad("Portfolio monitoring", loadMarketMonitoring, "#monitoring-news"),
  5 * 60_000,
);
