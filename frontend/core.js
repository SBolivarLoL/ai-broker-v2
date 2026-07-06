/**
 * Shared browser primitives, navigation, operations controls, market discovery,
 * and cross-view loading helpers. Feature-specific rendering lives beside its
 * corresponding workspace.
 */
const $ = (s) => document.querySelector(s),
  money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }),
  toast = $("#toast"),
  esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  safeUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : "#";
    } catch {
      return "#";
    }
  };
let activePlanId;
const notify = (message) => {
  toast.textContent = message;
  toast.style.display = "block";
  setTimeout(() => (toast.style.display = "none"), 4000);
};
function modalRequest({
  title = "Review action",
  body = "",
  confirmText = "Confirm",
  danger = false,
  inputLabel = "",
  inputValue = "",
}) {
  return new Promise((resolve) => {
    const backdrop = $("#modal-backdrop"),
      input = $("#modal-input"),
      field = $("#modal-field"),
      confirm = $("#modal-confirm"),
      cancel = $("#modal-cancel");
    $("#modal-title").textContent = title;
    $("#modal-body").textContent = body;
    confirm.textContent = confirmText;
    confirm.className = danger ? "danger" : "primary";
    field.hidden = !inputLabel;
    $("#modal-label").textContent = inputLabel;
    input.value = inputValue ?? "";
    backdrop.hidden = false;
    const finish = (value) => {
      backdrop.hidden = true;
      confirm.onclick = cancel.onclick = backdrop.onclick = null;
      removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") finish(null);
      if (
        event.key === "Enter" &&
        inputLabel &&
        document.activeElement === input
      )
        finish(input.value);
    };
    confirm.onclick = () => finish(inputLabel ? input.value : true);
    cancel.onclick = () => finish(null);
    backdrop.onclick = (event) => {
      if (event.target === backdrop) finish(null);
    };
    addEventListener("keydown", onKey);
    (inputLabel ? input : confirm).focus();
  });
}
const reviewDialog = (message) =>
  modalRequest({
    title: String(message).split("\n")[0].slice(0, 80) || "Review action",
    body: message,
    confirmText: "Confirm",
  });
const promptDialog = (label, value = "") =>
  modalRequest({
    title: label,
    body: "Update the value below, then confirm.",
    confirmText: "Save",
    inputLabel: label,
    inputValue: value,
  });
const cardError = (
  title,
  error,
  detail = "Try again in a moment or check broker/data entitlements.",
) =>
  `<div class="empty error-state"><strong>${esc(title)}</strong><div>${esc(error?.message || error || "The request failed.")}</div><span class="muted">${esc(detail)}</span></div>`;
