/** Evidence-linked research, SEC trends, macro, comparables, and scenarios UI. */
const score = (value) => `${Math.round(Number(value) * 100)}%`;
function researchCitations(ids, sourceMap) {
  return `<span class="citations">${ids
    .map((id) => {
      const source = sourceMap.get(id);
      return source
        ? `<a class="citation" href="${esc(safeUrl(source.url))}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>`
        : `<span class="citation">${esc(id)}</span>`;
    })
    .join("")}</span>`;
}
function researchClaims(items, sourceMap) {
  return items.length
    ? items
        .map(
          (item) =>
            `<div class="claim"><p>${esc(item.text)}</p>${researchCitations(item.evidence, sourceMap)}</div>`,
        )
        .join("")
    : '<div class="muted">No current catalysts identified.</div>';
}
function secTrendValue(value, unit) {
  if (!Number.isFinite(value)) return "—";
  if (unit === "USD")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: Math.abs(value) >= 1e6 ? "compact" : "standard",
      maximumFractionDigits: 2,
    }).format(value);
  if (unit === "USD/shares")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 4,
    }).format(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(
    value,
  );
}
function secTrendExact(value, unit) {
  if (!Number.isFinite(value)) return "Unavailable";
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(value);
  return unit === "USD" ? `$${formatted}` : `${formatted} ${unit}`;
}
function secTrendCadence(label, observations, unit) {
  const rows = observations
    .toReversed()
    .map(
      (item) =>
        `<div class="trend-row"><div><strong>${esc(item.periodEnd || "Period unavailable")}</strong><span class="muted">${item.periodStart ? `${esc(item.periodStart)} to ` : ""}${esc(item.periodEnd || "—")}</span></div><div class="trend-value"><strong>${esc(secTrendValue(item.value, unit))}</strong><span class="muted">${esc(secTrendExact(item.value, unit))}</span></div><div class="trend-source"><span>${esc(item.form || "—")} ${esc(item.fiscalPeriod || "")} · filed ${esc(item.filed || "—")}</span><span class="accession">${esc(item.accession || "No accession")}</span><a href="${esc(safeUrl(item.filingUrl))}" target="_blank" rel="noopener noreferrer">Official filing ↗</a></div></div>`,
    )
    .join("");
  return `<div class="trend-cadence"><h4>${esc(label)}</h4>${rows || '<div class="trend-empty">No directly reported observations available.</div>'}</div>`;
}
function macroValue(item) {
  if (!Number.isFinite(item.value)) return "Unavailable";
  if (item.unit === "USD")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(item.value);
  const value = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(item.value);
  return item.unit === "%" ? `${value}%` : `${value} ${item.unit}`;
}
function macroChange(item) {
  if (!Number.isFinite(item.change)) return "";
  if (item.unit === "USD")
    return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2, signDisplay: "exceptZero" }).format(item.change)} vs prior day`;
  const value = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
    signDisplay: "exceptZero",
  }).format(item.change);
  return `${value}${item.unit.includes("%") ? " pp" : ""} vs prior observation`;
}
function renderMacroContext(data) {
  const providerNames = {
      fred: "FRED",
      treasury: "Treasury",
      bls: "BLS",
      bea: "BEA",
    },
    sourceMap = new Map(
      (data.sources || []).map((source) => [source.id, source]),
    ),
    coverage = Object.entries(data.coverage || {})
      .map(
        ([provider, item]) =>
          `<span class="pill">${esc(providerNames[provider] || provider)} · ${esc(String(item.status || "unavailable").replaceAll("_", " "))} · ${esc(item.indicators || 0)}</span>`,
      )
      .join(""),
    indicators = (data.indicators || [])
      .map((item) => {
        const source = sourceMap.get(item.evidenceId),
          change = macroChange(item);
        return `<div class="macro-indicator"><strong>${esc(macroValue(item))}</strong><span class="muted">${esc(item.label)} · ${esc(item.period)}</span>${change ? `<span class="muted macro-change">${esc(change)}</span>` : ""}${item.calculation ? `<span class="muted macro-change">${esc(item.calculation)}</span>` : ""}${source ? `<a class="macro-indicator-source" href="${esc(safeUrl(source.url))}" target="_blank" rel="noopener noreferrer">${esc(providerNames[item.provider] || item.provider)} source ↗</a>` : ""}</div>`;
      })
      .join(""),
    dimensions = (data.regime?.dimensions || [])
      .map(
        (item) =>
          `<div class="macro-regime-row"><strong>${esc(item.label)} · ${esc(item.state)}</strong><span class="muted">${esc(item.summary)}</span></div>`,
      )
      .join(""),
    warnings = (data.warnings || []).length
      ? `<div class="warnings">${data.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
      : "",
    disclosures = (data.disclosures || [])
      .map(
        (item) =>
          `<div class="macro-disclosure">${esc(item.text)} <a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">Terms of use ↗</a></div>`,
      )
      .join("");
  $("#macro-asof").textContent =
    `Official observations retrieved ${new Date(data.asOf).toLocaleString()}. Descriptive context, not a trading signal.`;
  return `${calculationCoveragePanel("Official macro context", data.quality)}<div class="macro-coverage">${coverage}</div><p>${esc(data.regime?.summary || "Official macro context is currently unavailable.")}</p><div class="macro-indicators">${indicators || '<div class="empty">No official macro observations are currently available.</div>'}</div><div class="macro-regime">${dimensions}</div>${warnings}${disclosures}`;
}
let macroContextLoaded = false;
async function loadMacroContext() {
  if (macroContextLoaded) return;
  const root = $("#macro-context");
  root.innerHTML =
    '<div class="empty spin">Loading official macro sources…</div>';
  try {
    const data = await api("/api/research/macro");
    root.innerHTML = renderMacroContext(data);
    macroContextLoaded = true;
  } catch (error) {
    root.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    throw error;
  }
}
function renderEdgarEvidence(data) {
  const sources = data.sources || [],
    coverage = calculationCoveragePanel("SEC EDGAR", data.quality);
  const filingsSource = sources.find((source) =>
      source.id?.startsWith("sec:filings"),
    ),
    sectionSources = sources.filter((source) =>
      source.id?.startsWith("sec:section"),
    ),
    factsSource = sources.find((source) => source.id?.startsWith("sec:facts")),
    filings = filingsSource?.data?.filings || [],
    facts = Object.values(factsSource?.data?.facts || {}),
    trends = factsSource?.data?.trends?.metrics || [],
    limitations = [
      ...(filingsSource?.data?.limitations || []),
      ...(factsSource?.data?.trends?.limitations || []),
    ];
  if (
    !filings.length &&
    !facts.length &&
    !sectionSources.length &&
    !trends.length
  )
    return `${coverage}<div class="empty">This research run did not return SEC filing evidence. Re-run analysis or check the declared SEC user-agent and network configuration.</div>`;
  const filingRows = filings
      .slice(0, 8)
      .map(
        (item) =>
          `<div class="filing-row"><span class="pill">${esc(item.form)}</span><div><strong>${esc(item.filed || "Filed date unavailable")}</strong><div class="muted">Report ${esc(item.reportDate || "—")} · <span class="accession">${esc(item.accession)}</span></div></div><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>`,
      )
      .join(""),
    factRows = facts
      .slice(0, 8)
      .map(
        (item) =>
          `<div class="fact-card"><strong>${esc(typeof item.value === "number" ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(item.value) : (item.value ?? "—"))}</strong><span class="muted">${esc(item.label || "SEC fact")} · ${esc(item.form || "—")} ${esc(item.fiscalPeriod || "")} · ${esc(item.periodEnd || "")}</span><div class="accession">${esc(item.accession || "No accession")}</div></div>`,
      )
      .join(""),
    trendRows = trends
      .map(
        (metric, index) =>
          `<details class="trend-metric"${index === 0 ? " open" : ""}><summary><span><strong>${esc(metric.label || metric.id || "Financial metric")}</strong><span class="muted">${esc(metric.concept || "SEC concept")} · ${esc(metric.unit || "unit unavailable")}</span></span><span class="pill">${esc((metric.annual?.length || 0) + " annual · " + (metric.quarterly?.length || 0) + " quarterly")}</span></summary><div class="trend-columns">${secTrendCadence("Annual", metric.annual || [], metric.unit || "")}${secTrendCadence("Quarterly", metric.quarterly || [], metric.unit || "")}</div></details>`,
      )
      .join(""),
    sectionRows = sectionSources
      .slice(0, 6)
      .map((source) => {
        const item = source.data || {},
          text = String(item.text || ""),
          excerpt =
            text.length > 1800 ? `${text.slice(0, 1800).trim()}...` : text;
        return `<details class="filing-section"><summary><span><strong>${esc(item.form || "Filing")} · ${esc(item.title || "Section")}</strong><span class="muted">${esc(item.locator || "Locator unavailable")} · filed ${esc(item.filed || "—")} · <span class="accession">${esc(item.accession || "No accession")}</span></span></span><span class="pill">${item.truncated ? "bounded" : "complete"}</span></summary><p>${esc(excerpt || "Section text was unavailable.")}</p><div class="filing-section-meta"><span class="accession">${esc(item.contentHash || source.id)}</span><a href="${esc(safeUrl(item.sourceUrl || source.url))}" target="_blank" rel="noopener noreferrer">Open official section source ↗</a></div></details>`;
      })
      .join("");
  return `${coverage}<div class="filing-grid"><div><h3>Recent filings</h3>${filingRows || '<div class="empty">No 10-K, 10-Q or 8-K metadata returned.</div>'}</div><div><h3>XBRL facts</h3><div class="fact-grid">${factRows || '<div class="empty">No SEC company facts returned.</div>'}</div></div></div><div class="financial-trends"><h3>Comparable financial trends</h3>${trendRows || '<div class="empty">This run predates comparable trend evidence. Re-run research to refresh the SEC facts.</div>'}</div><div class="filing-sections"><h3>Accession-linked filing sections</h3>${sectionRows || '<div class="empty">This run predates filing-section extraction or no supported section was found. Re-run research to refresh the evidence.</div>'}</div>${limitations.length ? `<div class="warnings">${[...new Set(limitations)].map((item) => `<div>${esc(item)}</div>`).join("")}</div>` : ""}<div class="eval-note">Official SEC evidence retains each metric's concept, unit, period, form, filed date, accession and filing URL; filing excerpts also retain their locator, truncation state and content hash.</div>`;
}
let secEvidenceSymbol = null;
async function loadSecEvidence(
  symbol = $("#research-symbol").value.trim().toUpperCase(),
) {
  if (!symbol || symbol === secEvidenceSymbol) return;
  const root = $("#edgar-evidence");
  root.innerHTML =
    '<div class="empty spin">Loading official SEC filings and company facts…</div>';
  try {
    const data = await api(
      `/api/research/sec?symbol=${encodeURIComponent(symbol)}`,
    );
    root.innerHTML = renderEdgarEvidence(data);
    secEvidenceSymbol = symbol;
  } catch (error) {
    root.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    throw error;
  }
}
let comparableSubject = null,
  comparablePeerKey = null;
