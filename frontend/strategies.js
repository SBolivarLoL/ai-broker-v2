/**
 * Strategy Lab UI for backtests, reviewed runs, decisions, audit evidence,
 * attribution, performance, alerts, and standalone crypto order previews.
 */
let strategyRuns = [],
  activeStrategyRunId = null,
  activeTraceId = null,
  latestStrategyBacktestId = null,
  recentStrategyBacktestIds = [];
const strategyLabels = {
  cash: "Cash baseline",
  "buy-and-hold": "Buy and hold",
  "time-sliced-accumulation": "Time-sliced accumulation",
  "moving-average-trend": "Moving average trend",
  "volatility-targeted-trend": "Volatility-targeted trend",
  "breakout-momentum": "Breakout momentum",
  "volatility-filter": "Volatility filter",
  "btc-eth-relative-strength": "BTC/ETH relative strength",
  "order-book-liquidity-scout": "Order-book liquidity scout",
  "mean-reversion": "Mean reversion",
};
const shadowOnlyStrategies = new Set(["volatility-targeted-trend"]);
const strategyDefaultParams = {
  cash: {},
  "buy-and-hold": {},
  "time-sliced-accumulation": { slices: 10, maxExposure: 1 },
  "moving-average-trend": { fast: 5, slow: 20, exposure: 1 },
  "volatility-targeted-trend": {
    fast: 5,
    slow: 20,
    volatilityLookback: 20,
    targetVolatilityPercent: 2,
    maxExposure: 1,
    maxExposureIncreasePerBar: 0.25,
  },
  "breakout-momentum": {
    lookback: 20,
    volumeLookback: 20,
    volumeMultiple: 1.25,
    stopLossPercent: 8,
    exposure: 1,
  },
  "volatility-filter": {
    lookback: 20,
    minVolatilityPercent: 0,
    maxVolatilityPercent: 6,
    exposure: 1,
  },
  "btc-eth-relative-strength": {
    lookback: 20,
    minRelativeStrengthPercent: 0,
    exposure: 1,
  },
  "order-book-liquidity-scout": {
    maxSpreadBps: 100,
    minVisibleAskNotional: 500,
    minVisibleBidNotional: 500,
    maxDepthLevels: 25,
    exposure: 1,
  },
  "mean-reversion": {
    lookback: 20,
    entryZScore: -2,
    exitZScore: -0.25,
    exposure: 1,
  },
};
const strategyParameterLabels = {
  fast: "Fast window",
  slow: "Slow window",
  exposure: "Maximum exposure",
  maxExposure: "Maximum exposure",
  slices: "Accumulation slices",
  lookback: "Signal lookback",
  volumeLookback: "Volume lookback",
  volumeMultiple: "Minimum volume multiple",
  stopLossPercent: "Stop loss (%)",
  minVolatilityPercent: "Minimum volatility (%)",
  maxVolatilityPercent: "Maximum volatility (%)",
  volatilityLookback: "Lagged volatility lookback",
  targetVolatilityPercent: "Target per-bar volatility (%)",
  maxExposureIncreasePerBar: "Maximum exposure increase per bar",
  minRelativeStrengthPercent: "Minimum relative strength (%)",
  maxSpreadBps: "Maximum spread (bps)",
  minVisibleAskNotional: "Minimum visible asks ($)",
  minVisibleBidNotional: "Minimum visible bids ($)",
  maxDepthLevels: "Maximum depth levels",
  entryZScore: "Entry Z-score",
  exitZScore: "Exit Z-score",
};
const strategyParameterBounds = {
  slices: [1, 10_000],
  maxExposure: [0, 1],
  fast: [2, 10_000],
  slow: [3, 10_000],
  exposure: [0, 1],
  lookback: [1, 10_000],
  entryZScore: [-20, 20],
  exitZScore: [-20, 20],
  volumeLookback: [2, 10_000],
  volumeMultiple: [0.01, 100],
  stopLossPercent: [0, 100],
  minVolatilityPercent: [0, 1_000],
  maxVolatilityPercent: [0, 1_000],
  volatilityLookback: [2, 10_000],
  targetVolatilityPercent: [0.01, 1_000],
  maxExposureIncreasePerBar: [0.01, 1],
  minRelativeStrengthPercent: [-1_000, 1_000],
  maxSpreadBps: [1, 10_000],
  minVisibleAskNotional: [0, 1_000_000_000_000],
  minVisibleBidNotional: [0, 1_000_000_000_000],
  maxDepthLevels: [1, 100],
};

function strategyParamBounds(key) {
  if (key === "lookback") {
    const strategyId = $("#strategy-id").value;
    if (strategyId === "btc-eth-relative-strength") return [1, 10_000];
    if (strategyId === "mean-reversion") return [3, 10_000];
    return [2, 10_000];
  }
  return strategyParameterBounds[key] || ["", ""];
}

function strategyParamStep(key, value) {
  if (/exposure|multiple|score/i.test(key)) return "0.05";
  if (/percent/i.test(key)) return "0.1";
  return Number.isInteger(value) ? "1" : "0.01";
}

function renderStrategyParameterFields(params) {
  const root = $("#strategy-parameter-fields"),
    entries = Object.entries(params || {});
  root.innerHTML = entries.length
    ? entries
        .map(([key, value]) => {
          const [minimum, maximum] = strategyParamBounds(key);
          return `<label class="control-label"><span>${esc(strategyParameterLabels[key] || key.replace(/([A-Z])/g, " $1"))}</span><input class="field strategy-param-input" type="number" step="${strategyParamStep(key, value)}" min="${esc(minimum)}" max="${esc(maximum)}" data-param="${esc(key)}" value="${esc(value)}" /></label>`;
        })
        .join("")
    : '<div class="muted">This baseline has no configurable parameters.</div>';
}

function syncStrategyJsonFromFields() {
  const params = {};
  document.querySelectorAll(".strategy-param-input").forEach((input) => {
    params[input.dataset.param] = Number(input.value);
  });
  $("#strategy-params").value = JSON.stringify(params);
  invalidateStrategyBacktest();
}

function strategyPresetParams(strategyId, preset) {
  const params = structuredClone(strategyDefaultParams[strategyId] || {}),
    exposureKey = Object.hasOwn(params, "exposure")
      ? "exposure"
      : Object.hasOwn(params, "maxExposure")
        ? "maxExposure"
        : null;
  if (exposureKey) params[exposureKey] = preset === "conservative" ? 0.5 : 1;
  if (Object.hasOwn(params, "maxSpreadBps"))
    params.maxSpreadBps =
      preset === "conservative" ? 50 : preset === "aggressive" ? 150 : 100;
  if (Object.hasOwn(params, "stopLossPercent"))
    params.stopLossPercent =
      preset === "conservative" ? 5 : preset === "aggressive" ? 10 : 8;
  if (Object.hasOwn(params, "targetVolatilityPercent"))
    params.targetVolatilityPercent =
      preset === "conservative" ? 1 : preset === "aggressive" ? 3 : 2;
  if (Object.hasOwn(params, "maxExposureIncreasePerBar"))
    params.maxExposureIncreasePerBar =
      preset === "conservative" ? 0.1 : preset === "aggressive" ? 0.4 : 0.25;
  return params;
}

function applyStrategyParams(params) {
  $("#strategy-params").value = JSON.stringify(params);
  renderStrategyParameterFields(params);
  invalidateStrategyBacktest();
}
function strategyParams() {
  // Keep the free-form editor flexible, but reject non-object JSON before it
  // reaches the stricter plugin schemas on the server.
  try {
    const value = JSON.parse($("#strategy-params").value || "{}");
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw Error("Strategy parameters must be a JSON object");
    return value;
  } catch (error) {
    throw Error(error.message || "Strategy parameters must be valid JSON");
  }
}
function strategyPayload() {
  return {
    symbols: $("#strategy-symbol")
      .value.split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
    strategyId: $("#strategy-id").value,
    timeframe: $("#strategy-timeframe").value,
    days: Number($("#strategy-days").value),
    intervalMinutes: Number($("#strategy-interval").value || 0),
    params: strategyParams(),
  };
}
function activeStrategyRun() {
  return strategyRuns.find((run) => run.id === activeStrategyRunId) || null;
}