async function safeLoad(name, fn, target, detail) {
  // Independent dashboard cards should fail locally; one unavailable provider
  // must not prevent the rest of the workspace from rendering.
  try {
    return await fn();
  } catch (error) {
    if (target && $(target))
      $(target).innerHTML = cardError(`${name} unavailable`, error, detail);
    return null;
  }
}
async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) {
    const reasons =
      body.simulation?.legs?.flatMap((leg) =>
        leg.simulation.reasons.map((reason) => `${leg.symbol}: ${reason}`),
      ) ||
      body.simulation?.reasons ||
      body.reasons;
    throw Error(
      body.error || reasons?.join("\n") || "The request was rejected",
    );
  }
  return body;
}
let operationsPolicy = null;
function renderOperationsPolicy(data) {
  const p = data.policy;
  operationsPolicy = p;
  const kill = p.globalKillSwitch || {},
    active = Boolean(kill.active),
    limits = [
      ["Order cap", money.format(p.maxOrderNotional)],
      ["Symbol cap", money.format(p.maxSymbolExposureNotional)],
      ["Position cap", `${Number(p.maxPortfolioExposurePercent).toFixed(1)}%`],
      ["Sector cap", `${Number(p.maxSectorExposurePercent).toFixed(1)}%`],
      ["Drawdown cap", `${Number(p.maxDrawdownPercent).toFixed(1)}%`],
      ["Turnover cap", `${Number(p.maxDailyTurnoverPercent).toFixed(1)}%`],
    ];
  $("#operations-policy-asof").textContent =
    `${active ? "Kill switch active" : "Trading enabled"} · updated ${p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "not persisted"}`;
  $("#operations-policy").innerHTML =
    `<div class="metric"><strong>${active ? "Blocked" : "Open"}</strong><span class="muted">Global order state</span></div>${limits.map(([label, value]) => `<div class="metric"><strong>${esc(value)}</strong><span class="muted">${esc(label)}</span></div>`).join("")}`;
  [
    ["#operations-max-order", p.maxOrderNotional],
    ["#operations-max-symbol", p.maxSymbolExposureNotional],
    ["#operations-max-position", p.maxPortfolioExposurePercent],
    ["#operations-max-sector", p.maxSectorExposurePercent],
    ["#operations-max-drawdown", p.maxDrawdownPercent],
    ["#operations-max-turnover", p.maxDailyTurnoverPercent],
  ].forEach(([selector, value]) => {
    $(selector).value = String(Number(value));
  });
  const button = $("#operations-kill-toggle");
  button.textContent = active ? "Clear kill switch" : "Activate kill switch";
  button.className = active ? "ghost" : "danger";
  $("#operations-kill-reason").value = active ? kill.reason || "" : "";
  $("#operations-runbook").textContent = active
    ? `Reason: ${kill.reason || "No reason recorded"}${kill.activatedBy ? ` · By ${kill.activatedBy}` : ""}`
    : "Operational caps are enforced on equity, sector, drawdown, turnover, basket, option, crypto and approved strategy paper orders.";
}
async function loadOperationsPolicy() {
  renderOperationsPolicy(await api("/api/operations/policy"));
}
function operationsLimit(selector) {
  const value = Number($(selector).value);
  if (!Number.isFinite(value) || value <= 0)
    throw Error("Policy limits must be positive numbers.");
  return value;
}
function renderClosedBetaEvidence(data) {
  const summary = data.summary,
    status = $("#closed-beta-evidence-status");
  status.textContent = summary.readyForExitReview
    ? "Exit review ready"
    : `${summary.pass}/${summary.totalTargets} passing`;
  status.className = `pill ${summary.readyForExitReview ? "gain" : summary.fail ? "loss" : ""}`;
  $("#closed-beta-evidence-asof").textContent =
    `${data.targetWindowDays}-day paper target · measured ${new Date(data.generatedAt).toLocaleString()} · ${summary.needsEvidence} need evidence`;
  $("#closed-beta-evidence").innerHTML = data.targets
    .map(
      (target) =>
        `<div class="source"><div><strong>${esc(target.metric)}</strong><div class="muted">${esc(target.actual)}</div></div><span class="pill ${target.status === "pass" ? "gain" : target.status === "fail" ? "loss" : ""}">${esc(target.status.replaceAll("_", " "))}</span></div>`,
    )
    .join("");
}
async function loadClosedBetaEvidence() {
  renderClosedBetaEvidence(await api("/api/operations/closed-beta-evidence"));
}
const views = [
  "home",
  "markets",
  "portfolio",
  "strategies",
  "research",
  "options",
  "advisor",
];
function activateView(view) {
  if (!views.includes(view)) view = "home";
  views.forEach((name) => {
    $(`#${name}-view`).hidden = name !== view;
    const button = $(`[data-view="${name}"]`);
    button.classList.toggle("active", name === view);
    button.setAttribute("aria-selected", String(name === view));
  });
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelector(".nav").onclick = (event) => {
  const button = event.target.closest("button[data-view]");
  if (button) activateView(button.dataset.view);
};
addEventListener("hashchange", () => activateView(location.hash.slice(1)));
activateView(location.hash.slice(1));
function cardByHeading(viewId, heading) {
  return [...($(`#${viewId}`)?.querySelectorAll(".card") || [])].find(
    (card) => card.querySelector("h2")?.textContent.trim() === heading,
  );
}
function installSectionNav(viewId, items) {
  const view = $(`#${viewId}`),
    title = view?.querySelector(".view-title");
  if (!view || !title || view.querySelector(".section-jump")) return;
  for (const item of items) {
    const card = cardByHeading(viewId, item.heading);
    if (card) card.id = item.id;
  }
  title.insertAdjacentHTML(
    "afterend",
    `<nav class="section-jump" aria-label="${esc(view.querySelector("h1")?.textContent || "Workspace")} sections">${items.map((item) => `<a href="#${esc(item.id)}">${esc(item.label)}</a>`).join("")}</nav>`,
  );
  view.querySelector(".section-jump").onclick = (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    event.preventDefault();
    const card = $(link.getAttribute("href"));
    card?.scrollIntoView({ behavior: "smooth", block: "start" });
    view
      .querySelectorAll(".section-jump a")
      .forEach((item) => item.classList.toggle("active", item === link));
  };
}
function makeCollapsible(card, collapsed = false) {
  if (!card || card.dataset.collapsible) return;
  card.dataset.collapsible = "true";
  let head = card.querySelector(".section-head");
  if (!head) {
    const h2 = card.querySelector("h2");
    head = document.createElement("div");
    head.className = "section-head";
    h2?.replaceWith(head);
    if (h2) head.append(h2);
  }
  const body = document.createElement("div");
  body.className = "collapse-body";
  [...card.childNodes]
    .filter((node) => node !== head)
    .forEach((node) => body.append(node));
  card.append(body);
  head.insertAdjacentHTML(
    "beforeend",
    '<button class="ghost collapse-toggle" type="button" aria-expanded="true">Collapse</button>',
  );
  const button = head.querySelector(".collapse-toggle"),
    sync = () => {
      const open = !card.classList.contains("is-collapsed");
      button.textContent = open ? "Collapse" : "Expand";
      button.setAttribute("aria-expanded", String(open));
    };
  button.onclick = () => {
    card.classList.toggle("is-collapsed");
    sync();
  };
  if (collapsed) card.classList.add("is-collapsed");
  sync();
}
function installWorkspaceStructure() {
  installSectionNav("portfolio-view", [
    { id: "portfolio-risk-card", label: "Risk", heading: "Portfolio risk" },
    {
      id: "portfolio-exposure-card",
      label: "Exposure",
      heading: "Portfolio exposure",
    },
    {
      id: "portfolio-scenarios-card",
      label: "Scenarios",
      heading: "Scenario library",
    },
    {
      id: "portfolio-optimizer-card",
      label: "Optimize",
      heading: "Optimizer proposals",
    },
    {
      id: "portfolio-rebalance-plan-card",
      label: "Plan",
      heading: "Constrained rebalance",
    },
    {
      id: "portfolio-record-card",
      label: "Record",
      heading: "Portfolio record",
    },
    {
      id: "portfolio-performance-card",
      label: "Performance",
      heading: "Performance",
    },
    {
      id: "portfolio-ledger-card",
      label: "Ledger",
      heading: "Account activity ledger",
    },
    {
      id: "portfolio-positions-card",
      label: "Positions",
      heading: "Positions",
    },
    {
      id: "portfolio-basket-card",
      label: "Basket",
      heading: "Rebalance basket",
    },
    { id: "portfolio-orders-card", label: "Orders", heading: "Order blotter" },
    {
      id: "portfolio-receipts-card",
      label: "Receipts",
      heading: "Decision receipts",
    },
  ]);
  installSectionNav("markets-view", [
    { id: "market-session-card", label: "Session", heading: "Market session" },
    {
      id: "market-discovery-card",
      label: "Discovery",
      heading: "Market discovery",
    },
    {
      id: "market-watchlists-card",
      label: "Watchlists",
      heading: "Watchlists",
    },
    {
      id: "market-monitoring-card",
      label: "Monitoring",
      heading: "Portfolio monitoring",
    },
    {
      id: "market-multi-asset-card",
      label: "Multi-asset",
      heading: "Multi-asset monitor",
    },
  ]);
  installSectionNav("strategies-view", [
    {
      id: "strategy-controls-card",
      label: "Controls",
      heading: "Crypto experiment controls",
    },
    {
      id: "strategy-crypto-order-card",
      label: "Crypto order",
      heading: "Standalone paper crypto order",
    },
    {
      id: "strategy-observability-card",
      label: "Observability",
      heading: "Shadow run observability",
    },
  ]);
  ["Account activity ledger", "Order blotter", "Decision receipts"].forEach(
    (label) =>
      makeCollapsible(
        cardByHeading("portfolio-view", label),
        label !== "Decision receipts",
      ),
  );
  makeCollapsible(cardByHeading("markets-view", "Portfolio monitoring"), true);
}
installWorkspaceStructure();
installSectionNav("advisor-view", [
  { id: "advisor-question-card", label: "Q&A", heading: "Portfolio Q&A" },
  {
    id: "advisor-rebalance-card",
    label: "Rebalance",
    heading: "Guided Rebalance Agent",
  },
  { id: "advisor-journal-card", label: "Journal", heading: "Trade journal" },
]);
const homeView = $("#home-view"),
  privacyToggle = $("#privacy-toggle");
let privacyEnabled = false;
try {
  privacyEnabled = localStorage.getItem("privacy-mode") === "true";
} catch {}
function setPrivacy(enabled) {
  privacyEnabled = enabled;
  homeView.classList.toggle("privacy-mode", enabled);
  privacyToggle.setAttribute("aria-pressed", String(enabled));
  privacyToggle.textContent = enabled ? "Show balances" : "Hide balances";
  try {
    localStorage.setItem("privacy-mode", String(enabled));
  } catch {}
}
privacyToggle.onclick = () => setPrivacy(!privacyEnabled);
setPrivacy(privacyEnabled);
$("#operations-refresh").onclick = () =>
  Promise.all([loadOperationsPolicy(), loadClosedBetaEvidence()]).catch(
    (error) => notify(error.message),
  );
$("#operations-policy-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!operationsPolicy) return notify("Operations policy is still loading.");
  const button = $("#operations-policy-save");
  try {
    button.disabled = true;
    button.textContent = "Saving…";
    const result = await api("/api/operations/policy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        globalKillSwitch: operationsPolicy.globalKillSwitch,
        maxOrderNotional: operationsLimit("#operations-max-order"),
        maxSymbolExposureNotional: operationsLimit("#operations-max-symbol"),
        maxPortfolioExposurePercent: operationsLimit(
          "#operations-max-position",
        ),
        maxSectorExposurePercent: operationsLimit("#operations-max-sector"),
        maxDrawdownPercent: operationsLimit("#operations-max-drawdown"),
        maxDailyTurnoverPercent: operationsLimit("#operations-max-turnover"),
      }),
    });
    renderOperationsPolicy(result);
    notify("Operations policy limits saved.");
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Save limits";
  }
};
$("#operations-kill-toggle").onclick = async () => {
  const active = Boolean(operationsPolicy?.globalKillSwitch?.active),
    reason = $("#operations-kill-reason").value.trim();
  if (!active && !reason) return notify("Add a kill-switch reason first.");
  const message = active
    ? "Clear the global kill switch? New order previews and paper strategy submissions will be allowed again under the configured caps."
    : `Activate the global kill switch?\n\n${reason}\n\nNew equity, basket, option, crypto and approved strategy paper orders will be blocked until cleared.`;
  if (!(await reviewDialog(message))) return;
  try {
    const result = await api("/api/operations/kill-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !active, reason }),
    });
    renderOperationsPolicy(result);
    await loadClosedBetaEvidence();
    notify(
      !active ? "Global kill switch activated." : "Global kill switch cleared.",
    );
  } catch (error) {
    notify(error.message);
  }
};
const quoteInput = $("#quote-symbol"),
  suggestions = $("#stock-suggestions");
