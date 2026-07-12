/**
 * Browser startup and refresh schedule.
 *
 * Cards load independently; expensive view-specific calls are deferred until
 * their workspace is opened directly.
 */
let activatedResearchSymbol = null,
  researchActivationPromise = null;
function ensureResearchWorkspaceLoaded() {
  const symbol = $("#research-symbol").value.trim().toUpperCase();
  if (!symbol) return Promise.resolve();
  if (symbol === activatedResearchSymbol)
    return researchActivationPromise || Promise.resolve();
  activatedResearchSymbol = symbol;
  const request = Promise.allSettled([
    safeLoad(
      "Company market",
      () => loadCompanyMarket(symbol),
      "#company-metrics",
      "Company quote, chart and news data are temporarily unavailable.",
    ),
    safeLoad(
      "OpenFIGI identity",
      () => loadOpenFigiIdentity(symbol),
      "#openfigi-identity",
      "OpenFIGI identity mapping is temporarily unavailable.",
    ),
    safeLoad(
      "SEC evidence",
      () => loadSecEvidence(symbol),
      "#edgar-evidence",
      "Official SEC evidence is temporarily unavailable.",
    ),
    safeLoad(
      "GDELT signals",
      () => loadGdeltSignals(symbol),
      "#gdelt-news",
      "Broad public-web media signals are temporarily unavailable.",
    ),
    safeLoad(
      "Finnhub enrichment",
      () => loadFinnhubEnrichment(symbol),
      "#finnhub-enrichment",
      "Optional Finnhub enrichment is temporarily unavailable.",
    ),
    safeLoad(
      "Macro context",
      loadMacroContext,
      "#macro-context",
      "Official macro context is temporarily unavailable.",
    ),
  ]);
  researchActivationPromise = request;
  return request.finally(() => {
    if (researchActivationPromise === request) researchActivationPromise = null;
  });
}
addEventListener("workspaceactivated", (event) => {
  if (event.detail.view === "research") ensureResearchWorkspaceLoaded();
});

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
    "Closed beta review",
    loadClosedBetaReview,
    "#closed-beta-evidence",
    "Paper beta evidence and workflow records could not be measured.",
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
  location.hash === "#research" ? ensureResearchWorkspaceLoaded() : null,
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
const activeWorkspace = () =>
  document.querySelector(".view:not([hidden])")?.id.replace("-view", "") ||
  "home";
function refreshActiveWorkspace() {
  if (document.hidden) return;
  const view = activeWorkspace();
  if (view === "portfolio") {
    Promise.allSettled([
      safeLoad("Account", load, "#equity"),
      safeLoad("Orders", loadOrders, "#orders"),
      safeLoad("Receipts", loadReceipts, "#receipts"),
    ]);
  } else if (view === "home") {
    safeLoad("Account", load, "#equity");
  } else if (view === "markets") {
    safeLoad("Portfolio monitoring", loadMarketMonitoring, "#monitoring-news");
  } else if (view === "research") {
    ensureResearchWorkspaceLoaded();
  }
}
setInterval(() => {
  if (!document.hidden && activeWorkspace() === "portfolio")
    loadOrders().catch(() => {});
}, 5000);
setInterval(() => {
  if (document.hidden) return;
  const view = activeWorkspace(),
    requests = [];
  if (view === "home" || view === "portfolio")
    requests.push(safeLoad("Account", load, "#equity"));
  if (view === "portfolio")
    requests.push(safeLoad("Receipts", loadReceipts, "#receipts"));
  return Promise.allSettled(requests);
}, 15000);
setInterval(() => {
  if (!document.hidden && activeWorkspace() === "markets")
    return safeLoad(
      "Portfolio monitoring",
      loadMarketMonitoring,
      "#monitoring-news",
    );
}, 5 * 60_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshActiveWorkspace();
});