function localDateTimeValue(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function syncStrategyLifecycleControls() {
  const run = activeStrategyRun(),
    protocol = run?.config?.experimentProtocol,
    shadowOnly = Boolean(run && shadowOnlyStrategies.has(run.strategyId)),
    protocolAllowed = run && !shadowOnly && ["shadow", "paused"].includes(run.status),
    protocolButton = $("#strategy-protocol-submit"),
    approvalButton = $("#strategy-paper-approve"),
    pauseButton = $("#strategy-pause-button"),
    killButton = $("#strategy-kill-button"),
    reviewButton = $("#strategy-review-submit"),
    now = new Date();
  protocolButton.disabled = !protocolAllowed;
  approvalButton.disabled = shadowOnly || !protocolAllowed || !protocol;
  pauseButton.disabled =
    !run || ["paused", "completed", "killed", "retired"].includes(run.status);
  killButton.disabled =
    !run || ["completed", "killed", "retired"].includes(run.status);
  reviewButton.disabled = !run;
  $("#strategy-protocol-badge").textContent = protocol
    ? `v${protocol.version} registered`
    : "Required";
  $("#strategy-protocol-badge").className =
    `pill ${protocol ? "gain" : "loss"}`;
  $("#strategy-paper-readiness").textContent = shadowOnly
    ? "Shadow only"
    : protocol
      ? "Protocol ready"
      : "Blocked";
  $("#strategy-paper-readiness").className =
    `pill ${protocol && !shadowOnly ? "gain" : "loss"}`;
  $("#strategy-protocol-status").textContent = !run
    ? "Select a run to register its required protocol."
    : shadowOnly
      ? `${strategyLabels[run.strategyId] || run.strategyId} is limited to backtest and shadow evaluation; paper protocol and approval are unavailable.`
    : protocol
      ? `Version ${protocol.version} · ${new Date(protocol.startAt).toLocaleString()} to ${new Date(protocol.stopAt).toLocaleString()} · maximum ${money.format(protocol.maximumBudget)}.`
      : protocolAllowed
        ? "Register a falsifiable protocol before paper approval. Parameters are frozen to the reviewed backtest."
        : `Protocol registration is unavailable while the run is ${run.status}.`;
  if (!protocol) {
    $("#strategy-protocol-start").value ||= localDateTimeValue(now);
    $("#strategy-protocol-stop").value ||= localDateTimeValue(
      new Date(now.getTime() + 31 * 86_400_000),
    );
  }
}
function strategyLineChart(points) {
  return equityChart(points.map((point) => ({ equity: point.equity })));
}
function comparisonChart(charts, valueKey, title) {
  const series = charts?.series || [];
  if (!charts?.aligned)
    return `<div class="comparison-chart"><h4>${esc(title)}</h4><div class="empty">${esc(charts?.alignmentReason || "Exact timestamp alignment is unavailable.")}</div></div>`;
  const values = series.flatMap((item) =>
    (item.points || [])
      .map((point) => Number(point[valueKey]))
      .filter(Number.isFinite),
  );
  if (!values.length)
    return `<div class="comparison-chart"><h4>${esc(title)}</h4><div class="empty">No chart observations are available.</div></div>`;
  const width = 820,
    height = 248,
    left = 48,
    right = 14,
    top = 16,
    bottom = 34,
    low = Math.min(0, ...values),
    high = Math.max(0, ...values),
    span = Math.max(high - low, 1e-9),
    maximumPoints = Math.max(...series.map((item) => item.points?.length || 0));
  const x = (index) =>
      left + (index / Math.max(maximumPoints - 1, 1)) * (width - left - right),
    y = (value) => top + ((high - value) / span) * (height - top - bottom),
    zeroY = y(0);
  const lines = series
    .map((item, seriesIndex) => {
      const points = (item.points || [])
        .map((point, index) => {
          const value = Number(point[valueKey]);
          return Number.isFinite(value)
            ? `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`
            : "";
        })
        .filter(Boolean)
        .join(" ");
      return points
        ? `<path class="comparison-series-${seriesIndex % 8}" d="${points}" fill="none" stroke-width="2.4" vector-effect="non-scaling-stroke" />`
        : "";
    })
    .join("");
  const legend = series
    .map(
      (item, index) =>
        `<span><i class="comparison-series-${index % 8}"></i>${esc(strategyLabels[item.strategyId] || item.strategyId)} · ${esc(item.backtestId.slice(0, 8))}</span>`,
    )
    .join("");
  const first = series[0]?.points?.[0]?.timestamp,
    last = series[0]?.points?.at(-1)?.timestamp;
  return `<div class="comparison-chart"><h4>${esc(title)}</h4><div class="comparison-chart-legend">${legend}</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)} from ${esc(first ? new Date(first).toLocaleDateString() : "unknown start")} to ${esc(last ? new Date(last).toLocaleDateString() : "unknown end")}"><line x1="${left}" x2="${width - right}" y1="${zeroY}" y2="${zeroY}" class="comparison-zero" /><text x="4" y="${top + 5}" class="comparison-axis">${esc(pct(high))}</text><text x="4" y="${height - bottom}" class="comparison-axis">${esc(pct(low))}</text>${lines}</svg></div>`;
}
function comparisonBand(band) {
  return band?.status === "available"
    ? `${pct(band.lowerPercent)} to ${pct(band.upperPercent)}`
    : "Unavailable";
}
function renderStrategyComparison(comparison) {
  const charts = `${comparisonChart(comparison.charts, "equityReturnPercent", "Aligned equity return")}${comparisonChart(comparison.charts, "drawdownPercent", "Aligned drawdown")}`;
  const experiments = comparison.rows
    .map((row) => {
      const out = row.evaluation?.outOfSample || {},
        decisions = row.decisionCounts || {},
        blockers = row.promotionReadiness?.blockers || [];
      return `<article class="comparison-experiment"><div class="section-head"><div><h4>${esc(strategyLabels[row.strategyId] || row.strategyId)}</h4><div class="muted">Backtest ${esc(row.backtestId.slice(0, 8))} · ${esc(row.createdAt ? new Date(row.createdAt).toLocaleString() : "creation time unavailable")}</div></div><span class="pill ${row.comparable ? "gain" : "loss"}">${row.comparable ? "Clean artifact" : "Legacy / dirty"}</span></div><div class="comparison-metrics"><div><strong class="${Number(row.metrics.totalReturnPercent) >= 0 ? "gain" : "loss"}">${row.metrics.totalReturnPercent === null ? "—" : esc(pct(row.metrics.totalReturnPercent))}</strong><span>Full-period return</span></div><div><strong>${row.metrics.maxDrawdownPercent === null ? "—" : esc(pct(row.metrics.maxDrawdownPercent))}</strong><span>Max drawdown</span></div><div><strong>${esc(decisions.materialTrades ?? "—")}</strong><span>Material decisions</span></div><div><strong>${esc(decisions.exposureIncreases ?? "—")} / ${esc(decisions.exposureReductions ?? "—")}</strong><span>Increase / reduce</span></div><div><strong>${out.totalReturnPercent === null || out.totalReturnPercent === undefined ? "—" : esc(pct(out.totalReturnPercent))}</strong><span>Walk-forward OOS</span></div><div><strong>${esc(comparisonBand(out.uncertainty))}</strong><span>90% OOS return band</span></div><div><strong>${out.holdout?.totalReturnPercent === null || out.holdout?.totalReturnPercent === undefined ? "—" : esc(pct(out.holdout.totalReturnPercent))}</strong><span>Final holdout</span></div><div><strong>${esc(comparisonBand(row.evaluation?.fullSampleUncertainty))}</strong><span>90% full-sample band</span></div></div><div class="promotion-blockers"><strong>Promotion blockers</strong>${blockers.length ? `<ul>${blockers.map((blocker) => `<li class="${blocker.severity === "blocking" ? "blocking" : "evidence"}"><span>${esc(blocker.code.replaceAll("_", " "))}</span>${esc(blocker.message)}</li>`).join("")}</ul>` : '<div class="muted">No blockers reported.</div>'}</div></article>`;
    })
    .join("");
  return `<div class="section-head"><div><h3>Experiment comparison workspace</h3><div class="muted">${comparison.compatible ? "Cohort evidence is aligned; uncertainty remains non-rankable." : "Compatibility warnings prevent comparative ranking."}</div></div><span class="pill ${comparison.compatible ? "gain" : "loss"}">${comparison.compatible ? "Comparable" : "Not rankable"}</span></div>${comparison.warnings.length ? `<div class="warnings">${comparison.warnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>` : ""}<div class="comparison-charts">${charts}</div><div class="comparison-experiments">${experiments}</div>`;
}
function displayValue(value) {
  return value === null
    ? "—"
    : typeof value === "number"
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(
          value,
        )
      : typeof value === "object"
        ? JSON.stringify(value)
        : value;
}
function featureCells(data) {
  const entries = Object.entries(data || {});
  return entries.length
    ? `<div class="kv-grid">${entries.map(([key, value]) => `<div class="kv"><span class="muted">${esc(key)}</span><strong>${esc(displayValue(value))}</strong></div>`).join("")}</div>`
    : '<div class="empty">No values recorded.</div>';
}
function renderBacktest(data) {
  const result = data.result,
    hold = data.baselines.buyAndHold,
    provenance = data.provenance,
    dirty = provenance?.workingTreeDirty
      ? " · dirty code, run creation blocked"
      : "";
  $("#strategy-backtest").innerHTML =
    `<div class="metric"><strong class="${result.totalReturnPercent >= 0 ? "gain" : "loss"}">${esc(pct(result.totalReturnPercent))}</strong><span class="muted">${esc(strategyLabels[result.strategyId] || result.strategyId)} return</span></div><div class="metric"><strong class="${hold.totalReturnPercent >= 0 ? "gain" : "loss"}">${esc(pct(hold.totalReturnPercent))}</strong><span class="muted">Buy-and-hold baseline</span></div><div class="metric"><strong>${esc(pct(result.maxDrawdownPercent))}</strong><span class="muted">Max drawdown</span></div><div class="metric"><strong>${esc(pct(result.exposureTimePercent))}</strong><span class="muted">Time exposed · ${esc(pct(result.turnoverPercent))} turnover</span></div>`;
  const latest = result.points.at(-1);
  $("#strategy-backtest-chart").innerHTML = latest
    ? `${strategyLineChart(result.points)}<div class="chart-note">${esc(data.symbol)} · ${esc(data.timeframe)} · ${esc(result.points.length)} bars · backtest ${esc(data.backtestId.slice(0, 8))} · data ${esc(provenance.datasetHash.slice(7, 19))}${esc(dirty)}</div>`
    : '<div class="empty">No backtest points returned.</div>';
  const metrics = result.tradeMetrics || {},
    uncertainty = result.uncertainty || {},
    returnRange = uncertainty.totalReturnPercent,
    drawdownRange = uncertainty.maxDrawdownPercent;
  $("#strategy-backtest-evidence").hidden = false;
  $("#strategy-trade-metrics").innerHTML =
    `<div class="metric"><strong>${esc(metrics.tradeCount ?? "—")}</strong><span class="muted">Simulated trades</span></div><div class="metric"><strong>${esc(metrics.roundTripCount ?? "—")}</strong><span class="muted">Closed round trips</span></div><div class="metric"><strong>${metrics.sortinoRatio === null || metrics.sortinoRatio === undefined ? "—" : esc(strategyNumber(metrics.sortinoRatio, 2))}</strong><span class="muted">Sortino ratio</span></div><div class="metric"><strong>${metrics.calmarRatio === null || metrics.calmarRatio === undefined ? "—" : esc(strategyNumber(metrics.calmarRatio, 2))}</strong><span class="muted">Calmar ratio</span></div><div class="metric"><strong>${metrics.profitFactor === null || metrics.profitFactor === undefined ? "—" : esc(strategyNumber(metrics.profitFactor, 2))}</strong><span class="muted">Profit factor</span></div><div class="metric"><strong>${metrics.hitRatePercent === null || metrics.hitRatePercent === undefined ? "—" : esc(pct(metrics.hitRatePercent))}</strong><span class="muted">Hit rate</span></div><div class="metric"><strong>${esc(pct(metrics.turnoverPercent ?? result.turnoverPercent))}</strong><span class="muted">Turnover</span></div><div class="metric"><strong>${esc(money.format(result.totalCost || 0))}</strong><span class="muted">Modeled costs</span></div>`;
  $("#strategy-capacity-warnings").innerHTML = metrics.capacityWarnings?.length
    ? `<div class="warnings">${metrics.capacityWarnings.map((warning) => `<div>${esc(warning)}</div>`).join("")}</div>`
    : '<div class="muted">No capacity warnings for this sample.</div>';
  $("#strategy-uncertainty").innerHTML =
    uncertainty.status === "available"
      ? `<div class="metric"><strong>${esc(pct(returnRange.lowerPercentile))} to ${esc(pct(returnRange.upperPercentile))}</strong><span class="muted">90% bootstrap return range</span></div><div class="metric"><strong>${esc(pct(drawdownRange.lowerPercentile))} to ${esc(pct(drawdownRange.upperPercentile))}</strong><span class="muted">90% max-drawdown range</span></div><div class="metric"><strong>${esc(uncertainty.sampleSize)}</strong><span class="muted">Scored returns · not rankable</span></div>`
      : `<div class="empty">${esc(uncertainty.reason || "Not enough observations for uncertainty ranges.")}</div>`;
  $("#strategy-assumptions").textContent =
    `Execution ${result.assumptions?.execution || "close"} · ${result.assumptions?.feeBps ?? 0} bps fees · ${result.assumptions?.slippageBps ?? 0} bps slippage · uncertainty is evidence, not a ranking.`;
  recentStrategyBacktestIds = [
    data.backtestId,
    ...recentStrategyBacktestIds.filter((id) => id !== data.backtestId),
  ].slice(0, 20);
  $("#strategy-compare-ids").value = recentStrategyBacktestIds.join("\n");
}
function strategyDecisionQuery() {
  const params = new URLSearchParams(),
    symbol = $("#strategy-filter-symbol").value.trim().toUpperCase(),
    decision = $("#strategy-filter-decision").value,
    reason = $("#strategy-filter-reason").value.trim(),
    order = $("#strategy-filter-order").value;
  if (symbol) params.set("symbol", symbol);
  if (decision) params.set("decision", decision);
  if (reason) params.set("blockReason", reason);
  if (order) params.set("orderOutcome", order);
  return params.toString() ? `?${params}` : "";
}
function strategyNumber(value, digits = 3) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}
function strategyRatio(value) {
  return value === null || value === undefined ? "—" : pct(Number(value) * 100);
}
function strategyBps(value) {
  return value === null || value === undefined
    ? "—"
    : `${strategyNumber(value, 1)} bps`;
}
function strategyTopCounts(counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  return entries.length
    ? entries
        .slice(0, 3)
        .map(([key, value]) => `${key.replaceAll("_", " ")} ${value}`)
        .join(" · ")
    : "No reasons";
}
function renderStrategyDashboard(dashboard) {
  const stale = dashboard.dataCoverage.staleDataRate,
    blocked = dashboard.decisions.blockedDecisionRate,
    slippage = dashboard.fillQuality.averageSlippageBps,
    slippageClass = slippage === null ? "" : slippage <= 0 ? "gain" : "loss",
    warning = dashboard.warnings?.length
      ? `<div class="warnings" style="grid-column:1/-1">${dashboard.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
      : "";
  $("#strategy-dashboard").innerHTML =
    `${calculationCoveragePanel("Strategy run", dashboard.quality)}<div class="metrics"><div class="metric"><strong>${esc(dashboard.dataCoverage.decisionCount)}</strong><span class="muted">Decisions · ${esc(strategyRatio(blocked))} blocked</span></div><div class="metric"><strong class="${stale && stale > 0 ? "loss" : ""}">${esc(strategyRatio(stale))}</strong><span class="muted">Stale-data rate · ${esc(dashboard.dataCoverage.staleSnapshotCount)} stale snapshots</span></div><div class="metric"><strong>${esc(money.format(dashboard.exposure.netNotional || 0))}</strong><span class="muted">Strategy exposure · ${esc(strategyRatio(dashboard.exposure.budgetUtilization))} of budget</span></div><div class="metric"><strong>${esc(strategyRatio(dashboard.orderExecution.fillRatio))}</strong><span class="muted">${esc(dashboard.orderExecution.filledOrders)} filled / ${esc(dashboard.orderExecution.submittedOrders)} submitted</span></div><div class="metric"><strong class="${slippageClass}">${esc(strategyBps(slippage))}</strong><span class="muted">Avg fill slippage · ${esc(dashboard.fillQuality.sampleCount)} samples</span></div><div class="metric"><strong>${esc(strategyTopCounts(dashboard.decisions.blockReasons))}</strong><span class="muted">Block reasons</span></div>${warning}</div>`;
}
async function loadStrategyDashboard(runId) {
  try {
    renderStrategyDashboard(
      await api(`/api/strategy/runs/${encodeURIComponent(runId)}/dashboard`),
    );
  } catch (error) {
    $("#strategy-dashboard").innerHTML = cardError(
      "Strategy dashboard unavailable",
      error,
      "Persisted run evidence could not be summarized.",
    );
  }
}
function renderStrategyAlerts(data) {
  const alerts = data.alerts || [],
    summary = alerts.length
      ? `${alerts.length} alert${alerts.length === 1 ? "" : "s"} · ${new Date(data.generatedAt).toLocaleTimeString()}`
      : `No active alerts · ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#strategy-alerts").innerHTML =
    `<h3>Strategy alerts</h3><div class="muted">${esc(summary)}</div>${alerts.length ? alerts.map((alert) => `<div class="trace-row"><strong class="${alert.severity === "critical" ? "loss" : ""}">${esc(alert.title)}</strong><span>${esc(alert.message)}<br><span class="muted">${esc(JSON.stringify(alert.evidence))}</span></span><span class="pill">${esc(alert.severity)}</span></div>`).join("") : '<div class="empty">No stale-feed, exception, rejected-order, drawdown, turnover, slippage or reconciliation alerts for this run.</div>'}`;
}
async function loadStrategyAlerts(runId) {
  try {
    renderStrategyAlerts(
      await api(`/api/strategy/runs/${encodeURIComponent(runId)}/alerts`),
    );
  } catch (error) {
    $("#strategy-alerts").innerHTML = cardError(
      "Strategy alerts unavailable",
      error,
      "Alert evidence could not be summarized.",
    );
  }
}
function renderStrategyAudit(data) {
  const entries = data.auditTrail || [],
    verification = data.verification || {},
    status = verification.valid ? "valid" : "broken",
    statusClass = verification.valid ? "gain" : "loss";
  $("#strategy-audit").innerHTML =
    `<h3>Strategy audit trail</h3><div class="muted"><strong class="${statusClass}">${esc(status)}</strong> hash chain · ${esc(entries.length)} entr${entries.length === 1 ? "y" : "ies"}</div>${
      entries.length
        ? entries
            .slice(-5)
            .reverse()
            .map(
              (entry) =>
                `<div class="trace-row"><strong>${esc(String(entry.kind).replaceAll("_", " "))}</strong><span>${esc(entry.subject)} · ${esc(entry.actor)} · retain until ${esc(new Date(entry.retentionUntil).toLocaleDateString())}<br><span class="muted">${esc(entry.entryHash.slice(0, 20))} · prev ${esc(entry.previousHash ? entry.previousHash.slice(0, 20) : "genesis")}</span></span><span class="pill">${esc(new Date(entry.createdAt).toLocaleTimeString())}</span></div>`,
            )
            .join("")
        : '<div class="empty">No lifecycle audit entries have been recorded for this run yet.</div>'
    }`;
}
async function loadStrategyAudit(runId) {
  try {
    renderStrategyAudit(
      await api(`/api/strategy/runs/${encodeURIComponent(runId)}/audit`),
    );
  } catch (error) {
    $("#strategy-audit").innerHTML = cardError(
      "Strategy audit unavailable",
      error,
      "Audit chain could not be summarized.",
    );
  }
}
function strategyPercentValue(value) {
  return value === null || value === undefined ? "—" : pct(Number(value));
}
function strategyWindowLabel(window) {
  if (window.status !== "available")
    return `<span class="muted">${esc(String(window.status).replaceAll("_", " "))}</span>`;
  const value = Number(window.sideAdjustedReturnPercent);
  return `<span class="${value >= 0 ? "gain" : "loss"}">${esc(strategyPercentValue(value))}</span>`;
}
function renderStrategyAttribution(data) {
  const avg = data.summary.averageSideAdjustedReturnPercent || {},
    replay = data.executionReplay,
    rs = replay?.summary || {},
    warning = data.warnings?.length
      ? `<div class="warnings">${data.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
      : "",
    replayMetrics = replay
      ? `<div class="metric"><strong>${esc(rs.fullFills || 0)} / ${esc(rs.partialFills || 0)} / ${esc(rs.missedFills || 0)}</strong><span class="muted">Book replay full / partial / missed</span></div><div class="metric"><strong>${esc(strategyBps(rs.averageReplaySlippageBps))}</strong><span class="muted">Avg replay slippage · ${esc(strategyBps(rs.averageSpreadBps))} spread</span></div>`
      : "",
    metrics = `<div class="metrics"><div class="metric"><strong>${esc(data.summary.filledOrders)} / ${esc(data.summary.orderCount)}</strong><span class="muted">Filled strategy orders</span></div><div class="metric"><strong>${esc(strategyBps(data.summary.averageSlippageBps))}</strong><span class="muted">Average fill slippage</span></div><div class="metric"><strong>${esc(strategyPercentValue(avg["1h"]))}</strong><span class="muted">Avg 1h side-adjusted return</span></div><div class="metric"><strong>${esc(strategyPercentValue(avg["1d"]))}</strong><span class="muted">Avg 1d side-adjusted return</span></div>${replayMetrics}</div>`,
    rows = data.orders.length
      ? data.orders
          .slice(0, 8)
          .map((order) => {
            const book = order.executionReplay,
              bookText = book
                ? ` · book ${String(book.status).replaceAll("_", " ")}`
                : "";
            return `<div class="trace-row"><strong>${esc(order.symbol || "Order")} ${esc(String(order.side || "").toUpperCase())}</strong><span>${order.windows.map((window) => `${esc(window.window)} ${strategyWindowLabel(window)}`).join(" · ")}${book ? `<br><span class="muted">Replay ${esc(book.reason)} · ${esc(strategyBps(book.slippageBps))}</span>` : ""}</span><span class="pill">${esc(order.status)} · ${esc(strategyBps(order.fillQuality?.slippageBps))}${esc(bookText)}</span></div>`;
          })
          .join("")
      : '<div class="empty">No strategy paper orders are linked to this run.</div>';
  $("#strategy-attribution").innerHTML =
    `<h3>Post-fill attribution</h3>${metrics}${warning}<div class="trace-table">${rows}</div>`;
}
async function loadStrategyAttribution(runId) {
  try {
    renderStrategyAttribution(
      await api(`/api/strategy/runs/${encodeURIComponent(runId)}/attribution`),
    );
  } catch (error) {
    $("#strategy-attribution").innerHTML = cardError(
      "Post-fill attribution unavailable",
      error,
      "Broker order state or crypto bars could not be summarized.",
    );
  }
}
function renderStrategyPerformance(data) {
  const s = data.summary,
    b = data.baselines || {},
    warning = data.warnings?.length
      ? `<div class="warnings">${data.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
      : "",
    returnClass =
      s.totalReturnPercent === null
        ? ""
        : s.totalReturnPercent >= 0
          ? "gain"
          : "loss",
    activeBH = b.buyAndHold?.activeReturnPercent,
    activeEW = b.equalWeight?.activeReturnPercent,
    metrics = `<div class="metrics"><div class="metric"><strong class="${returnClass}">${s.totalPnl === null ? "—" : esc(signedMoney(s.totalPnl))}</strong><span class="muted">Strategy P&amp;L · ${esc(strategyPercentValue(s.totalReturnPercent))}</span></div><div class="metric"><strong>${s.maxDrawdownPercent === null ? "—" : esc(strategyPercentValue(s.maxDrawdownPercent))}</strong><span class="muted">Active-run max drawdown</span></div><div class="metric"><strong class="${activeBH === null || activeBH === undefined ? "" : activeBH >= 0 ? "gain" : "loss"}">${esc(strategyPercentValue(activeBH))}</strong><span class="muted">Active return vs buy-and-hold</span></div><div class="metric"><strong class="${activeEW === null || activeEW === undefined ? "" : activeEW >= 0 ? "gain" : "loss"}">${esc(strategyPercentValue(activeEW))}</strong><span class="muted">Active return vs equal weight</span></div></div>`,
    note =
      s.status === "available"
        ? `<div class="muted">Marked ${esc(s.lastMarkAt || "—")} from ${esc(s.filledOrders)} filled order${s.filledOrders === 1 ? "" : "s"}.</div>`
        : '<div class="empty">Active-run performance needs filled strategy paper orders and crypto bars after the first fill.</div>';
  $("#strategy-performance").innerHTML =
    `<h3>Active-run performance</h3>${metrics}${warning}${note}`;
}
async function loadStrategyPerformance(runId) {
  try {
    renderStrategyPerformance(
      await api(`/api/strategy/runs/${encodeURIComponent(runId)}/performance`),
    );
  } catch (error) {
    $("#strategy-performance").innerHTML = cardError(
      "Active-run performance unavailable",
      error,
      "Broker fills or crypto bars could not be summarized.",
    );
  }
}
function renderStrategyRuns() {
  const root = $("#strategy-runs");
  root.innerHTML = strategyRuns.length
    ? strategyRuns
        .map((run) => {
          const schedule = run.config?.schedule,
            approval = run.config?.paperApproval,
            review = run.config?.review,
            interval = schedule?.intervalMinutes
              ? ` · every ${schedule.intervalMinutes}m${schedule.nextRunAt ? " · next " + new Date(schedule.nextRunAt).toLocaleTimeString() : ""}`
              : "",
            paper = approval
              ? ` · paper budget ${money.format(approval.budget)} · expires ${new Date(approval.expiresAt).toLocaleString()}`
              : "",
            reviewText = review?.action ? ` · review ${review.action}` : "",
            backtest = run.backtestId
              ? ` · backtest ${run.backtestId.slice(0, 8)}`
              : " · legacy, not comparable";
          return `<button class="strategy-run ${run.id === activeStrategyRunId ? "active" : ""}" data-run-id="${esc(run.id)}" type="button"><div class="strategy-run-top"><div><strong>${esc(strategyLabels[run.strategyId] || run.strategyId)}</strong><div class="muted">${esc(run.symbols.join(", "))} · ${esc(run.config?.timeframe || "timeframe")} · ${esc(run.config?.days || "—")} days${esc(interval)}${esc(paper)}${esc(reviewText)}</div></div><span class="pill">${esc(run.status)}</span></div><div class="muted">Policy ${esc(run.policyVersion)}${esc(backtest)} · ${esc(new Date(run.createdAt).toLocaleString())}</div></button>`;
        })
        .join("")
    : '<div class="empty">No shadow strategy runs yet. Run and review a backtest before creating one.</div>';
  $("#strategy-tick-button").disabled = !activeStrategyRunId;
  $("#strategy-report-button").disabled = !activeStrategyRunId;
  syncStrategyLifecycleControls();
}
function renderDecisions(decisions) {
  $("#strategy-decisions").innerHTML = decisions.length
    ? `<div class="muted">Recent decisions</div>${decisions.map((item) => `<button class="strategy-run trace-open ${item.traceId === activeTraceId ? "active" : ""}" data-trace-id="${esc(item.traceId)}" type="button"><div class="trace-row"><strong>${esc(item.symbol)}</strong><span>${esc(item.reason)}</span><span class="pill">${esc(item.decision)}</span></div><div class="muted">Signal ${esc(strategyNumber(item.riskAdjustedSignal))} · target ${esc(Number.isFinite(Number(item.targetPosition)) ? pct(Number(item.targetPosition) * 100) : "—")} · order ${esc(item.orderOutcome || "none")} · trace ${esc(item.traceId.slice(0, 8))}</div></button>`).join("")}`
    : '<div class="empty">No matching decisions for this run.</div>';
}
function renderTrace(trace) {
  activeTraceId = trace.traceId;
  const stale = trace.snapshots.filter((snapshot) => snapshot.stale).length,
    snapshotSummary = trace.snapshots.map((snapshot) => ({
      id: snapshot.id,
      symbol: snapshot.symbol,
      source: snapshot.source,
      feed: snapshot.feed,
      observedAt: snapshot.observedAt,
      stale: snapshot.stale,
      latencyMs: snapshot.latencyMs,
      quote: snapshot.payload?.quote,
      trade: snapshot.payload?.trade,
      bar: snapshot.payload?.bar,
      orderbookLevels: {
        asks: snapshot.payload?.orderbook?.a?.length ?? 0,
        bids: snapshot.payload?.orderbook?.b?.length ?? 0,
      },
    }));
  $("#strategy-trace-summary").innerHTML =
    `<div class="metric"><strong class="${trace.decision === "enter" ? "gain" : trace.decision === "block" ? "loss" : ""}">${esc(trace.decision)}</strong><span class="muted">${esc(trace.symbol)} decision</span></div><div class="metric"><strong>${esc(strategyNumber(trace.rawSignal))}</strong><span class="muted">Raw signal</span></div><div class="metric"><strong>${esc(Number.isFinite(Number(trace.targetPosition)) ? pct(Number(trace.targetPosition) * 100) : "—")}</strong><span class="muted">Target exposure</span></div><div class="metric"><strong>${esc(trace.orderOutcome || "none")}</strong><span class="muted">Order outcome</span></div><div class="metric"><strong>${esc(trace.snapshots.length)}</strong><span class="muted">Data snapshots · ${esc(stale)} stale</span></div>`;
  const orderDetail = trace.order
    ? `<h3>Order outcome</h3><div class="trace-row"><strong>${esc(trace.order.paperOrderId || trace.paperOrderId || "Paper order")}</strong><span>${esc(trace.order.status)} · ${esc(JSON.stringify(trace.order.payload || {}))}</span><span class="pill">${esc(trace.orderOutcome)}</span></div>`
    : `<h3>Order outcome</h3><div class="empty">No paper order is linked to this shadow decision.</div>`;
  $("#strategy-trace-detail").innerHTML =
    `<div class="trace-grid"><section><h3>Features</h3>${featureCells(trace.features)}</section><section><h3>Thresholds</h3>${featureCells(trace.thresholds)}</section><section><h3>Risk checks</h3>${featureCells(trace.riskChecks)}</section></div>${orderDetail}<h3>Data provenance</h3><div class="trace-table">${trace.snapshots.length ? trace.snapshots.map((snapshot) => `<div class="trace-row"><strong>${esc(snapshot.symbol)}</strong><span>${esc(snapshot.source)} · ${esc(snapshot.feed)} · ${esc(new Date(snapshot.observedAt).toLocaleString())}</span><span class="pill">${snapshot.stale ? "stale" : "fresh"}</span></div>`).join("") : '<div class="empty">No snapshots linked.</div>'}</div><h3>Trace summary JSON</h3><pre class="trace-json">${esc(JSON.stringify({ traceId: trace.traceId, decision: trace.decision, reason: trace.reason, orderOutcome: trace.orderOutcome, order: trace.order, features: trace.features, thresholds: trace.thresholds, riskChecks: trace.riskChecks, snapshots: snapshotSummary }, null, 2))}</pre>`;
  renderDecisions([...(window.currentStrategyDecisions || [])]);
}
async function loadStrategyTrace(traceId) {
  const trace = await api(
    `/api/strategy/decision-traces/${encodeURIComponent(traceId)}`,
  );
  renderTrace(trace);
}
async function loadStrategyDecisions(runId) {
  const data = await api(
    `/api/strategy/runs/${encodeURIComponent(runId)}/decisions${strategyDecisionQuery()}`,
  );
  window.currentStrategyDecisions = data.decisions;
  renderDecisions(data.decisions);
  if (data.decisions[0]) await loadStrategyTrace(data.decisions[0].traceId);
  else {
    $("#strategy-trace-summary").innerHTML =
      '<div class="empty">No decision trace matches the current filters.</div>';
    $("#strategy-trace-detail").innerHTML = "";
  }
}
async function loadStrategyRuns() {
  const data = await api("/api/strategy/runs");
  strategyRuns = data.runs;
  $("#strategy-runs-asof").textContent =
    `${strategyRuns.length} persisted runs · synced ${new Date(data.asOf).toLocaleTimeString()}`;
  if (!activeStrategyRunId && strategyRuns[0])
    activeStrategyRunId = strategyRuns[0].id;
  if (
    activeStrategyRunId &&
    !strategyRuns.some((run) => run.id === activeStrategyRunId)
  )
    activeStrategyRunId = strategyRuns[0]?.id || null;
  renderStrategyRuns();
  if (activeStrategyRunId)
    await Promise.all([
      loadStrategyDashboard(activeStrategyRunId),
      loadStrategyAlerts(activeStrategyRunId),
      loadStrategyAudit(activeStrategyRunId),
      loadStrategyPerformance(activeStrategyRunId),
      loadStrategyAttribution(activeStrategyRunId),
      loadStrategyDecisions(activeStrategyRunId),
    ]);
  else {
    $("#strategy-dashboard").innerHTML =
      '<div class="empty">Select a run to load dashboard metrics.</div>';
    $("#strategy-alerts").innerHTML =
      '<div class="empty">Strategy alerts will appear after a run has decisions, metrics or paper orders.</div>';
    $("#strategy-audit").innerHTML =
      '<div class="empty">Strategy audit chain appears after run lifecycle changes.</div>';
    $("#strategy-performance").innerHTML =
      '<div class="empty">Active-run P&amp;L will appear after filled paper orders have market bars.</div>';
    $("#strategy-attribution").innerHTML =
      '<div class="empty">Post-fill attribution will appear after paper orders have fill evidence.</div>';
    $("#strategy-decisions").innerHTML = "";
  }
}
function invalidateStrategyBacktest() {
  latestStrategyBacktestId = null;
  $("#strategy-create-button").disabled = true;
}
async function runStrategyBacktest() {
  if (!$("#strategy-form").reportValidity()) return;
  const button = $("#strategy-backtest-button");
  try {
    invalidateStrategyBacktest();
    button.disabled = true;
    $("#strategy-backtest").innerHTML =
      '<div class="empty spin">Running backtest against Alpaca crypto bars…</div>';
    const data = await api("/api/strategy/backtests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...strategyPayload(),
        initialCash: 10000,
        feeBps: Number($("#strategy-fee-bps").value),
        slippageBps: Number($("#strategy-slippage-bps").value),
      }),
    });
    latestStrategyBacktestId = data.backtestId;
    $("#strategy-create-button").disabled = Boolean(
      data.provenance?.workingTreeDirty,
    );
    renderBacktest(data);
  } catch (error) {
    $("#strategy-backtest").innerHTML = cardError(
      "Backtest unavailable",
      error,
      "Crypto bars or parameters could not be evaluated.",
    );
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}
$("#strategy-backtest-button").onclick = runStrategyBacktest;
$("#strategy-form").addEventListener("input", invalidateStrategyBacktest);
$("#strategy-parameter-fields").addEventListener(
  "input",
  syncStrategyJsonFromFields,
);
$("#strategy-params").addEventListener("change", () => {
  try {
    const params = strategyParams();
    renderStrategyParameterFields(params);
  } catch (error) {
    notify(error.message);
  }
});
$("#strategy-preset").addEventListener("change", (event) =>
  applyStrategyParams(
    strategyPresetParams($("#strategy-id").value, event.target.value),
  ),
);
$("#strategy-id").addEventListener("change", (event) => {
  $("#strategy-preset").value = "balanced";
  applyStrategyParams(strategyPresetParams(event.target.value, "balanced"));
  if (event.target.value === "btc-eth-relative-strength")
    $("#strategy-symbol").value = "BTC/USD,ETH/USD";
  else if ($("#strategy-symbol").value.includes(","))
    $("#strategy-symbol").value = "BTC/USD";
});