let searchTimer,
  searchRequest,
  searchResults = [],
  activeSuggestion = -1;
function hideSuggestions() {
  suggestions.hidden = true;
  suggestions.innerHTML = "";
  quoteInput.setAttribute("aria-expanded", "false");
  quoteInput.removeAttribute("aria-activedescendant");
  searchResults = [];
  activeSuggestion = -1;
}
function paintSuggestions() {
  suggestions
    .querySelectorAll(".suggestion")
    .forEach((item, index) =>
      item.classList.toggle("active", index === activeSuggestion),
    );
  if (activeSuggestion >= 0) {
    const item = suggestions.children[activeSuggestion];
    quoteInput.setAttribute("aria-activedescendant", item.id);
    item.scrollIntoView({ block: "nearest" });
  } else quoteInput.removeAttribute("aria-activedescendant");
}
function showSuggestions(results) {
  searchResults = results;
  activeSuggestion = -1;
  if (!results.length) {
    hideSuggestions();
    return;
  }
  suggestions.innerHTML = results
    .map(
      (asset, index) =>
        `<button type="button" class="suggestion" id="stock-option-${index}" role="option" data-index="${index}"><span class="suggestion-symbol">${esc(asset.symbol)}</span><span class="suggestion-name">${esc(asset.name)}</span><span class="suggestion-exchange">${esc(asset.exchange || "")}</span></button>`,
    )
    .join("");
  suggestions.hidden = false;
  quoteInput.setAttribute("aria-expanded", "true");
}
function chooseSuggestion(index, search = true) {
  const asset = searchResults[index];
  if (!asset) return;
  quoteInput.value = asset.symbol;
  $("#order-symbol").value = asset.symbol;
  hideSuggestions();
  if (search) $("#quote-form").requestSubmit();
}
quoteInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchRequest?.abort();
  hideSuggestions();
  const query = quoteInput.value.trim();
  if (!query) return;
  searchTimer = setTimeout(async () => {
    searchRequest = new AbortController();
    try {
      const { results } = await api(
        `/api/assets/search?q=${encodeURIComponent(query)}`,
        { signal: searchRequest.signal },
      );
      if (quoteInput.value.trim() === query) showSuggestions(results);
    } catch (error) {
      if (error.name !== "AbortError") notify(error.message);
    }
  }, 220);
});
quoteInput.addEventListener("keydown", (event) => {
  if (suggestions.hidden) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeSuggestion = (activeSuggestion + 1) % searchResults.length;
    paintSuggestions();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    activeSuggestion =
      (activeSuggestion - 1 + searchResults.length) % searchResults.length;
    paintSuggestions();
  } else if (event.key === "Enter" && activeSuggestion >= 0) {
    event.preventDefault();
    chooseSuggestion(activeSuggestion);
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideSuggestions();
  }
});
suggestions.addEventListener("mousedown", (event) => {
  const item = event.target.closest(".suggestion");
  if (!item) return;
  event.preventDefault();
  chooseSuggestion(Number(item.dataset.index));
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-box")) hideSuggestions();
});
const pct = (value) => `${Number(value).toFixed(1)}%`,
  signedMoney = (value) =>
    `${Number(value) >= 0 ? "+" : ""}${money.format(value)}`;
