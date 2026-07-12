/**
 * Portfolio risk, exposure, scenarios, optimization, rebalance, ledger, order,
 * advisor-plan, and trade-journal UI.
 */
$("#stress").insertAdjacentHTML(
  "afterend",
  '<div class="metrics" id="advanced-risk"></div><div id="risk-contribution"></div>',
);
async function loadRisk() {
  const risk = await api("/api/portfolio/risk"),
    advanced = risk.advanced;
  $("#risk").innerHTML =
    `<div class="metric"><strong>${esc(pct(risk.largestPositionPercent))}</strong><span class="muted">Largest position</span></div><div class="metric"><strong>${esc(pct(risk.annualizedVolatility))}</strong><span class="muted">90d volatility</span></div><div class="metric"><strong>${esc(pct(risk.maxDrawdown))}</strong><span class="muted">90d max drawdown</span></div><div class="metric"><strong>${esc(money.format(risk.valueAtRisk95))}</strong><span class="muted">Historical 95% daily VaR · ${esc(pct(risk.valueAtRisk95Percent))}</span></div>`;
  $("#risk-asof").textContent =
    `As of ${new Date(risk.asOf).toLocaleString()} · ${pct(risk.cashPercent)} cash`;
  $("#diversification").innerHTML =
    `<strong>${esc(risk.diversification.investedAssets?.score ?? risk.diversification.score)}/100</strong><span class="muted">Invested assets · ${esc(risk.diversification.investedAssets?.label ?? risk.diversification.label)}</span><span class="muted">Whole account ${esc(risk.diversification.wholeAccount?.score ?? risk.diversification.score)}/100 including cash</span>`;
  const weights = [
    ...risk.weights,
    { symbol: "Cash", percent: risk.cashPercent },
  ]
    .filter((item) => item.percent > 0)
    .sort((a, b) => b.percent - a.percent);
  $("#allocation").innerHTML = weights.length
    ? weights
        .map(
          (item) =>
            `<div class="allocation-row"><strong>${esc(item.symbol)}</strong><div class="bar"><i style="width:${esc(Math.min(100, item.percent))}%"></i></div><span>${esc(pct(item.percent))}</span></div>`,
        )
        .join("")
    : '<div class="empty">No allocation yet</div>';
  $("#stress").innerHTML = risk.stressTests
    .map(
      (item) =>
        `<div class="stress"><span class="muted">${esc(item.name)}</span><strong class="loss">−${esc(money.format(item.estimatedLoss))}</strong><div class="muted">${esc(item.detail)} · ${esc(money.format(item.resultingEquity))} remaining</div></div>`,
    )
    .join("");
  $("#advanced-risk").innerHTML =
    `<div class="metric"><strong>${esc(money.format(advanced.parametricVar95))}</strong><span class="muted">Parametric 95% daily VaR</span></div><div class="metric"><strong>${esc(money.format(advanced.expectedShortfall95))}</strong><span class="muted">Historical 95% expected shortfall</span></div><div class="metric"><strong>${advanced.benchmark.beta === null ? "—" : esc(advanced.benchmark.beta.toFixed(2))}</strong><span class="muted">Beta vs SPY</span></div><div class="metric"><strong>${advanced.benchmark.informationRatio === null ? "—" : esc(advanced.benchmark.informationRatio.toFixed(2))}</strong><span class="muted">Information ratio · ${esc(pct(advanced.benchmark.trackingErrorPercent))} tracking error</span></div>`;
  $("#risk-contribution").innerHTML =
    `<div class="muted" style="margin-top:18px">Risk contribution and liquidity</div>${advanced.riskContribution
      .map((item) => {
        const liquidity = risk.liquidity.find(
          (row) => row.symbol === item.symbol,
        );
        return `<div class="source"><div><strong>${esc(item.symbol)}</strong><div class="muted">${esc(pct(item.percent))} variance contribution</div></div><div class="muted">${liquidity?.spreadBps === null ? "—" : esc(liquidity.spreadBps.toFixed(1)) + " bps spread"} · ${liquidity?.daysAtTenPercentAdv === null ? "—" : esc(liquidity.daysAtTenPercentAdv.toFixed(2)) + " days at 10% ADV"}</div></div>`;
      })
      .join("")}`;
}
function exposureRows(items) {
  return items.length
    ? items
        .slice(0, 8)
        .map((item) => {
          const symbols =
              item.symbols.slice(0, 4).join(", ") +
              (item.symbols.length > 4 ? ` +${item.symbols.length - 4}` : ""),
            width = Math.min(100, Math.max(0, item.grossPercent));
          return `<div class="exposure-row"><div class="exposure-row-head"><strong>${esc(item.label)}</strong><span class="exposure-net">${esc(pct(item.grossPercent))} gross · ${esc(pct(item.netPercent))} net</span></div><div class="bar"><i style="width:${esc(width)}%"></i></div><div class="exposure-symbols">${esc(symbols)}</div></div>`;
        })
        .join("")
    : '<div class="empty">No applicable exposure.</div>';
}
async function loadPortfolioExposure() {
  const data = await api("/api/portfolio/exposure");
  $("#exposure-asof").textContent =
    `${esc(data.quality.classificationScheme)} · SPY benchmark · updated ${new Date(data.asOf).toLocaleString()}`;
  $("#exposure-coverage").textContent =
    `${esc(pct(data.quality.classificationCoveragePercent))} classified`;
  $("#exposure-factors").innerHTML = data.factors
    .map(
      (factor) =>
        `<div class="metric"><strong>${factor.value === null ? "—" : esc(factor.unit === "beta" ? Number(factor.value).toFixed(2) : pct(factor.value))}</strong><span class="muted">${esc(factor.label)} · ${esc(pct(factor.coveragePercent))} coverage</span></div>`,
    )
    .join("");
  $("#asset-class-exposure").innerHTML = exposureRows(data.assetClasses);
  $("#sector-exposure").innerHTML = exposureRows(data.sectors);
  $("#industry-exposure").innerHTML = exposureRows(data.industries);
  $("#exposure-warnings").innerHTML = data.warnings.length
    ? `<div class="warnings">${data.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>`
    : "";
}
function renderPortfolioScenarios(data) {
  const quality = String(data.quality?.status || "unknown").replaceAll(
      "_",
      " ",
    ),
    modeled = data.quality?.received?.modeledPositionEvaluations ?? 0,
    expected = data.quality?.expected?.positionEvaluations ?? 0;
  $("#portfolio-scenarios-asof").textContent =
    `${quality} coverage · ${modeled}/${expected} position evaluations modeled · inputs retrieved ${new Date(data.retrievedAt).toLocaleString()} · response ${new Date(data.serverRespondedAt).toLocaleTimeString()}`;
  $("#portfolio-scenarios").innerHTML =
    `<div class="portfolio-scenario-grid">${data.scenarios
      .map((scenario) => {
        const positions = scenario.positions
          .filter(
            (position) =>
              position.estimatedPnl !== null && position.shockPercent !== 0,
          )
          .slice(0, 4);
        return `<div class="portfolio-scenario"><h3>${esc(scenario.name)}</h3><div class="price ${scenario.estimatedPnl >= 0 ? "gain" : "loss"}">${esc(signedMoney(scenario.estimatedPnl))}</div><div class="muted">${esc(pct(scenario.equityImpactPercent))} equity · ${esc(pct(scenario.coveragePercent))} gross exposure · ${esc(scenario.quality.modeledPositions)}/${esc(scenario.quality.expectedPositions)} positions modeled</div><p class="muted">${esc(scenario.description)}</p>${positions.map((position) => `<div class="scenario-position"><strong>${esc(position.symbol)}</strong><span>${esc(pct(position.shockPercent))}</span><span class="${position.estimatedPnl >= 0 ? "gain" : "loss"}">${esc(signedMoney(position.estimatedPnl))}</span></div>`).join("")}<details class="scenario-details"><summary>Assumptions</summary>${scenario.assumptions.map((assumption) => `<div>${esc(assumption)}</div>`).join("")}</details></div>`;
      })
      .join("")}</div>`;
  $("#portfolio-scenario-warnings").innerHTML = data.warnings.length
    ? `<div class="warnings">${data.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>`
    : "";
}
async function loadPortfolioScenarios(custom) {
  const data = await api(
    "/api/portfolio/scenarios",
    custom
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ custom }),
        }
      : undefined,
  );
  renderPortfolioScenarios(data);
}
function portfolioScenarioShocks(value) {
  const lines = value.trim().split(/\n+/).filter(Boolean);
  if (!lines.length) throw new Error("Enter at least one held symbol shock");
  return lines.map((line) => {
    const match = line
      .trim()
      .match(/^([A-Z0-9.\/-]{1,15})\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))%?$/i);
    if (!match) throw new Error(`Invalid shock line: ${line}`);
    return { symbol: match[1].toUpperCase(), shockPercent: Number(match[2]) };
  });
}
$("#portfolio-scenario-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#portfolio-scenario-button");
  try {
    button.disabled = true;
    button.textContent = "Running…";
    await loadPortfolioScenarios({
      name: $("#portfolio-scenario-name").value,
      shocks: portfolioScenarioShocks($("#portfolio-scenario-shocks").value),
    });
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Run custom scenario";
  }
};
let optimizerTargetDrafts = {};
function optimizerNumber(id) {
  const value = $(id).value.trim(),
    number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(
      `${$(id).previousElementSibling?.textContent || id} must be a number`,
    );
  return number;
}
function renderOptimizer(data) {
  optimizerTargetDrafts = Object.fromEntries(
    (data.proposals || []).map((proposal) => [
      proposal.id,
      proposal.targetDraft,
    ]),
  );
  const observation = data.observedAt
      ? `IEX through ${new Date(data.observedAt).toLocaleDateString()}`
      : "IEX history unavailable",
    quality = String(data.quality?.status || "unknown").replaceAll("_", " ");
  $("#optimizer-asof").textContent =
    `${data.coverage.optimizedSymbols.length} optimized symbols · ${observation} · ${quality} coverage · retrieved ${new Date(data.retrievedAt).toLocaleTimeString()}`;
  if (!data.proposals.length) {
    $("#optimizer-output").innerHTML =
      `<div class="empty">No optimizer proposal is available.</div>${data.warnings.length ? `<div class="warnings">${data.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>` : ""}`;
    return;
  }
  const summary = `<div class="metrics"><div class="metric"><strong>${esc(data.coverage.optimizedSymbols.length)}</strong><span class="muted">Optimized symbols · ${esc(pct(data.coverage.optimizedWeightPercent))} covered</span></div><div class="metric"><strong>${esc(data.coverage.observations || 0)}</strong><span class="muted">Aligned daily observations</span></div><div class="metric"><strong>${esc(pct(data.constraints.maxWeightPercent))}</strong><span class="muted">Max target weight</span></div><div class="metric"><strong>${esc(pct(data.constraints.maxTurnoverPercent))}</strong><span class="muted">Turnover budget</span></div></div>`,
    proposals = `<div class="optimizer-proposals">${data.proposals
      .map(
        (proposal) =>
          `<div class="optimizer-proposal"><h3>${esc(proposal.name)}</h3><div class="muted">${esc(proposal.description)}</div><div class="rebalance-plan-table"><div class="rebalance-plan-row"><strong>${esc(pct(proposal.expectedAnnualReturnPercent))}</strong><span>return</span><span>${esc(pct(proposal.annualizedVolatilityPercent))}</span><span>volatility</span></div><div class="rebalance-plan-row"><strong>${esc(pct(proposal.turnoverPercent))}</strong><span>turnover</span><span>${esc(pct(proposal.maxPositionWeightPercent))}</span><span>max weight</span></div>${proposal.weights
            .slice(0, 5)
            .map(
              (row) =>
                `<div class="rebalance-plan-row"><strong>${esc(row.symbol)}</strong><span>${esc(pct(row.currentWeightPercent))}</span><span>${esc(pct(row.targetWeightPercent))}</span><span class="${row.deltaPercent >= 0 ? "gain" : "loss"}">${esc(pct(row.deltaPercent))}</span></div>`,
            )
            .join(
              "",
            )}</div><div class="muted">${proposal.bindingConstraints.length ? esc(proposal.bindingConstraints.join(", ").replaceAll("_", " ")) : "No binding optimizer constraint"}</div>${proposal.targetDraft ? `<div class="rebalance-plan-actions"><button class="ghost load-optimizer-targets" data-proposal="${esc(proposal.id)}" type="button">Load targets</button></div>` : ""}</div>`,
      )
      .join("")}</div>`,
    warnings = data.warnings.length
      ? `<div class="warnings">${data.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>`
      : "";
  $("#optimizer-output").innerHTML = summary + proposals + warnings;
}
$("#optimizer-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#optimizer-button");
  try {
    button.disabled = true;
    button.textContent = "Building…";
    $("#optimizer-output").innerHTML =
      '<div class="empty spin">Building optimizer proposals…</div>';
    const params = new URLSearchParams({
      maxWeightPercent: String(optimizerNumber("#optimizer-max-weight")),
      maxTurnoverPercent: String(optimizerNumber("#optimizer-max-turnover")),
      cashReservePercent: String(optimizerNumber("#optimizer-cash-reserve")),
      minObservations: String(optimizerNumber("#optimizer-min-observations")),
    });
    renderOptimizer(await api(`/api/portfolio/optimizer?${params}`));
  } catch (error) {
    $("#optimizer-output").innerHTML = cardError(
      "Optimizer unavailable",
      error,
      "Current holdings or historical bars could not be prepared.",
    );
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Build proposals";
  }
};
$("#optimizer-output").addEventListener("click", (event) => {
  const button = event.target.closest(".load-optimizer-targets");
  if (!button) return;
  const draft = optimizerTargetDrafts[button.dataset.proposal];
  if (!draft) return;
  $("#rebalance-targets").value = draft;
  $("#portfolio-rebalance-plan-card")?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
  notify("Optimizer targets loaded into the constrained planner.");
});
let latestRebalanceBasketDraft = "";
function rebalanceTargets(value) {
  const lines = value
    .trim()
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("Enter at least one target weight");
  return lines.map((line) => {
    const match = line.match(/^([A-Z.]{1,10})\s+(\d+(?:\.\d*)?|\.\d+)%?$/i);
    if (!match) throw new Error(`Invalid target line: ${line}`);
    return {
      symbol: match[1].toUpperCase(),
      targetWeightPercent: Number(match[2]),
    };
  });
}
function rebalanceNumber(id) {
  const value = $(id).value.trim();
  if (value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(
      `${$(id).previousElementSibling?.textContent || id} must be a number`,
    );
  return number;
}
function renderRebalancePlan(data) {
  latestRebalanceBasketDraft = data.basketDraft || "";
  const s = data.summary,
    t = data.tax,
    q = data.quality,
    status = data.withinConstraints ? "Within constraints" : "Needs review",
    statusClass = data.withinConstraints ? "gain" : "loss",
    metrics = `<div class="metrics"><div class="metric"><strong class="${statusClass}">${esc(status)}</strong><span class="muted">${esc(data.bindingConstraints.length ? data.bindingConstraints.join(", ").replaceAll("_", " ") : "No binding constraint")}</span></div><div class="metric"><strong>${esc(money.format(s.plannedTurnoverNotional))}</strong><span class="muted">Plan turnover · ${esc(pct(s.turnoverAfterPercent))} after rolling use</span></div><div class="metric"><strong>${esc(money.format(t.estimatedTax))}</strong><span class="muted">FIFO tax estimate · ${esc(String(t.evidenceStatus).replaceAll("_", " "))}</span></div><div class="metric"><strong>${esc(money.format(s.resultingCash))}</strong><span class="muted">Resulting cash · ${esc(money.format(s.cashBuffer))} buffer</span></div></div>`,
    evidence = `<div class="${q.status === "complete" ? "muted" : "warnings"}"><div>Evidence: ${esc(q.received.account)}/${esc(q.expected.account)} account · ${esc(q.received.currentPositions)}/${esc(q.expected.currentPositions)} current positions · ${esc(q.received.targetPricesWithObservation)}/${esc(q.expected.targetPrices)} observed IEX target prices · ${esc(q.omitted.uncoveredTaxLotQuantity)} uncovered FIFO quantity.</div>${q.impact.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`,
    legs = data.legs.length
      ? `<div class="rebalance-plan-table"><div class="muted" style="padding:12px 0 4px">Planned legs</div>${data.legs.map((leg) => `<div class="rebalance-plan-row"><strong>${esc(leg.symbol)} ${esc(leg.side.toUpperCase())}</strong><span>${esc(leg.quantity)}</span><span>${esc(money.format(leg.price))}</span><span>${esc(money.format(leg.plannedNotional))}</span></div>`).join("")}</div>`
      : '<div class="empty" style="margin-top:14px">No executable legs after constraints.</div>',
    positions = data.positions
      .filter((position) => Math.abs(position.plannedDelta) > 0.01)
      .slice(0, 8),
    positionHtml = positions.length
      ? `<div class="rebalance-plan-table"><div class="muted" style="padding:12px 0 4px">Projected positions</div>${positions.map((position) => `<div class="rebalance-plan-row"><strong>${esc(position.symbol)}</strong><span>${esc(pct(position.currentWeightPercent))} current</span><span>${position.targetWeightPercent === null ? "unchanged" : esc(pct(position.targetWeightPercent)) + " target"}</span><span class="${position.plannedDelta >= 0 ? "gain" : "loss"}">${esc(signedMoney(position.plannedDelta))}</span></div>`).join("")}</div>`
      : "",
    warnings = data.warnings.length
      ? `<div class="warnings">${data.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>`
      : "",
    actions = data.basketDraft
      ? '<div class="rebalance-plan-actions"><button class="ghost" id="load-rebalance-basket" type="button">Load basket</button></div>'
      : "";
  $("#rebalance-plan-asof").textContent =
    `${status} · ${String(q.status).replaceAll("_", " ")} coverage · evidence through ${data.observedAt ? new Date(data.observedAt).toLocaleString() : "provider observation unavailable"} · retrieved ${new Date(data.retrievedAt).toLocaleTimeString()} · response ${new Date(data.serverRespondedAt).toLocaleTimeString()}`;
  $("#rebalance-plan-output").innerHTML =
    metrics + evidence + legs + positionHtml + warnings + actions;
}
$("#rebalance-plan-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#rebalance-plan-button");
  try {
    button.disabled = true;
    button.textContent = "Building…";
    $("#rebalance-plan-output").innerHTML =
      '<div class="empty spin">Building constrained plan…</div>';
    const data = await api("/api/portfolio/rebalance-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targets: rebalanceTargets($("#rebalance-targets").value),
        maxTurnoverPercent: rebalanceNumber("#rebalance-max-turnover"),
        feeBps: rebalanceNumber("#rebalance-fee-bps"),
        shortTermTaxRatePercent: rebalanceNumber("#rebalance-short-tax"),
        longTermTaxRatePercent: rebalanceNumber("#rebalance-long-tax"),
        maxEstimatedTax: rebalanceNumber("#rebalance-max-tax"),
        cashBufferPercent: rebalanceNumber("#rebalance-cash-buffer"),
        minTradeNotional: rebalanceNumber("#rebalance-min-trade"),
      }),
    });
    renderRebalancePlan(data);
  } catch (error) {
    $("#rebalance-plan-output").innerHTML = cardError(
      "Rebalance plan unavailable",
      error,
      "Fresh account, quote or FIFO-lot evidence could not be verified.",
    );
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Build plan";
  }
};
$("#rebalance-plan-output").addEventListener("click", (event) => {
  if (
    !event.target.closest("#load-rebalance-basket") ||
    !latestRebalanceBasketDraft
  )
    return;
  $("#basket-legs").value = latestRebalanceBasketDraft;
  $("#portfolio-basket-card")?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
  notify("Basket draft loaded for preview.");
});
function loadPortfolioIntelligence() {
  loadPortfolioExposure().catch((error) => notify(error.message));
  loadPortfolioScenarios().catch((error) => notify(error.message));
}
document
  .querySelector('[data-view="portfolio"]')
  .addEventListener("click", loadPortfolioIntelligence);