$("#strategy-compare-form").onsubmit = async (event) => {
  event.preventDefault();
  const ids = $("#strategy-compare-ids")
    .value.split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length < 2)
    return notify("Add at least two backtest IDs to compare.");
  if (ids.length > 20)
    return notify("Compare at most 20 backtest IDs.");
  if (new Set(ids).size !== ids.length)
    return notify("Backtest IDs must be unique.");
  const button = $("#strategy-compare-button"),
    output = $("#strategy-comparison");
  try {
    button.disabled = true;
    button.textContent = "Comparing…";
    output.setAttribute("aria-busy", "true");
    const comparison = await api("/api/strategy/backtests/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backtestIds: ids }),
    });
    output.innerHTML = renderStrategyComparison(comparison);
  } catch (error) {
    output.innerHTML = cardError(
      "Comparison unavailable",
      error,
      "Use persisted backtests produced by the same actor.",
    );
  } finally {
    button.disabled = false;
    button.textContent = "Compare backtests";
    output.setAttribute("aria-busy", "false");
  }
};
$("#strategy-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!latestStrategyBacktestId)
    return notify("Run a clean backtest for these inputs first.");
  const button = $("#strategy-create-button");
  try {
    button.disabled = true;
    const run = await api("/api/strategy/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...strategyPayload(),
        backtestId: latestStrategyBacktestId,
        notes: "Created from Strategy Lab UI",
      }),
    });
    activeStrategyRunId = run.runId;
    notify(`Shadow run ${run.runId.slice(0, 8)} created.`);
    await loadStrategyRuns();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = !latestStrategyBacktestId;
  }
};
$("#strategy-runs").onclick = async (event) => {
  const button = event.target.closest(".strategy-run[data-run-id]");
  if (!button) return;
  activeStrategyRunId = button.dataset.runId;
  activeTraceId = null;
  renderStrategyRuns();
  await Promise.all([
    loadStrategyDashboard(activeStrategyRunId),
    loadStrategyAlerts(activeStrategyRunId),
    loadStrategyPerformance(activeStrategyRunId),
    loadStrategyAttribution(activeStrategyRunId),
    loadStrategyDecisions(activeStrategyRunId),
  ]).catch((error) => notify(error.message));
};
$("#strategy-decisions").onclick = (event) => {
  const button = event.target.closest(".trace-open");
  if (button)
    loadStrategyTrace(button.dataset.traceId).catch((error) =>
      notify(error.message),
    );
};
$("#strategy-tick-button").onclick = async (event) => {
  if (!activeStrategyRunId) return;
  const button = event.currentTarget;
  try {
    button.disabled = true;
    button.textContent = "Ticking…";
    const result = await api(
      `/api/strategy/runs/${encodeURIComponent(activeStrategyRunId)}/tick`,
      { method: "POST" },
    );
    notify(
      `Strategy decision ${String(result.trace?.decision || "recorded")} · order ${String(result.trace?.orderOutcome || "none")} · trace ${result.traceId.slice(0, 8)}.`,
    );
    await Promise.all([
      loadStrategyDashboard(activeStrategyRunId),
      loadStrategyAlerts(activeStrategyRunId),
      loadStrategyPerformance(activeStrategyRunId),
      loadStrategyAttribution(activeStrategyRunId),
      loadStrategyDecisions(activeStrategyRunId),
      loadReceipts(),
      loadOrders(),
      loadClosedBetaReview(),
    ]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.textContent = "Tick selected run";
    button.disabled = false;
  }
};
$("#strategy-scheduler-button").onclick = async (event) => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    button.textContent = "Running…";
    const result = await api("/api/strategy/scheduler/tick", {
      method: "POST",
    });
    notify(
      `Scheduler checked ${result.checked} runs · evaluated ${result.due}.`,
    );
    await Promise.all([
      loadStrategyRuns(),
      loadReceipts(),
      loadClosedBetaReview(),
    ]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.textContent = "Run scheduler";
    button.disabled = false;
  }
};
$("#strategy-report-button").onclick = async (event) => {
  if (!activeStrategyRunId) return;
  const button = event.currentTarget;
  try {
    button.disabled = true;
    button.textContent = "Exporting…";
    const report = await api(
        `/api/strategy/runs/${encodeURIComponent(activeStrategyRunId)}/report`,
      ),
      blob = new Blob([JSON.stringify(report, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = `strategy-report-${activeStrategyRunId.slice(0, 8)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify("Strategy experiment report exported.");
  } catch (error) {
    notify(error.message);
  } finally {
    button.textContent = "Export report";
    button.disabled = false;
  }
};
$("#strategy-protocol-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!activeStrategyRunId) return notify("Select a strategy run first.");
  const button = $("#strategy-protocol-submit"),
    criteria = $("#strategy-protocol-invalidation")
      .value.split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  let startAt, stopAt;
  try {
    startAt = new Date($("#strategy-protocol-start").value).toISOString();
    stopAt = new Date($("#strategy-protocol-stop").value).toISOString();
  } catch {
    return notify("Add valid protocol start and stop dates.");
  }
  try {
    button.disabled = true;
    button.textContent = "Registering…";
    await api(
      `/api/strategy/runs/${encodeURIComponent(activeStrategyRunId)}/experiment-protocol`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hypothesis: $("#strategy-protocol-hypothesis").value.trim(),
          startAt,
          stopAt,
          minimumObservations: Number(
            $("#strategy-protocol-observations").value,
          ),
          maximumBudget: Number($("#strategy-protocol-budget").value),
          invalidationCriteria: criteria,
          reviewCadenceDays: Number($("#strategy-protocol-cadence").value),
        }),
      },
    );
    notify("Paper experiment protocol registered.");
    await loadStrategyRuns();
  } catch (error) {
    notify(error.message);
  } finally {
    button.textContent = "Register protocol";
    syncStrategyLifecycleControls();
  }
};
$("#strategy-paper-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!activeStrategyRunId) return notify("Select a strategy run first.");
  if (!activeStrategyRun()?.config?.experimentProtocol)
    return notify("Register the paper experiment protocol first.");
  const body = {
    budget: Number($("#strategy-paper-budget").value),
    maxPositionNotional: Number($("#strategy-paper-max-position").value),
    maxOrderNotional: Number($("#strategy-paper-max-order").value),
    minOrderNotional: Number($("#strategy-paper-min-order").value),
    maxSpreadBps: Number($("#strategy-paper-max-spread").value),
    expiresHours: Number($("#strategy-paper-expires").value),
    timeInForce: $("#strategy-paper-tif").value,
    maxDailyLossPercent: Number($("#strategy-paper-max-daily-loss").value),
    maxDrawdownPercent: Number($("#strategy-paper-max-drawdown").value),
    maxDailyTurnoverPercent: Number($("#strategy-paper-max-turnover").value),
    errorCooldownMinutes: Number($("#strategy-paper-cooldown").value),
  };
  if (
    !(await dangerReviewDialog(
      `Approve this selected strategy for PAPER crypto automation?\n\nBudget: ${money.format(body.budget)}\nMax position: ${money.format(body.maxPositionNotional)}\nMax order: ${money.format(body.maxOrderNotional)}\nMax spread: ${body.maxSpreadBps} bps\nMax daily loss: ${body.maxDailyLossPercent}%\nMax drawdown: ${body.maxDrawdownPercent}%\nMax daily turnover: ${body.maxDailyTurnoverPercent}%\nError cooldown: ${body.errorCooldownMinutes} minutes\nExpires in: ${body.expiresHours} hours\nTime in force: ${body.timeInForce.toUpperCase()}\n\nApproved ticks may submit bounded Alpaca paper crypto market orders. Live trading remains unavailable.`,
      "Approve paper automation",
    ))
  )
    return;
  const button = $("#strategy-paper-approve");
  try {
    button.disabled = true;
    const run = await api(
      `/api/strategy/runs/${encodeURIComponent(activeStrategyRunId)}/paper-approval`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    notify(
      `Paper automation approved for ${run.runId?.slice?.(0, 8) || activeStrategyRunId.slice(0, 8)}.`,
    );
    await Promise.all([loadStrategyRuns(), loadClosedBetaReview()]);
  } catch (error) {
    notify(error.message);
  } finally {
    syncStrategyLifecycleControls();
  }
};
$("#strategy-review-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!activeStrategyRunId) return notify("Select a strategy run first.");
  const action = $("#strategy-review-action").value,
    note = $("#strategy-review-note").value.trim(),
    revision = $("#strategy-review-revision").value.trim(),
    body = {
      action,
      note,
      ...(revision ? { revision: { summary: revision } } : {}),
    };
  if (!note) return notify("Add a review note first.");
  const consequence =
    action === "promote"
      ? "Promote records the experiment as complete; it does not enable live trading."
      : action === "retire"
        ? "Retire records the experiment as retired and sets the paper kill switch."
        : action === "revise"
          ? "Revise returns the run to shadow review with revision notes."
          : action === "pause"
            ? "Pause stops scheduled/paper evaluation until reviewed again."
            : "Continue keeps the run active for more evidence.";
  if (
    !(await reviewDialog(
      `Save ${action.toUpperCase()} review for this strategy run?\n\n${note}\n\n${consequence}`,
    ))
  )
    return;
  const button = $("#strategy-review-submit");
  try {
    button.disabled = true;
    await api(
      `/api/strategy/runs/${encodeURIComponent(activeStrategyRunId)}/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    $("#strategy-review-note").value = "";
    $("#strategy-review-revision").value = "";
    notify(`Strategy review saved: ${action}.`);
    await Promise.all([loadStrategyRuns(), loadClosedBetaReview()]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#strategy-pause-button").onclick = async () => {
  if (!activeStrategyRunId) return notify("Select a strategy run first.");
  if (
    !(await reviewDialog(
      "Pause the selected strategy run? Scheduled ticks and paper orders will stop until it is re-approved or resumed by a future workflow.",
    ))
  )
    return;
  await api(
    `/api/strategy/runs/${encodeURIComponent(activeStrategyRunId)}/pause`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Paused from Strategy Lab UI" }),
    },
  )
    .then(() => loadStrategyRuns())
    .catch((error) => notify(error.message));
};
$("#strategy-kill-button").onclick = async () => {
  if (!activeStrategyRunId) return notify("Select a strategy run first.");
  if (
    !(await dangerReviewDialog(
      "Activate the kill switch and retire this strategy run? This cannot submit more scheduled strategy paper orders.",
      "Kill and retire run",
    ))
  )
    return;
  await api(
    `/api/strategy/runs/${encodeURIComponent(activeStrategyRunId)}/kill`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "Kill switch activated from Strategy Lab UI",
      }),
    },
  )
    .then(() => loadStrategyRuns())
    .catch((error) => notify(error.message));
};
let cryptoOrderPreviewToken = null,
  cryptoOrderPreview = null;
function syncCryptoOrderFields() {
  const type = $("#crypto-order-type").value,
    side = $("#crypto-order-side").value,
    amountType = $("#crypto-order-amount-type"),
    quantityOnly = type !== "market" || side === "sell";
  if (quantityOnly) {
    amountType.value = "quantity";
    amountType.disabled = true;
  } else amountType.disabled = false;
  $("#crypto-order-limit").hidden = type === "market";
  $("#crypto-order-stop").hidden = type !== "stop_limit";
  $("#crypto-order-amount").setAttribute(
    "aria-label",
    amountType.value === "notional"
      ? "Crypto dollar amount"
      : "Crypto quantity",
  );
}
function cryptoOrderTicket() {
  const amountType = $("#crypto-order-amount-type").value;
  return {
    symbol: $("#crypto-order-symbol").value,
    side: $("#crypto-order-side").value,
    type: $("#crypto-order-type").value,
    amountType,
    qty:
      amountType === "quantity" ? $("#crypto-order-amount").value : undefined,
    notional:
      amountType === "notional" ? $("#crypto-order-amount").value : undefined,
    limitPrice: $("#crypto-order-limit").hidden
      ? null
      : $("#crypto-order-limit").value || null,
    stopPrice: $("#crypto-order-stop").hidden
      ? null
      : $("#crypto-order-stop").value || null,
    timeInForce: $("#crypto-order-tif").value,
  };
}
function renderCryptoOrderPreview(data) {
  const p = data.preview,
    base = String(p.symbol || "").split("/")[0],
    amount =
      p.amountType === "notional"
        ? money.format(p.notional)
        : `${p.estimatedQty.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${base}`,
    spread = p.spreadBps === null ? "—" : `${p.spreadBps.toFixed(1)} bps`,
    warnings = p.warnings?.length
      ? `<div class="warnings">${p.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
      : "";
  $("#crypto-order-preview").innerHTML =
    `<div class="metric"><strong>${esc(String(p.side).toUpperCase())} ${esc(amount)}</strong><span class="muted">${esc(p.symbol)} · ${esc(String(p.type).replaceAll("_", " "))} · ${esc(String(p.timeInForce).toUpperCase())}</span></div><div class="metric"><strong>${esc(money.format(p.estimatedNotional))}</strong><span class="muted">Estimated notional</span></div><div class="metric"><strong>${esc(money.format(p.referencePrice))}</strong><span class="muted">Crypto reference price</span></div><div class="metric"><strong>${esc(spread)}</strong><span class="muted">Spread guardrail</span></div>${warnings}<div class="ticket-row" style="margin-top:12px"><button class="primary" id="crypto-order-submit" type="button">Submit paper crypto order</button></div>`;
}
["crypto-order-side", "crypto-order-type", "crypto-order-amount-type"].forEach(
  (id) => $(`#${id}`).addEventListener("change", syncCryptoOrderFields),
);
syncCryptoOrderFields();
$("#crypto-order-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#crypto-order-preview-button");
  try {
    button.disabled = true;
    button.classList.add("spin");
    cryptoOrderPreviewToken = null;
    cryptoOrderPreview = null;
    $("#crypto-order-preview").innerHTML =
      '<div class="empty spin">Reviewing crypto market data and paper account limits…</div>';
    const result = await api("/api/strategy/crypto/order-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cryptoOrderTicket()),
    });
    cryptoOrderPreviewToken = result.previewToken;
    cryptoOrderPreview = result.preview;
    renderCryptoOrderPreview(result);
  } catch (error) {
    $("#crypto-order-preview").innerHTML = cardError(
      "Crypto order preview unavailable",
      error,
      "Paper crypto order checks could not be completed.",
    );
    notify(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove("spin");
  }
};
$("#crypto-order-preview").onclick = async (event) => {
  const button = event.target.closest("#crypto-order-submit");
  if (!button) return;
  if (!cryptoOrderPreviewToken || !cryptoOrderPreview)
    return notify("Review the crypto order first.");
  const p = cryptoOrderPreview,
    amount =
      p.amountType === "notional"
        ? money.format(p.notional)
        : `${p.estimatedQty.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${String(p.symbol).split("/")[0]}`,
    prices = [
      p.limitPrice ? `Limit ${money.format(p.limitPrice)}` : "",
      p.stopPrice ? `Stop ${money.format(p.stopPrice)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  if (
    !(await reviewDialog(
      `${String(p.side).toUpperCase()} ${amount} of ${p.symbol}?\n\nType: ${String(p.type).replaceAll("_", " ")} ${String(p.timeInForce).toUpperCase()}${prices ? `\n${prices}` : ""}\nEstimated notional: ${money.format(p.estimatedNotional)}\nReference price: ${money.format(p.referencePrice)}\nSpread: ${p.spreadBps === null ? "—" : p.spreadBps.toFixed(1) + " bps"}\n\nThe order will be revalidated against fresh crypto market data and paper account state.`,
    ))
  )
    return;
  try {
    button.disabled = true;
    button.textContent = "Submitting…";
    const submitted = await api("/api/strategy/crypto/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        previewToken: cryptoOrderPreviewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    cryptoOrderPreviewToken = null;
    notify(
      `Crypto order ${String(submitted.status || "submitted").replaceAll("_", " ")}. Receipt ${submitted.receiptId.slice(0, 8)} created.`,
    );
    await Promise.all([
      loadOrders(),
      loadReceipts(),
      load(),
      loadOperationsPolicy(),
      loadClosedBetaReview(),
    ]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Submit paper crypto order";
  }
};
[
  "strategy-filter-symbol",
  "strategy-filter-decision",
  "strategy-filter-reason",
  "strategy-filter-order",
].forEach((id) => {
  $(`#${id}`).addEventListener("change", () => {
    if (activeStrategyRunId)
      loadStrategyDecisions(activeStrategyRunId).catch((error) =>
        notify(error.message),
      );
  });
});
$("#strategy-refresh").onclick = () =>
  loadStrategyRuns().catch((error) => notify(error.message));
document
  .querySelector('[data-view="strategies"]')
  .addEventListener("click", () =>
    loadStrategyRuns().catch((error) => notify(error.message)),
  );
addEventListener("hashchange", () => {
  if (location.hash === "#strategies")
    loadStrategyRuns().catch((error) => notify(error.message));
});
if (location.hash === "#strategies")
  queueMicrotask(() =>
    loadStrategyRuns().catch((error) => notify(error.message)),
  );

[...document.querySelectorAll("#strategy-paper-form .field")].forEach(
  (field) => {
    if (field.closest(".control-label")) return;
    const label = document.createElement("label"),
      caption = document.createElement("span");
    label.className = "control-label";
    caption.textContent = field.getAttribute("aria-label") || "Value";
    field.replaceWith(label);
    label.append(caption, field);
  },
);
applyStrategyParams(
  strategyPresetParams($("#strategy-id").value, $("#strategy-preset").value),
);
syncStrategyLifecycleControls();