let savedWatchlists = [];
const discoveryRows = (items, value) =>
  items
    .map(
      (item) =>
        `<div class="discovery-row"><button class="ticker-link open-company" data-symbol="${esc(item.symbol)}">${esc(item.symbol)}</button><strong class="${value(item) >= 0 ? "gain" : "loss"}">${esc(pct(value(item)))}</strong></div>`,
    )
    .join("");
function renderWatchlists() {
  const root = $("#watchlists");
  root.innerHTML = savedWatchlists.length
    ? savedWatchlists
        .map(
          (list) =>
            `<article class="watchlist" data-watchlist-id="${esc(list.id)}"><div class="watchlist-head"><div><strong>${esc(list.name)}</strong><div class="muted">${esc(list.assets.length)} symbols · updated ${esc(new Date(list.updatedAt).toLocaleString())}</div></div><div class="watchlist-actions"><button class="ghost rename-watchlist" type="button">Rename</button><button class="danger delete-watchlist" type="button">Delete</button></div></div><div class="watchlist-assets">${list.assets.length ? list.assets.map((asset) => `<span class="asset-chip"><button class="ticker-link open-company" data-symbol="${esc(asset.symbol)}">${esc(asset.symbol)}</button><button class="remove-watchlist-asset" data-symbol="${esc(asset.symbol)}" type="button" aria-label="Remove ${esc(asset.symbol)}">×</button></span>`).join("") : '<span class="muted">No symbols saved yet.</span>'}</div><form class="watchlist-add"><input class="field" maxlength="10" placeholder="Add ticker" aria-label="Ticker to add" required><button class="ghost">Add</button></form></article>`,
        )
        .join("")
    : '<div class="empty">No Alpaca watchlists yet. Create one above to start monitoring companies.</div>';
}
async function loadMarketWorkspace() {
  const { watchlists, discovery, calendar } = await api(
      "/api/market/workspace",
    ),
    session = discovery.session;
  savedWatchlists = watchlists;
  $("#market-phase").textContent = session.phase.replaceAll("_", " ");
  $("#market-asof").textContent =
    `${esc(discovery.source)} · updated ${new Date(discovery.asOf).toLocaleTimeString()}`;
  $("#market-session").innerHTML =
    `<div class="metric"><strong>${session.isMarketDay ? "Yes" : "No"}</strong><span class="muted">NASDAQ market day</span></div><div class="metric"><strong>${esc(session.phase.replaceAll("_", " "))}</strong><span class="muted">Current phase</span></div><div class="metric"><strong>${session.nextOpen ? esc(new Date(session.nextOpen).toLocaleString()) : "—"}</strong><span class="muted">Next open</span></div><div class="metric"><strong>${session.nextClose ? esc(new Date(session.nextClose).toLocaleString()) : "—"}</strong><span class="muted">Next close</span></div>`;
  $("#market-calendar").innerHTML = calendar.sessions
    .slice(0, 5)
    .map(
      (day) =>
        `<div class="session-day"><strong>${esc(new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</strong><span class="muted">${esc(new Date(day.coreStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}–${esc(new Date(day.coreEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span>${day.earlyClose ? '<span class="early-close">Early close</span>' : ""}</div>`,
    )
    .join("");
  $("#market-discovery").innerHTML =
    `<div class="discovery-panel"><h3>Top gainers</h3>${discoveryRows(discovery.gainers, (item) => item.percentChange)}</div><div class="discovery-panel"><h3>Top losers</h3>${discoveryRows(discovery.losers, (item) => item.percentChange)}</div><div class="discovery-panel"><h3>Most active by volume</h3>${discovery.mostActive.map((item) => `<div class="discovery-row"><button class="ticker-link open-company" data-symbol="${esc(item.symbol)}">${esc(item.symbol)}</button><strong>${esc(compactNumber.format(item.volume))}</strong></div>`).join("")}</div>`;
  renderWatchlists();
}
const monitoringScopes = (relevance) =>
  `${relevance.portfolio ? '<span class="pill">Portfolio</span>' : ""}${relevance.watchlists.map((list) => `<span class="pill">${esc(list.name)}</span>`).join("")}`;