let scenarioSymbol = null;
function resetComparableTable(symbol) {
  const normalized = String(symbol).toUpperCase();
  if (comparableSubject && comparableSubject !== normalized) {
    comparableSubject = null;
    comparablePeerKey = null;
    $("#comparables-asof").textContent =
      "Annual SEC fundamentals with current Alpaca IEX prices.";
    $("#comparables-table").innerHTML =
      '<div class="empty">No peer set selected.</div>';
  }
  if (scenarioSymbol && scenarioSymbol !== normalized) {
    scenarioSymbol = null;
    $("#scenarios-asof").textContent =
      "Twelve-month user assumptions applied to cited SEC inputs.";
    $("#scenario-results").innerHTML =
      '<div class="empty">No scenario valuation has been run.</div>';
  }
}
function valuationCompact(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: Math.abs(value) >= 1e6 ? "compact" : "standard",
        maximumFractionDigits: 2,
      }).format(value)
    : "—";
}
function valuationRatio(value) {
  return Number.isFinite(value)
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}×`
    : "—";
}
function valuationPercent(value) {
  return Number.isFinite(value) ? pct(value) : "—";
}
function valuationCell(value, period, formatter) {
  return `<strong>${esc(formatter(value))}</strong>${period ? `<span class="muted">${esc(period)}</span>` : ""}`;
}
function renderComparableValuations(data) {
  const sourceMap = new Map(
      (data.sources || []).map((source) => [source.id, source]),
    ),
    rows = (data.rows || [])
      .map((row) => {
        const secSource = sourceMap.get(row.evidence.sec),
          filingUrl =
            secSource?.data?.revenue?.filingUrl || secSource?.url || "#";
        return `<tr class="${row.subject ? "valuation-subject" : ""}"><td class="valuation-company"><strong>${esc(row.symbol)}${row.subject ? " · subject" : ""}</strong><span class="muted">${esc(row.companyName)}</span><a href="${esc(safeUrl(filingUrl))}" target="_blank" rel="noopener noreferrer">SEC inputs ↗</a></td><td>${valuationCell(row.price, row.periods.price ? new Date(row.periods.price).toLocaleDateString() : "", valuationCompact)}</td><td>${valuationCell(row.marketCap, row.periods.sharesOutstanding, valuationCompact)}</td><td>${valuationCell(row.annualRevenue, row.periods.revenue, valuationCompact)}</td><td>${valuationCell(row.revenueGrowthPercent, row.periods.revenue, valuationPercent)}</td><td>${valuationCell(row.netMarginPercent, row.periods.netIncome, valuationPercent)}</td><td>${valuationCell(row.priceToSales, row.periods.revenue, valuationRatio)}</td><td>${valuationCell(row.priceToEarnings, row.periods.dilutedEps, valuationRatio)}</td><td>${valuationCell(row.priceToBook, row.periods.stockholdersEquity, valuationRatio)}</td></tr>`;
      })
      .join(""),
    providerWarnings = data.warnings || [],
    rowWarnings = (data.rows || []).flatMap((row) =>
      (row.warnings || [])
        .filter((item) => !item.startsWith("Derived market capitalization"))
        .map((item) => `${row.symbol}: ${item}`),
    ),
    sharedCaveats = [
      ...new Set(
        (data.rows || []).flatMap((row) =>
          (row.warnings || []).filter((item) =>
            item.startsWith("Derived market capitalization"),
          ),
        ),
      ),
    ],
    warnings = [...providerWarnings, ...rowWarnings, ...sharedCaveats];
  $("#comparables-asof").textContent =
    `${data.rows.length} of ${data.peers.length + 1} companies · updated ${new Date(data.asOf).toLocaleString()} · annual periods shown per cell`;
  return `${calculationCoveragePanel("Comparable valuation", data.quality)}${rows ? `<div class="valuation-table-wrap"><table class="valuation-table"><thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>Revenue</th><th>Revenue growth</th><th>Net margin</th><th>P/S</th><th>P/E</th><th>P/B</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No comparable rows are available.</div>'}${warnings.length ? `<div class="warnings">${warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>` : ""}<div class="valuation-method">P/E uses annual diluted EPS. P/S and P/B use price-derived market capitalization. Revenue growth and margin compare directly reported annual SEC periods; missing or non-positive denominators remain unavailable.</div>`;
}
async function loadComparableValuations() {
  const symbol = $("#research-symbol").value.trim().toUpperCase(),
    peers = $("#comparable-peers").value.trim(),
    key = `${symbol}:${peers.toUpperCase()}`;
  if (key === `${comparableSubject}:${comparablePeerKey}`) return;
  const button = $("#comparables-button"),
    root = $("#comparables-table");
  try {
    button.disabled = true;
    button.textContent = "Loading…";
    root.innerHTML =
      '<div class="empty spin">Loading SEC valuation inputs and current prices…</div>';
    const data = await api(
      `/api/research/comparables?symbol=${encodeURIComponent(symbol)}&peers=${encodeURIComponent(peers)}`,
    );
    root.innerHTML = renderComparableValuations(data);
    comparableSubject = symbol;
    comparablePeerKey = peers.toUpperCase();
  } catch (error) {
    root.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Compare";
  }
}
$("#comparables-form").onsubmit = (event) => {
  event.preventDefault();
  loadComparableValuations().catch((error) => notify(error.message));
};
function renderValuationScenarios(data) {
  const sourceMap = new Map(data.sources.map((source) => [source.id, source])),
    sec = sourceMap.get(data.scenarios[0]?.evidence[0]),
    baseline = data.baseline,
    reference = `<div class="metrics scenario-reference"><div class="metric"><strong>${esc(money.format(data.referencePrice))}</strong><span class="muted">${data.priceMode === "historical_daily_close" ? `Historical IEX close · ${esc(baseline.periods.price || "time unavailable")}` : "Latest returned IEX price"}</span></div><div class="metric"><strong>${esc(valuationCompact(baseline.annualRevenue))}</strong><span class="muted">Annual SEC revenue · ${esc(baseline.periods.revenue || "period unavailable")}</span></div><div class="metric"><strong>${esc(valuationPercent(baseline.netMarginPercent))}</strong><span class="muted">Reported net margin</span></div><div class="metric"><strong>${esc(valuationRatio(baseline.priceToEarnings))}</strong><span class="muted">Selected diluted P/E</span></div></div>`,
    memos = data.scenarios
      .map(
        (item) =>
          `<div class="scenario-memo"><h3>${esc(item.case)} case</h3><div class="price ${item.returnPercent === null ? "" : item.returnPercent >= 0 ? "gain" : "loss"}">${item.impliedPrice === null ? "—" : esc(money.format(item.impliedPrice))}</div><div class="muted">${item.returnPercent === null ? "Implied return unavailable" : `${esc(pct(item.returnPercent))} vs ${data.priceMode === "historical_daily_close" ? "historical close" : "latest returned price"}`}</div><p>${esc(item.memo)}</p><div class="scenario-evidence">${item.evidence.map((id) => `<span class="pill">${esc(id)}</span>`).join("")}</div></div>`,
      )
      .join(""),
    warnings = data.warnings.length
      ? `<div class="warnings">${data.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
      : "";
  $("#scenarios-asof").innerHTML =
    `${esc(data.companyName)} · updated ${esc(new Date(data.asOf).toLocaleString())}${sec ? ` · <a href="${esc(safeUrl(sec.url))}" target="_blank" rel="noopener noreferrer">SEC inputs ↗</a>` : ""}`;
  return `${calculationCoveragePanel("Scenario valuation", data.quality)}${reference}<div class="scenario-memos">${memos}</div>${warnings}<div class="valuation-method">Projected revenue = latest annual SEC revenue × scenario growth. Projected net income = projected revenue × scenario margin. Implied price = projected net income × scenario P/E ÷ latest SEC shares outstanding. Inputs are user assumptions, not forecasts.</div>`;
}
function scenarioValue(id) {
  return Number($(`#scenario-${id}`).value);
}
$("#scenario-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#scenarios-button"),
    root = $("#scenario-results"),
    symbol = $("#research-symbol").value.trim().toUpperCase(),
    scenarios = {
      bear: {
        revenueGrowthPercent: scenarioValue("bear-growth"),
        netMarginPercent: scenarioValue("bear-margin"),
        priceToEarnings: scenarioValue("bear-pe"),
      },
      base: {
        revenueGrowthPercent: scenarioValue("base-growth"),
        netMarginPercent: scenarioValue("base-margin"),
        priceToEarnings: scenarioValue("base-pe"),
      },
      bull: {
        revenueGrowthPercent: scenarioValue("bull-growth"),
        netMarginPercent: scenarioValue("bull-margin"),
        priceToEarnings: scenarioValue("bull-pe"),
      },
    };
  try {
    button.disabled = true;
    button.textContent = "Building…";
    root.innerHTML =
      '<div class="empty spin">Loading SEC valuation inputs and current price…</div>';
    const data = await api("/api/research/scenarios", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, scenarios }),
    });
    root.innerHTML = renderValuationScenarios(data);
    scenarioSymbol = symbol;
  } catch (error) {
    root.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Build scenario memos";
  }
};
function renderResearch(data) {
  const r = data.research,
    m = data.metrics,
    sourceMap = new Map(data.sources.map((source) => [source.id, source]));
  $("#research-result").innerHTML =
    `${calculationCoveragePanel("Company research", data.quality)}<div class="research-header"><div><h2>${esc(r.companyName)} <span class="muted">${esc(r.symbol)}</span></h2><div class="muted">Generated ${esc(new Date(data.asOf).toLocaleString())} · ${esc(data.model)} · run ${esc(data.runId.slice(0, 8))}</div></div><span class="pill stance">${esc(r.stance)}</span></div><p>${esc(r.executiveSummary)}</p>${researchCitations(r.summaryEvidence, sourceMap)}<div class="metrics">${r.keyMetrics
      .slice(0, 4)
      .map(
        (metric) =>
          `<div class="metric"><strong>${esc(new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(metric.value))}</strong><span class="muted">${esc(metric.label)} · ${esc(metric.unit)} · ${esc(metric.period)}</span></div>`,
      )
      .join(
        "",
      )}</div><div class="research-columns"><div class="research-panel"><h3>Investment thesis</h3>${researchClaims(r.thesis, sourceMap)}</div><div class="research-panel"><h3>Material risks</h3>${researchClaims(r.risks, sourceMap)}</div><div class="research-panel"><h3>Potential catalysts</h3>${researchClaims(r.catalysts, sourceMap)}</div><div class="research-panel"><h3>Limitations</h3>${r.limitations.map((item) => `<div class="claim">${esc(item)}</div>`).join("")}</div></div><h3>Run evaluation</h3><div class="metrics"><div class="metric"><strong>${esc(m.overallScore)}/100</strong><span class="muted">Grounded quality score</span></div><div class="metric"><strong>${esc(score(m.citationValidity))}</strong><span class="muted">Valid citations</span></div><div class="metric"><strong>${esc(score(m.numericGrounding))}</strong><span class="muted">Numeric grounding</span></div><div class="metric"><strong>${esc((m.latencyMs / 1000).toFixed(1))}s</strong><span class="muted">${esc(m.totalTokens)} tokens · ${esc(m.toolCalls)} tools</span></div></div><div class="eval-note">The score checks source validity, claim coverage, exact numeric grounding, required tool coverage, limitations, and unsafe certainty language. It is not a prediction-confidence score.</div><h3>Sources</h3><div class="sources">${data.sources.map((source) => `<div class="source"><div><strong>${esc(source.title)}</strong><div class="muted">${esc(source.provider || source.category)} · ${esc((source.claimStatus || source.category).replaceAll("_", " "))} · ${esc(source.category)} · ${esc(new Date(source.asOf).toLocaleString())}</div></div><a href="${esc(safeUrl(source.url))}" target="_blank" rel="noopener noreferrer">Open source ↗</a></div>`).join("")}</div>`;
}
const rawRenderResearch = renderResearch;
renderResearch = function (data) {
  rawRenderResearch(data);
  $("#edgar-evidence").innerHTML = renderEdgarEvidence(data.sources || []);
};
async function loadResearchMetrics() {
  const m = await api("/api/research/metrics");
  $("#research-history").innerHTML = m.totalRuns
    ? `<div class="metric"><strong>${esc(m.totalRuns)}</strong><span class="muted">Completed runs</span></div><div class="metric"><strong>${esc(score(m.successRate))}</strong><span class="muted">Runs scoring 90+</span></div><div class="metric"><strong>${esc(m.averageScore.toFixed(1))}</strong><span class="muted">Average quality score</span></div><div class="metric"><strong>${esc((m.averageLatencyMs / 1000).toFixed(1))}s</strong><span class="muted">Average latency</span></div>`
    : '<div class="empty">Run your first analysis to establish a reliability baseline.</div>';
}
$("#research-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#research-button"),
    symbol = $("#research-symbol").value.trim().toUpperCase();
  loadCompanyMarket(symbol).catch(() => {});
  loadOpenFigiIdentity(symbol).catch(() => {});
  loadSecEvidence(symbol).catch(() => {});
  loadGdeltSignals(symbol).catch(() => {});
  loadFinnhubEnrichment(symbol).catch(() => {});
  loadMacroContext().catch(() => {});
  try {
    button.disabled = true;
    button.textContent = "Analyzing…";
    $("#research-result").innerHTML =
      '<div class="empty spin">Collecting security identity, SEC filings, fundamentals, official macro context, market history and licensed/public-web media signals…</div>';
    const data = await api("/api/research/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol }),
    });
    renderResearch(data);
    await loadResearchMetrics();
  } catch (error) {
    $("#research-result").innerHTML =
      `<div class="empty">${esc(error.message)}</div>`;
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Run AI analysis";
  }
};
