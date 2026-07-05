let strategyRuns = [],
  activeStrategyRunId = null,
  activeTraceId = null,
  latestStrategyBacktestId = null;
const strategyLabels = {
  cash: "Cash baseline",
  "buy-and-hold": "Buy and hold",
  "time-sliced-accumulation": "Time-sliced accumulation",
  "moving-average-trend": "Moving average trend",
  "breakout-momentum": "Breakout momentum",
  "volatility-filter": "Volatility filter",
  "btc-eth-relative-strength": "BTC/ETH relative strength",
  "order-book-liquidity-scout": "Order-book liquidity scout",
  "mean-reversion": "Mean reversion",
};
const strategyDefaultParams = {
  cash: {},
  "buy-and-hold": {},
  "time-sliced-accumulation": { slices: 10, maxExposure: 1 },
  "moving-average-trend": { fast: 5, slow: 20, exposure: 1 },
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
function strategyParams() {
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
function strategyLineChart(points) {
  return equityChart(points.map((point) => ({ equity: point.equity })));
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
    `<div class="metric"><strong>${esc(dashboard.dataCoverage.decisionCount)}</strong><span class="muted">Decisions · ${esc(strategyRatio(blocked))} blocked</span></div><div class="metric"><strong class="${stale && stale > 0 ? "loss" : ""}">${esc(strategyRatio(stale))}</strong><span class="muted">Stale-data rate · ${esc(dashboard.dataCoverage.staleSnapshotCount)} stale snapshots</span></div><div class="metric"><strong>${esc(money.format(dashboard.exposure.netNotional || 0))}</strong><span class="muted">Strategy exposure · ${esc(strategyRatio(dashboard.exposure.budgetUtilization))} of budget</span></div><div class="metric"><strong>${esc(strategyRatio(dashboard.orderExecution.fillRatio))}</strong><span class="muted">${esc(dashboard.orderExecution.filledOrders)} filled / ${esc(dashboard.orderExecution.submittedOrders)} submitted</span></div><div class="metric"><strong class="${slippageClass}">${esc(strategyBps(slippage))}</strong><span class="muted">Avg fill slippage · ${esc(dashboard.fillQuality.sampleCount)} samples</span></div><div class="metric"><strong>${esc(strategyTopCounts(dashboard.decisions.blockReasons))}</strong><span class="muted">Block reasons</span></div>${warning}`;
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
        slippageBps: 5,
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
$("#strategy-id").addEventListener("change", (event) => {
  invalidateStrategyBacktest();
  $("#strategy-params").value = JSON.stringify(
    strategyDefaultParams[event.target.value] ?? {},
  );
  if (event.target.value === "btc-eth-relative-strength")
    $("#strategy-symbol").value = "BTC/USD,ETH/USD";
  else if ($("#strategy-symbol").value.includes(","))
    $("#strategy-symbol").value = "BTC/USD";
});
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
      loadClosedBetaEvidence(),
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
      loadClosedBetaEvidence(),
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
$("#strategy-paper-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!activeStrategyRunId) return notify("Select a strategy run first.");
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
    !(await reviewDialog(
      `Approve this selected strategy for PAPER crypto automation?\n\nBudget: ${money.format(body.budget)}\nMax position: ${money.format(body.maxPositionNotional)}\nMax order: ${money.format(body.maxOrderNotional)}\nMax spread: ${body.maxSpreadBps} bps\nMax daily loss: ${body.maxDailyLossPercent}%\nMax drawdown: ${body.maxDrawdownPercent}%\nMax daily turnover: ${body.maxDailyTurnoverPercent}%\nError cooldown: ${body.errorCooldownMinutes} minutes\nExpires in: ${body.expiresHours} hours\nTime in force: ${body.timeInForce.toUpperCase()}\n\nApproved ticks may submit bounded Alpaca paper crypto market orders. Live trading remains unavailable.`,
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
    await Promise.all([loadStrategyRuns(), loadClosedBetaEvidence()]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
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
    await Promise.all([loadStrategyRuns(), loadClosedBetaEvidence()]);
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
    !(await reviewDialog(
      "Activate the kill switch and retire this strategy run? This cannot submit more scheduled strategy paper orders.",
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
      loadClosedBetaEvidence(),
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