$("#monitoring-warnings").insertAdjacentHTML(
  "afterend",
  '<div id="monitoring-clusters"></div>',
);
function renderSec8KAlerts(filings) {
  return filings.length
    ? filings
        .map(
          (filing) =>
            `<article class="event-item"><div class="event-head"><div><button class="ticker-link open-company" data-symbol="${esc(filing.symbol)}">${esc(filing.symbol)}</button> · <strong>Item ${esc(filing.primaryItem.code)} · ${esc(filing.primaryItem.label)}</strong></div><span class="pill filing-${esc(filing.importance)}">${esc(filing.importance)}</span></div><div class="filing-alert-summary">${esc(filing.relevanceSummary)}</div><div class="filing-alert-items">${filing.items
              .filter((item) => item.importance !== "supporting")
              .slice(0, 4)
              .map((item) => `<span class="pill">Item ${esc(item.code)}</span>`)
              .join(
                "",
              )}${monitoringScopes(filing.relevance)}</div><div class="filing-alert-links"><span class="accession">Filed ${esc(filing.filed)} · ${esc(filing.accession)}</span><a href="${esc(safeUrl(filing.sourceUrl))}" target="_blank" rel="noopener noreferrer">Primary document ↗</a><a href="${esc(safeUrl(filing.indexUrl))}" target="_blank" rel="noopener noreferrer">Filing index ↗</a></div></article>`,
        )
        .join("")
    : '<div class="empty">No supported material 8-K items were filed in the current 14-day monitoring window.</div>';
}
async function loadMarketMonitoring(force = false) {
  const data = await api(`/api/market/monitoring${force ? "?refresh=1" : ""}`);
  $("#monitoring-asof").textContent =
    `${data.coverage.symbols.length} monitored symbols · updated ${new Date(data.asOf).toLocaleTimeString()}`;
  $("#monitoring-filings-coverage").textContent =
    `${data.coverage.secSymbols.length} symbols checked · 14-day official filing window`;
  $("#monitoring-warnings").innerHTML = data.warnings.length
    ? `<div class="warnings">${data.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>`
    : "";
  $("#monitoring-clusters").innerHTML = data.clusters.length
    ? `<div class="muted" style="margin:14px 0 6px">Event clusters and timeline</div>${data.clusters
        .slice(0, 6)
        .map(
          (cluster) =>
            `<div class="source"><div><strong>${esc(cluster.symbol)} · ${esc(cluster.kind.replaceAll("_", " "))}</strong><div class="muted">${esc(cluster.count)} sourced event${cluster.count === 1 ? "" : "s"} · latest ${esc(new Date(cluster.latestAt).toLocaleString())}</div></div><span class="pill">${esc(cluster.timeline[0].source.replaceAll("_", " "))}</span></div>`,
        )
        .join("")}`
    : "";
  $("#monitoring-news").innerHTML = data.news.length
    ? data.news
        .map(
          (article) =>
            `<article class="news-item"><div>${article.url ? `<a href="${esc(safeUrl(article.url))}" target="_blank" rel="noopener noreferrer">${esc(article.headline)}</a>` : `<strong>${esc(article.headline)}</strong>`}<div class="muted">${esc(article.summary || "No summary available.")}</div><div class="event-scopes">${monitoringScopes(article.relevance)}</div></div><div class="news-source"><strong>${esc(article.source)}</strong><div class="muted">${esc(new Date(article.createdAt).toLocaleString())}</div></div></article>`,
        )
        .join("")
    : '<div class="empty">No relevant Alpaca news in the current window.</div>';
  $("#monitoring-actions").innerHTML = data.corporateActions.length
    ? data.corporateActions
        .map(
          (action) =>
            `<article class="event-item"><div class="event-head"><div><button class="ticker-link open-company" data-symbol="${esc(action.symbol)}">${esc(action.symbol)}</button> · <strong>${esc(action.label)}</strong></div><span class="muted">${esc(new Date(action.eventDate).toLocaleDateString())}</span></div><div class="event-scopes">${monitoringScopes(action.relevance)}</div>${action.impact ? `<div class="event-impact">${esc(action.impact.message)}${action.impact.kind === "cash" ? ` Estimated cash: ${esc(money.format(action.impact.estimatedCash))}` : ""}</div>` : ""}</article>`,
        )
        .join("")
    : '<div class="empty">No relevant corporate actions in the current monitoring window.</div>';
  $("#monitoring-filings").innerHTML = renderSec8KAlerts(data.secFilings || []);
}
async function loadMultiAsset() {
  const data = await api("/api/market/multi-asset"),
    format = (value) =>
      value === null
        ? "—"
        : new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(
            value,
          ),
    rows = [
      ...data.indices.map((item) => ({
        label: item.symbol,
        value: format(item.value),
        detail: "Index · read only",
      })),
      ...data.forex.map((item) => ({
        label: item.symbol,
        value: format(item.midpoint),
        detail: `FX · ${format(item.bid)} / ${format(item.ask)}`,
      })),
      ...data.crypto.map((item) => ({
        label: item.symbol,
        value: money.format(item.midpoint),
        detail: `24/7 crypto · ${item.dayChangePercent === null ? "—" : pct(item.dayChangePercent)} · ${item.spreadBps === null ? "—" : item.spreadBps.toFixed(1) + " bps"} spread`,
      })),
    ];
  $("#multi-asset-asof").textContent =
    `${data.source} · updated ${new Date(data.asOf).toLocaleTimeString()}`;
  $("#multi-asset-warnings").innerHTML = data.warnings.length
    ? `<div class="warnings">${data.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>`
    : "";
  $("#multi-asset-data").innerHTML = rows.length
    ? rows
        .map(
          (item) =>
            `<div class="metric"><strong>${esc(item.value)}</strong><span class="muted">${esc(item.label)} · ${esc(item.detail)}</span></div>`,
        )
        .join("")
    : '<div class="empty">No entitled multi-asset feeds are available.</div>';
  $("#crypto-risk").textContent = data.cryptoRisk;
}
$("#refresh-monitoring").onclick = async (event) => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    await loadMarketMonitoring(true);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#watchlist-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter,
    symbols = $("#watchlist-symbols")
      .value.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  try {
    button.disabled = true;
    await api("/api/watchlists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("#watchlist-name").value, symbols }),
    });
    event.target.reset();
    notify("Watchlist created in Alpaca.");
    await Promise.all([loadMarketWorkspace(), loadMarketMonitoring()]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#watchlists").addEventListener("submit", async (event) => {
  const form = event.target.closest(".watchlist-add");
  if (!form) return;
  event.preventDefault();
  const card = form.closest(".watchlist"),
    button = event.submitter,
    symbol = form.querySelector("input").value;
  try {
    button.disabled = true;
    await api(
      `/api/watchlists/${encodeURIComponent(card.dataset.watchlistId)}/assets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      },
    );
    notify(`${symbol.toUpperCase()} added.`);
    await Promise.all([loadMarketWorkspace(), loadMarketMonitoring()]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#watchlists").addEventListener("click", async (event) => {
  const card = event.target.closest(".watchlist"),
    list = savedWatchlists.find(
      (item) => item.id === card?.dataset.watchlistId,
    );
  if (!list) return;
  if (event.target.closest(".rename-watchlist")) {
    const name = await promptDialog("Watchlist name", list.name);
    if (name === null || name.trim() === list.name) return;
    try {
      await api(`/api/watchlists/${encodeURIComponent(list.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          symbols: list.assets.map((asset) => asset.symbol),
        }),
      });
      notify("Watchlist renamed.");
      await Promise.all([loadMarketWorkspace(), loadMarketMonitoring()]);
    } catch (error) {
      notify(error.message);
    }
  } else if (event.target.closest(".delete-watchlist")) {
    if (
      !(await reviewDialog(
        `Permanently delete the “${list.name}” Alpaca watchlist?`,
      ))
    )
      return;
    try {
      await api(`/api/watchlists/${encodeURIComponent(list.id)}`, {
        method: "DELETE",
      });
      notify("Watchlist deleted.");
      await Promise.all([loadMarketWorkspace(), loadMarketMonitoring()]);
    } catch (error) {
      notify(error.message);
    }
  } else {
    const remove = event.target.closest(".remove-watchlist-asset");
    if (!remove) return;
    const symbol = remove.dataset.symbol;
    if (!(await reviewDialog(`Remove ${symbol} from “${list.name}”?`))) return;
    try {
      await api(
        `/api/watchlists/${encodeURIComponent(list.id)}/assets/${encodeURIComponent(symbol)}`,
        { method: "DELETE" },
      );
      notify(`${symbol} removed.`);
      await Promise.all([loadMarketWorkspace(), loadMarketMonitoring()]);
    } catch (error) {
      notify(error.message);
    }
  }
});
$("#markets-view").addEventListener("click", (event) => {
  const button = event.target.closest(".open-company");
  if (!button) return;
  $("#research-symbol").value = button.dataset.symbol;
  activateView("research");
  loadCompanyMarket(button.dataset.symbol);
  loadOpenFigiIdentity(button.dataset.symbol).catch((error) =>
    notify(error.message),
  );
  loadSecEvidence(button.dataset.symbol).catch((error) =>
    notify(error.message),
  );
  loadGdeltSignals(button.dataset.symbol).catch((error) =>
    notify(error.message),
  );
  loadFinnhubEnrichment(button.dataset.symbol).catch((error) =>
    notify(error.message),
  );
  loadMacroContext().catch((error) => notify(error.message));
});