addEventListener("hashchange", () => {
  if (location.hash === "#portfolio") loadPortfolioIntelligence();
});
async function loadPortfolioRecord() {
  const data = await api("/api/portfolio/snapshots?limit=30"),
    snapshot = data.current,
    quality = snapshot.quality,
    qualityClass =
      quality.status === "healthy"
        ? "gain"
        : quality.status === "error"
          ? "loss"
          : "";
  $("#snapshot-asof").textContent =
    `${snapshot.source} · captured ${new Date(snapshot.capturedAt).toLocaleString()} · ${data.history.length} daily records`;
  $("#snapshot-metrics").innerHTML =
    `<div class="metric"><strong class="${qualityClass}">${esc(quality.status)}</strong><span class="muted">Data quality</span></div><div class="metric"><strong>${esc(money.format(snapshot.reconciliationGap))}</strong><span class="muted">Equity reconciliation gap · ${esc(pct(snapshot.reconciliationGapPercent))}</span></div><div class="metric"><strong>${esc(snapshot.positionCount)}</strong><span class="muted">Validated positions</span></div><div class="metric"><strong>${esc(snapshot.orderSync.streamState || "unknown")}</strong><span class="muted">Order-state source</span></div>`;
  $("#snapshot-flags").innerHTML = quality.flags.length
    ? `<div class="warnings">${quality.flags.map((flag) => `<div><strong>${esc(flag.severity.toUpperCase())}</strong> · ${esc(flag.message)}</div>`).join("")}</div>`
    : '<div class="muted" style="margin-top:12px">No data-quality exceptions detected.</div>';
  $("#snapshot-history").innerHTML = data.history.length
    ? data.history
        .slice(0, 10)
        .map(
          (item) =>
            `<div class="attribution-row"><strong>${esc(item.snapshotDate)}</strong><span>${esc(money.format(item.equity))}</span><span class="pill">${esc(item.quality.status)}</span></div>`,
        )
        .join("")
    : '<div class="empty">The first daily snapshot is being created.</div>';
}
function equityChart(points) {
  if (points.length < 2)
    return '<div class="muted">More history is needed to draw an equity curve.</div>';
  const width = 700,
    height = 210,
    pad = 8,
    values = points.map((point) => point.equity),
    min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1,
    coords = points.map((point, index) => [
      pad + (index / (points.length - 1)) * (width - pad * 2),
      pad + ((max - point.equity) / range) * (height - pad * 2),
    ]),
    line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
    area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Portfolio equity from ${esc(money.format(values[0]))} to ${esc(money.format(values.at(-1)))}"><line class="chart-base" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"/><polygon class="chart-fill" points="${area}"/><polyline class="chart-line" points="${line}"/></svg>`;
}

async function loadPerformance(period = "3M") {
  const data = await api(
      `/api/portfolio/performance?period=${encodeURIComponent(period)}`,
    ),
    summary = data.summary,
    benchmark = data.benchmark,
    source = benchmark.source,
    plClass = summary.totalProfitLoss >= 0 ? "gain" : "loss",
    active = benchmark.activeReturnPercent,
    sourceNote = source
      ? `${source.provider} ${String(source.feed).toUpperCase()}${source.delayed ? " delayed" : ""}${source.fallback ? " fallback" : ""}`
      : "benchmark feed unavailable";
  $("#performance-metrics").innerHTML =
    `<div class="metric"><strong class="${plClass}">${esc(signedMoney(summary.totalProfitLoss))}</strong><span class="muted">Period P&amp;L · ${esc(pct(summary.totalReturnPercent))}</span></div><div class="metric"><strong class="${summary.timeWeightedReturnPercent >= 0 ? "gain" : "loss"}">${esc(pct(summary.timeWeightedReturnPercent))}</strong><span class="muted">Time-weighted return</span></div><div class="metric"><strong>${summary.moneyWeightedReturnPercent === null ? "—" : esc(pct(summary.moneyWeightedReturnPercent))}</strong><span class="muted">Money-weighted return · annualized</span></div><div class="metric"><strong class="${active === null ? "" : active >= 0 ? "gain" : "loss"}">${active === null ? "—" : esc(pct(active))}</strong><span class="muted">Active return vs ${esc(benchmark.symbol)}</span></div>`;
  $("#performance-quality").innerHTML =
    benchmark.quality === "complete"
      ? `<div class="${source?.fallback ? "warnings" : "muted"}" style="margin-top:12px"><div>${esc(benchmark.symbol)} returned ${esc(pct(benchmark.returnPercent))} across ${esc(benchmark.observations)} daily observations using ${esc(sourceNote)}. External cashflows are excluded from portfolio return.</div>${source?.warning ? `<div>${esc(source.warning)}</div>` : ""}</div>`
      : `<div class="warnings"><div>Benchmark coverage is insufficient for this period; active return is unavailable.</div><div>Source: ${esc(sourceNote)}</div></div>`;
  $("#performance-chart").innerHTML = equityChart(data.points);
  $("#attribution").innerHTML = data.attribution.length
    ? data.attribution
        .slice(0, 6)
        .map(
          (item) =>
            `<div class="attribution-row"><strong>${esc(item.symbol)}</strong><span class="${item.unrealizedProfitLoss >= 0 ? "gain" : "loss"}">${esc(signedMoney(item.unrealizedProfitLoss))}</span><span class="muted">${esc(pct(item.unrealizedReturnPercent))}</span></div>`,
        )
        .join("")
    : '<div class="empty">No open positions</div>';
}
$("#periods").onclick = (event) => {
  const button = event.target.closest("button[data-period]");
  if (!button) return;
  $("#periods")
    .querySelectorAll("button")
    .forEach((item) => item.classList.toggle("active", item === button));
  $("#performance-chart").innerHTML =
    '<div class="muted">Loading equity curve…</div>';
  loadPerformance(button.dataset.period).catch((error) =>
    notify(error.message),
  );
};
const rawLoadPerformance = loadPerformance;
loadPerformance = async function (period = "3M") {
  try {
    return await rawLoadPerformance(period);
  } catch (error) {
    $("#performance-metrics").innerHTML = cardError(
      "Performance unavailable",
      error,
      "Recent SIP market data may require a paid entitlement; other portfolio sections can still load.",
    );
    $("#performance-quality").innerHTML = "";
    $("#performance-chart").innerHTML =
      '<div class="empty error-state"><strong>Equity curve unavailable</strong><div>Benchmark or portfolio history could not be loaded for this period.</div></div>';
    $("#attribution").innerHTML =
      '<div class="empty">Attribution will appear once performance data is available.</div>';
    throw error;
  }
};
const activityTitle = (activity) =>
  activity.category === "trade"
    ? `${activity.side.toUpperCase()} ${activity.quantity} ${activity.symbol} @ ${money.format(activity.price)}`
    : `${activity.type}${activity.symbol ? " · " + activity.symbol : ""}`;
async function loadActivities(category = "") {
  const data = await api(
      `/api/account/activities?limit=50${category ? `&category=${encodeURIComponent(category)}` : ""}`,
    ),
    summary = data.summary,
    unresolved = summary.unresolvedCorporateActions || [];
  $("#ledger-asof").textContent =
    `${summary.activityCount} imported activities · FIFO fill accounting · broker data ${data.cache?.hit ? "reused" : "retrieved"} ${new Date(data.retrievedAt).toLocaleTimeString()}`;
  $("#ledger-metrics").innerHTML =
    `<div class="metric"><strong class="${summary.realizedProfitLoss >= 0 ? "gain" : "loss"}">${esc(signedMoney(summary.realizedProfitLoss))}</strong><span class="muted">Realized trading P&amp;L</span></div><div class="metric"><strong>${esc(signedMoney(summary.dividends))}</strong><span class="muted">Dividends</span></div><div class="metric"><strong>${esc(money.format(summary.feesPaid))}</strong><span class="muted">Fees paid</span></div><div class="metric"><strong>${esc(signedMoney(summary.netTransfers))}</strong><span class="muted">Net transfers</span></div>`;
  $("#ledger-warnings").innerHTML = summary.warnings.length
    ? `<div class="warnings">${summary.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}${unresolved.map((action) => `<div><strong>${esc(`${action.type}${action.subType ? "." + action.subType : ""}${action.symbol ? " · " + action.symbol : ""}`)}</strong> — ${esc(action.reason)}</div>`).join("")}<div>${esc(summary.method)}</div></div>`
    : "";
  $("#activity-ledger").innerHTML = data.activities.length
    ? data.activities
        .map(
          (activity) =>
            `<div class="ledger-row"><div><div class="ticker">${esc(activityTitle(activity))}</div><div class="muted">${esc(activity.category.replaceAll("_", " "))}${activity.subType ? " · " + esc(activity.subType) : ""}</div></div><div class="${activity.amount >= 0 ? "gain" : "loss"}">${esc(signedMoney(activity.amount))}</div><div class="muted">${esc(new Date(activity.occurredAt).toLocaleString())}</div></div>`,
        )
        .join("")
    : '<div class="empty">No matching account activity</div>';
}
$("#activity-category").onchange = (event) =>
  loadActivities(event.target.value).catch((error) => notify(error.message));
function receiptRow(r) {
  const created = r.createdAt
      ? new Date(r.createdAt).toLocaleString()
      : "Time unavailable",
    receiptId = esc(String(r.id || "").slice(0, 8) || "unknown");
  if (
    ["strategy_shadow_decision", "strategy_paper_decision"].includes(r.kind)
  ) {
    const decision =
        typeof r.decision === "string"
          ? { action: r.decision }
          : r.decision || {},
      confidence = Number.isFinite(Number(decision.confidence))
        ? pct(Number(decision.confidence))
        : "Trace only",
      mode = r.kind === "strategy_paper_decision" ? "paper" : "shadow";
    return `<div class="row"><div><div class="ticker">${esc(r.symbol || "Strategy")} ${mode} decision</div><div class="muted">${esc(decision.strategy || "Strategy run")} · Receipt ${receiptId}${r.traceId ? " · trace " + esc(String(r.traceId).slice(0, 8)) : ""}${r.paperOrderId ? " · order " + esc(String(r.paperOrderId).slice(0, 8)) : ""}</div></div><div class="pill">${esc(decision.action || "observed")}</div><div class="muted">${r.submittedOrder ? "Paper order submitted" : esc(confidence)}</div><div class="muted">${esc(created)}</div></div>`;
  }
  if (r.kind === "rebalance_basket" && r.preview)
    return `<div class="row"><div><div class="ticker">${esc(r.preview.legs.length)}-leg rebalance basket</div><div class="muted">Sequential market orders · Receipt ${receiptId}</div></div><div class="pill">${esc(String(r.status || "submitted").replaceAll("_", " "))}</div><div class="muted">${esc(signedMoney(r.preview.simulation?.summary?.netCashChange || 0))} cash</div><div class="muted">${esc(created)}</div></div>`;
  if (r.kind === "option_order" && r.preview)
    return `<div class="row"><div><div class="ticker">${esc(r.preview.kind)} option order · ${esc(r.preview.legs.length)} leg${r.preview.legs.length === 1 ? "" : "s"}</div><div class="muted">Defined risk · Receipt ${receiptId}</div></div><div class="pill">${esc(String(r.status || "submitted").replaceAll("_", " "))}</div><div class="muted">${esc(money.format(r.preview.maxLoss))} max loss</div><div class="muted">${esc(created)}</div></div>`;
  if (r.kind === "crypto_order" && r.preview) {
    const amount =
      r.preview.amountType === "notional"
        ? money.format(r.preview.notional)
        : `${r.preview.estimatedQty} ${String(r.preview.symbol || "").split("/")[0]}`;
    return `<div class="row"><div><div class="ticker">${esc(String(r.preview.side || "").toUpperCase())} ${esc(amount)} ${esc(r.preview.symbol || "Crypto")}</div><div class="muted">${esc(String(r.preview.type || "market").replaceAll("_", " "))} crypto paper order · Receipt ${receiptId}</div></div><div class="pill">${esc(String(r.status || "submitted").replaceAll("_", " "))}</div><div class="muted">${esc(money.format(r.preview.estimatedNotional || 0))}</div><div class="muted">${esc(created)}</div></div>`;
  }
  if (r.preview) {
    const amount =
      r.preview.amountType === "notional"
        ? money.format(r.preview.notional)
        : r.preview.qty;
    return `<div class="row"><div><div class="ticker">${esc(String(r.preview.side || "").toUpperCase())} ${esc(amount)} ${esc(r.preview.symbol || "Order")}</div><div class="muted">${esc(String(r.preview.type || "market").replaceAll("_", " "))} · Receipt ${receiptId}${r.plan ? " · plan " + esc(r.plan.id.slice(0, 8)) : ""}</div></div><div class="pill">${esc(String(r.status || "submitted").replaceAll("_", " "))}</div><div class="muted">${esc(money.format(r.preview.simulation?.estimatedNotional || 0))}</div><div class="muted">${esc(created)}</div></div>`;
  }
  return `<div class="row"><div><div class="ticker">${esc(String(r.kind || "Decision").replaceAll("_", " "))}</div><div class="muted">Receipt ${receiptId}</div></div><div class="pill">${esc(String(r.status || "recorded").replaceAll("_", " "))}</div><div class="muted">No order preview</div><div class="muted">${esc(created)}</div></div>`;
}
async function loadReceipts() {
  const receipts = await api("/api/receipts");
  $("#receipts").innerHTML = receipts.length
    ? receipts.map(receiptRow).join("")
    : '<div class="empty">No decisions recorded yet</div>';
}
async function load() {
  const { account, positions } = await api("/api/account");
  $("#equity").textContent = money.format(account.equity);
  $("#buying-power").textContent = money.format(account.buyingPower);
  $("#cash-balance").textContent = money.format(account.cash);
  $("#account-status").textContent = String(account.status || "unknown")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
  $("#positions").innerHTML = positions.length
    ? positions
        .map(
          (p) =>
            `<div class="row"><div><div class="ticker">${esc(p.symbol)}</div><div class="muted">${esc(p.qty)} shares</div></div><div>${esc(money.format(p.currentPrice))}</div><div>${esc(money.format(p.marketValue))}</div><div class="${Number(p.unrealizedPl) >= 0 ? "gain" : "loss"}">${esc(money.format(p.unrealizedPl))}</div></div>`,
        )
        .join("")
    : '<div class="empty">No filled positions yet</div>';
}
const orderPrice = (order) =>
  order.limitPrice
    ? `Limit ${money.format(order.limitPrice)}`
    : order.stopPrice
      ? `Stop ${money.format(order.stopPrice)}`
      : order.filledAvgPrice
        ? `Filled ${money.format(order.filledAvgPrice)}`
        : "Market";
async function loadOrders(status = $("#order-status").value) {
  const data = await api(
      `/api/orders?status=${encodeURIComponent(status)}&limit=50`,
    ),
    sync = data.sync,
    live =
      sync.streamState === "authenticated"
        ? "live stream"
        : sync.stale
          ? "stale recovery"
          : "recovery polling";
  $("#orders-asof").textContent =
    `${data.orders.length} ${status} orders · ${live} · reconciled ${sync.lastRecoveryAt ? new Date(sync.lastRecoveryAt).toLocaleTimeString() : "pending"}`;
  $("#orders").innerHTML = data.orders.length
    ? data.orders
        .map(
          (order) =>
            `<div class="blotter-row"><div><div class="ticker">${esc(order.symbol || "Multi-leg")} · ${esc(String(order.side || "").toUpperCase())}</div><div class="muted">${esc(String(order.type).replaceAll("_", " "))} · ${esc(String(order.timeInForce).toUpperCase())}${order.legs.length ? ` · ${esc(order.legs.length)} legs` : ""}</div></div><div><strong>${esc(order.filledQty)} / ${esc(order.qty ?? money.format(order.notional || 0))}</strong><div class="muted">filled / ordered</div></div><div>${esc(orderPrice(order))}</div><div><span class="pill">${esc(String(order.status).replaceAll("_", " "))}</span><div class="muted">${order.submittedAt ? esc(new Date(order.submittedAt).toLocaleString()) : "Time unavailable"}</div></div><div class="blotter-actions">${order.replaceable ? `<button class="ghost replace-order" data-order-id="${esc(order.id)}" data-symbol="${esc(order.symbol || "order")}" data-qty="${esc(order.qty)}" data-limit="${esc(order.limitPrice ?? "")}" data-stop="${esc(order.stopPrice ?? "")}">Replace</button>` : ""}${order.cancelable ? `<button class="danger cancel-order" data-order-id="${esc(order.id)}" data-symbol="${esc(order.symbol || "order")}">Cancel</button>` : ""}</div></div>`,
        )
        .join("")
    : '<div class="empty">No matching orders</div>';
}
$("#order-status").onchange = (event) =>
  loadOrders(event.target.value).catch((error) => notify(error.message));
$("#basket-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#basket-button");
  try {
    button.disabled = true;
    button.classList.add("spin");
    const lines = $("#basket-legs")
        .value.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      legs = lines.map((line, index) => {
        const match = line.match(
          /^([A-Za-z.]{1,10})\s+(buy|sell)\s+(\d+(?:\.\d+)?)$/i,
        );
        if (!match)
          throw Error(`Line ${index + 1} must look like “AAPL sell 1”`);
        return {
          symbol: match[1].toUpperCase(),
          side: match[2].toLowerCase(),
          qty: Number(match[3]),
        };
      }),
      preview = await api("/api/orders/basket/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legs, timeInForce: $("#basket-tif").value }),
      }),
      details = preview.simulation.legs
        .map(
          (leg) =>
            `${leg.side.toUpperCase()} ${leg.qty} ${leg.symbol} @ ~${money.format(leg.price)}`,
        )
        .join("\n"),
      liquidityWarnings = preview.liquidity.flatMap((item) =>
        item.warnings.map((warning) => `${item.symbol}: ${warning}`),
      );
    if (
      !(await reviewDialog(
        `Review this ${legs.length}-leg paper rebalance basket?\n\n${details}\n\nBuys: ${money.format(preview.simulation.summary.buyNotional)}\nSells: ${money.format(preview.simulation.summary.sellNotional)}\nNet cash change: ${signedMoney(preview.simulation.summary.netCashChange)}\nTurnover: ${preview.simulation.summary.turnoverPercent.toFixed(1)}%\n\n${preview.simulation.warnings.join("\n")}${liquidityWarnings.length ? "\n\nLiquidity warnings:\n" + liquidityWarnings.join("\n") : ""}\n\nSession: ${preview.session.message}`,
      ))
    )
      return;
    const submitted = await api("/api/orders/basket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        previewToken: preview.previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    notify(
      `Basket ${submitted.status}. Decision receipt ${submitted.receiptId.slice(0, 8)} created.`,
    );
    await Promise.all([load(), loadRisk(), loadOrders(), loadReceipts()]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove("spin");
  }
};
$("#cancel-all-orders").onclick = async (event) => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    const preview = await api("/api/orders/cancel-all-preview"),
      summary = preview.orders
        .map(
          (order) =>
            `${String(order.side).toUpperCase()} ${order.qty ?? money.format(order.notional || 0)} ${order.symbol} · ${String(order.type).replaceAll("_", " ")}`,
        )
        .join("\n");
    if (
      !(await dangerReviewDialog(
        `Cancel exactly these ${preview.orders.length} reviewed paper orders?\n\n${summary}\n\nOrders created after this preview will not be canceled. Fills may race cancellation.`,
        "Cancel reviewed orders",
      ))
    )
      return;
    const result = await api("/api/orders", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewToken: preview.previewToken }),
      }),
      requested = result.results.filter(
        (item) => item.status === "cancel_requested",
      ).length;
    notify(
      `Cancellation requested for ${requested} of ${result.results.length} reviewed orders.`,
    );
    await loadOrders();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#orders").onclick = async (event) => {
  const button = event.target.closest(".cancel-order");
  if (!button) return;
  if (
    !(await dangerReviewDialog(
      `Request cancellation of the working ${button.dataset.symbol} paper order? A fill may race this request.`,
      "Request cancellation",
    ))
  )
    return;
  try {
    button.disabled = true;
    button.textContent = "Canceling…";
    await api(`/api/orders/${encodeURIComponent(button.dataset.orderId)}`, {
      method: "DELETE",
    });
    notify("Cancellation requested. Waiting for Alpaca confirmation.");
    await Promise.all([loadOrders(), load(), loadRisk()]);
  } catch (error) {
    notify(error.message);
    await loadOrders().catch(() => {});
  }
};
$("#orders").addEventListener("click", async (event) => {
  const button = event.target.closest(".replace-order");
  if (!button) return;
  const qty = await promptDialog(
    `New whole-share quantity for ${button.dataset.symbol}`,
    button.dataset.qty,
  );
  if (qty === null) return;
  const limitPrice = button.dataset.limit
    ? await promptDialog("New limit price", button.dataset.limit)
    : null;
  if (button.dataset.limit && limitPrice === null) return;
  const stopPrice = button.dataset.stop
    ? await promptDialog("New stop price", button.dataset.stop)
    : null;
  if (button.dataset.stop && stopPrice === null) return;
  try {
    button.disabled = true;
    button.textContent = "Reviewing…";
    const { preview, previewToken } = await api(
      `/api/orders/${encodeURIComponent(button.dataset.orderId)}/replacement-preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qty, limitPrice, stopPrice }),
      },
    );
    if (
      !(await reviewDialog(
        `Replace ${preview.symbol} paper order?\n\nQuantity: ${preview.original.qty} → ${preview.replacement.qty}\nLimit: ${preview.original.limitPrice ?? "—"} → ${preview.replacement.limitPrice ?? "—"}\nStop: ${preview.original.stopPrice ?? "—"} → ${preview.replacement.stopPrice ?? "—"}\n\nThe order will be revalidated against fresh broker state.`,
      ))
    )
      return;
    await api(`/api/orders/${encodeURIComponent(button.dataset.orderId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    notify("Replacement submitted. Waiting for Alpaca stream confirmation.");
    await loadOrders();
  } catch (error) {
    notify(error.message);
    await loadOrders().catch(() => {});
  } finally {
    button.disabled = false;
    button.textContent = "Replace";
  }
});
$("#quote-form").onsubmit = async (e) => {
  e.preventDefault();
  hideSuggestions();
  try {
    const symbol = quoteInput.value,
      { price } = await api(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
    $("#price").textContent = money.format(price);
    $("#price-label").textContent = `Latest ${symbol.toUpperCase()} price`;
    $("#order-symbol").value = symbol.toUpperCase();
  } catch (e) {
    notify(e.message);
  }
};
$("#portfolio-question-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#portfolio-question-button"),
    root = $("#portfolio-answer");
  try {
    button.disabled = true;
    button.textContent = "Checking…";
    root.innerHTML =
      '<div class="empty spin">Reading typed portfolio evidence…</div>';
    const data = await api("/api/agent/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: $("#portfolio-question").value }),
    });
    $("#portfolio-question-asof").textContent =
      `Answered from current typed evidence · ${new Date(data.asOf).toLocaleString()}`;
    root.innerHTML = `<div>${data.claims.map((claim) => `<div class="qa-claim"><p>${esc(claim.text)}</p><div class="qa-evidence">${claim.evidence.map((id) => `<span class="pill">${esc(id)}</span>`).join("")}</div></div>`).join("")}</div>${data.limitations.length ? `<div class="warnings qa-limitations">${data.limitations.map((item) => `<div>${esc(item)}</div>`).join("")}</div>` : ""}`;
  } catch (error) {
    root.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Ask";
  }
};
function renderCopilotPlan(data) {
  activePlanId = undefined;
  const ideaHtml = data.ideas
    .map((i) => {
      const confidence = Math.max(0, Math.min(100, Number(i.confidence) || 0)),
        review = i.riskReview,
        actionLabel =
          i.proposedAction === i.action
            ? i.action
            : i.proposedAction + " → " + i.action,
        reviewHtml =
          '<div class="risk-review"><div class="risk-review-head"><strong>Counter-thesis</strong><span class="pill risk-' +
          esc(review.verdict) +
          '">' +
          esc(review.verdict) +
          "</span></div><p>" +
          esc(review.counterThesis) +
          '</p><div class="muted"><strong>Fails if:</strong> ' +
          esc(review.failureCondition) +
          '</div><p class="muted">Review evidence: ' +
          review.evidence.map(esc).join(", ") +
          "</p></div>",
        draft = i.actionable
          ? '<button class="primary draft" data-symbol="' +
            esc(i.symbol) +
            '" data-qty="' +
            esc(i.suggestedQty) +
            '" data-side="' +
            (i.action === "reduce" ? "sell" : "buy") +
            '">Review draft</button>'
          : "";
      return (
        '<article class="idea"><div class="idea-top"><strong>' +
        esc(i.symbol) +
        '</strong><span class="action">' +
        esc(actionLabel) +
        "</span></div><p>" +
        esc(i.thesis) +
        '</p><div class="muted"><strong>Risk:</strong> ' +
        esc(i.risk) +
        '</div><div class="muted"><strong>Changes if:</strong> ' +
        esc(i.invalidation) +
        '</div><p class="muted">Proposal evidence: ' +
        i.evidence.map(esc).join(", ") +
        '</p><p class="muted">Confidence ' +
        esc(confidence) +
        '%</p><div class="confidence"><i style="width:' +
        esc(confidence) +
        '%"></i></div>' +
        reviewHtml +
        draft +
        "</article>"
      );
    })
    .join("");
  $("#copilot").innerHTML =
    "<p>" +
    esc(data.summary) +
    ' <span class="muted">Plan ' +
    esc(data.planId.slice(0, 8)) +
    '</span></p><div class="eval-note">' +
    esc(data.riskReviewSummary) +
    '</div><div class="ideas">' +
    ideaHtml +
    "</div>";
  document.querySelectorAll(".draft").forEach(
    (draft) =>
      (draft.onclick = () => {
        activePlanId = data.planId;
        activateView("home");
        $("#order-symbol").value = draft.dataset.symbol;
        $("#qty").value = draft.dataset.qty;
        $("#" + draft.dataset.side).checked = true;
        $("#order-strategy").value = "simple";
        $("#amount-type").value = "quantity";
        $("#order-type").value = "market";
        $("#time-in-force").value = "day";
        $("#extended-hours").checked = false;
        $("#allow-short").checked = false;
        syncOrderTicket();
        $("#order-form").scrollIntoView({ behavior: "smooth" });
      }),
  );
}
$("#copilot-button").onclick = async (e) => {
  const button = e.currentTarget;
  try {
    button.disabled = true;
    button.textContent = "Researching…";
    const data = await api("/api/agent/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: $("#intent").value }),
    });
    renderCopilotPlan(data);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Create plan";
  }
};
let tradeJournalCandidates = [];
function journalStatusClass(status) {
  return ["intact", "drifting", "invalidated"].includes(status)
    ? `journal-status-${status}`
    : "";
}
function renderTradeJournalEntry(entry) {
  const latest = entry.reviews.at(-1),
    change = latest?.snapshot.priceChangePercent,
    changeLabel =
      change === undefined
        ? ""
        : `${change >= 0 ? "+" : ""}${Number(change).toFixed(1)}%`,
    warnings = latest?.snapshot.warnings || [],
    history =
      entry.reviews.length > 1
        ? `<details class="journal-history"><summary>Prior reviews (${entry.reviews.length - 1})</summary>${entry.reviews
            .slice(0, -1)
            .reverse()
            .map((review) => {
              const move = review.snapshot.priceChangePercent;
              return `<div class="journal-history-row"><span class="${journalStatusClass(review.status)}">${esc(review.status)}</span><span class="muted">${esc(new Date(review.reviewedAt).toLocaleString())}</span><span>${esc(review.notes)}</span><strong class="${move >= 0 ? "gain" : "loss"}">${esc(`${move >= 0 ? "+" : ""}${Number(move).toFixed(1)}%`)}</strong></div>`;
            })
            .join("")}</details>`
        : "",
    latestReview = latest
      ? `<div class="journal-review"><div class="journal-review-head"><div><strong>Latest review</strong><div class="muted">${esc(new Date(latest.reviewedAt).toLocaleString())} · ${esc(latest.drift.direction)} · ${esc(latest.snapshot.receiptStatus)}</div></div><strong class="${change >= 0 ? "gain" : "loss"}">${esc(changeLabel)}</strong></div><p>${esc(latest.notes)}</p><div class="muted">Current ${esc(money.format(latest.snapshot.currentPrice))} · preview reference ${esc(money.format(latest.snapshot.referencePrice))}</div>${warnings.length ? `<div class="warnings">${warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>` : ""}${history}</div>`
      : '<div class="journal-review muted">No post-trade review recorded.</div>',
    reviewForm =
      entry.status === "closed"
        ? ""
        : `<form class="journal-review-form" data-journal-id="${esc(entry.id)}"><label class="journal-field"><span class="muted">Thesis status</span><select class="field" name="status"><option value="intact">Intact</option><option value="drifting">Drifting</option><option value="invalidated">Invalidated</option><option value="closed">Closed</option></select></label><label class="journal-field"><span class="muted">Review note</span><textarea class="field" name="notes" minlength="3" maxlength="1000" rows="2" required></textarea></label><button class="primary">Record review</button></form>`;
  return `<article class="journal-entry"><div class="journal-entry-head"><div><h3>${esc(entry.symbol)} · ${esc(entry.side.toUpperCase())} ${esc(entry.qty)}</h3><div class="muted">Receipt ${esc(entry.receiptId.slice(0, 8))} · order ${esc(entry.orderId.slice(0, 8))} · ${esc(entry.reviews.length)} review${entry.reviews.length === 1 ? "" : "s"}</div></div><span class="pill ${journalStatusClass(entry.status)}">${esc(entry.status)}</span></div><div class="journal-thesis"><div><strong>Original thesis</strong><p>${esc(entry.thesis)}</p></div><div><strong>Invalidation</strong><p>${esc(entry.invalidation)}</p></div></div>${latestReview}${reviewForm}</article>`;
}
function applyJournalCandidate() {
  const candidate = tradeJournalCandidates.find(
    (item) => item.receiptId === $("#trade-journal-receipt").value,
  );
  $("#trade-journal-thesis").value = candidate?.suggestedThesis || "";
  $("#trade-journal-invalidation").value =
    candidate?.suggestedInvalidation || "";
}
async function loadTradeJournal() {
  const data = await api("/api/trade-journal");
  tradeJournalCandidates = data.eligibleReceipts;
  $("#trade-journal-count").textContent =
    `${data.entries.length} ${data.entries.length === 1 ? "entry" : "entries"}`;
  $("#trade-journal-asof").textContent =
    `Receipt-linked thesis history · updated ${new Date(data.asOf).toLocaleString()}`;
  const select = $("#trade-journal-receipt");
  select.innerHTML = tradeJournalCandidates.length
    ? tradeJournalCandidates
        .map(
          (item) =>
            `<option value="${esc(item.receiptId)}">${esc(item.symbol)} · ${esc(item.side.toUpperCase())} ${esc(item.qty)} · ${esc(new Date(item.createdAt).toLocaleDateString())}</option>`,
        )
        .join("")
    : '<option value="">No eligible stock-order receipts</option>';
  select.disabled = !tradeJournalCandidates.length;
  $("#trade-journal-add").disabled = !tradeJournalCandidates.length;
  applyJournalCandidate();
  $("#trade-journal").innerHTML = data.entries.length
    ? data.entries.map(renderTradeJournalEntry).join("")
    : '<div class="empty">No journal entries yet.</div>';
}
$("#trade-journal-receipt").onchange = applyJournalCandidate;
$("#trade-journal-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#trade-journal-add");
  try {
    button.disabled = true;
    await api("/api/trade-journal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receiptId: $("#trade-journal-receipt").value,
        thesis: $("#trade-journal-thesis").value,
        invalidation: $("#trade-journal-invalidation").value,
      }),
    });
    notify("Trade journal entry created.");
    await loadTradeJournal();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = !tradeJournalCandidates.length;
  }
};
$("#trade-journal").addEventListener("submit", async (event) => {
  const form = event.target.closest(".journal-review-form");
  if (!form) return;
  event.preventDefault();
  const button = event.submitter;
  try {
    button.disabled = true;
    button.textContent = "Recording…";
    await api(
      `/api/trade-journal/${encodeURIComponent(form.dataset.journalId)}/reviews`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: form.elements.status.value,
          notes: form.elements.notes.value,
        }),
      },
    );
    notify("Post-trade review recorded.");
    await loadTradeJournal();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Record review";
  }
});
document
  .querySelector('[data-view="advisor"]')
  .addEventListener("click", () =>
    loadTradeJournal().catch((error) => notify(error.message)),
  );
addEventListener("hashchange", () => {
  if (location.hash === "#advisor")
    loadTradeJournal().catch((error) => notify(error.message));
});

function syncOrderTicket() {
  let strategy = $("#order-strategy").value,
    amountType = $("#amount-type").value;
  const auction = ["opg", "cls"].includes($("#time-in-force").value);
  if (auction) {
    $("#order-strategy").value = "simple";
    strategy = "simple";
    $("#amount-type").value = "quantity";
    amountType = "quantity";
    if (!["market", "limit"].includes($("#order-type").value))
      $("#order-type").value = "market";
  }
  let linked = strategy !== "simple";
  if (linked && amountType === "notional") {
    $("#amount-type").value = "quantity";
    amountType = "quantity";
  }
  if (amountType === "notional" && linked) {
    $("#order-strategy").value = "simple";
    strategy = "simple";
    linked = false;
  }
  const advanced = strategy !== "simple";
  if (advanced && !["market", "limit"].includes($("#order-type").value))
    $("#order-type").value = "market";
  if (strategy === "oco") {
    $("#order-type").value = "market";
    $("#sell").checked = true;
  } else if (advanced) $("#buy").checked = true;
  $("#order-strategy").disabled = auction;
  $("#amount-type").disabled = advanced || auction;
  $("#order-type").disabled = amountType === "notional" || strategy === "oco";
  if (amountType === "notional") $("#order-type").value = "market";
  $("#qty").setAttribute(
    "aria-label",
    amountType === "notional" ? "Dollar amount" : "Quantity",
  );
  $("#limit-price").hidden =
    $("#order-type").value !== "limit" || strategy === "oco";
  $("#stop-price").hidden =
    advanced || !["stop", "stop_limit"].includes($("#order-type").value);
  $("#trail-percent").hidden =
    advanced || $("#order-type").value !== "trailing_stop";
  $("#take-profit-price").hidden = ![
    "bracket",
    "oco",
    "oto_take_profit",
  ].includes(strategy);
  $("#stop-loss-price").hidden = !["bracket", "oco", "oto_stop_loss"].includes(
    strategy,
  );
  $("#stop-loss-limit-price").hidden = $("#stop-loss-price").hidden;
  const extendedEligible =
    !advanced &&
    !auction &&
    $("#order-type").value === "limit" &&
    $("#time-in-force").value === "day";
  $("#extended-hours-label").hidden = !extendedEligible;
  if (!extendedEligible) $("#extended-hours").checked = false;
  const shortEligible =
    $("#sell").checked &&
    !advanced &&
    !auction &&
    amountType === "quantity" &&
    ["market", "limit"].includes($("#order-type").value) &&
    $("#time-in-force").value === "day" &&
    !$("#extended-hours").checked;
  $("#allow-short-label").hidden = !shortEligible;
  if (!shortEligible) $("#allow-short").checked = false;
}
$("#time-in-force").insertAdjacentHTML(
  "beforeend",
  '<option value="opg">Opening auction</option><option value="cls">Closing auction</option>',
);
$("#order-strategy").onchange = syncOrderTicket;
$("#amount-type").onchange = () => {
  if ($("#amount-type").value === "notional")
    $("#order-strategy").value = "simple";
  syncOrderTicket();
};
$("#order-type").onchange = syncOrderTicket;
$("#time-in-force").onchange = syncOrderTicket;
$("#buy").onchange = syncOrderTicket;
$("#sell").onchange = syncOrderTicket;
$("#extended-hours").onchange = syncOrderTicket;
syncOrderTicket();
$("#order-form").addEventListener("input", () => {
  activePlanId = undefined;
});
$("#order-form").onsubmit = async (e) => {
  e.preventDefault();
  const symbol = $("#order-symbol").value.toUpperCase(),
    amount = $("#qty").value,
    amountType = $("#amount-type").value,
    side = new FormData(e.target).get("side"),
    type = $("#order-type").value,
    strategy = $("#order-strategy").value,
    orderClass = strategy.startsWith("oto_") ? "oto" : strategy,
    button = $("#order-button"),
    ticket = {
      symbol,
      side,
      type,
      orderClass,
      amountType,
      qty: amountType === "quantity" ? amount : undefined,
      notional: amountType === "notional" ? amount : undefined,
      limitPrice: $("#limit-price").hidden
        ? null
        : $("#limit-price").value || null,
      stopPrice: $("#stop-price").hidden
        ? null
        : $("#stop-price").value || null,
      trailPercent: $("#trail-percent").hidden
        ? null
        : $("#trail-percent").value || null,
      takeProfitPrice: $("#take-profit-price").hidden
        ? null
        : $("#take-profit-price").value || null,
      stopLossPrice: $("#stop-loss-price").hidden
        ? null
        : $("#stop-loss-price").value || null,
      stopLossLimitPrice: $("#stop-loss-limit-price").hidden
        ? null
        : $("#stop-loss-limit-price").value || null,
      timeInForce: $("#time-in-force").value,
      extendedHours: $("#extended-hours").checked,
      allowShort: $("#allow-short").checked,
      planId: activePlanId,
    };
  try {
    button.disabled = true;
    button.classList.add("spin");
    const preview = await api("/api/orders/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ticket),
      }),
      impact = preview.simulation,
      order = preview.order,
      amountLabel =
        order.amountType === "notional"
          ? money.format(order.notional)
          : `${order.qty} shares`,
      prices = [
        order.limitPrice ? `Limit ${money.format(order.limitPrice)}` : "",
        order.stopPrice ? `Stop ${money.format(order.stopPrice)}` : "",
        order.trailPercent ? `Trail ${order.trailPercent}%` : "",
        order.takeProfitPrice
          ? `Take profit ${money.format(order.takeProfitPrice)}`
          : "",
        order.stopLossPrice
          ? `Stop loss ${money.format(order.stopLossPrice)}`
          : "",
        order.stopLossLimitPrice
          ? `Stop-loss limit ${money.format(order.stopLossLimitPrice)}`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
      shortWarning = order.allowShort
        ? "\n\nSHORT SALE ENABLED: losses can exceed proceeds; borrow availability and margin are rechecked at submission."
        : "",
      liquidityWarnings = preview.liquidity.warnings.length
        ? `\n\nLiquidity warnings:\n${preview.liquidity.warnings.join("\n")}`
        : "";
    if (
      !(await reviewDialog(
        `${side.toUpperCase()} ${amountLabel} of ${symbol} · ${order.orderClass} ${type.replaceAll("_", " ")} ${order.timeInForce.toUpperCase()}${prices ? `\n${prices}` : ""}\n\nEstimated value: ${money.format(impact.estimatedNotional)}\nEstimated spread cost: ${money.format(preview.liquidity.estimatedSpreadCost)}\nResulting concentration: ${impact.resultingPositionPercent.toFixed(1)}%${shortWarning}\n\nSession: ${preview.session.message}${liquidityWarnings}`,
      ))
    )
      return;
    const submitted = await api("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        previewToken: preview.previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    notify(
      `Order ${submitted.status.replaceAll("_", " ")}. Decision receipt ${submitted.receiptId.slice(0, 8)} created.`,
    );
    await Promise.all([
      load(),
      loadRisk(),
      loadOrders(),
      loadOperationsPolicy(),
      loadClosedBetaEvidence(),
    ]);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      await load();
    }
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove("spin");
  }
};
