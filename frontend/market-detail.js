/** Company-market, identity/provider enrichment, and option-workspace UI. */
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
let companyPeriod = "3M",
  companyBenchmark = "SPY",
  companyStream,
  companyStreamSymbol = "",
  companyStreamLastAt = 0,
  companyCoreSession = false,
  companyChartBars = [],
  companyChartBenchmark = null;
function candlestickChart(bars, benchmark) {
  const values = bars.slice(-110),
    comparison = (benchmark?.bars || []).slice(-110);
  if (values.length < 2)
    return '<div class="empty">More daily bars are needed to draw the chart.</div>';
  const width = 720,
    height = 280,
    priceHeight = 215,
    pad = 10,
    base = values[0].close,
    benchmarkBase = comparison[0]?.close,
    comparable = benchmarkBase
      ? comparison.map((bar) => ({
          ...bar,
          equivalent: (bar.close / benchmarkBase) * base,
        }))
      : [],
    min = Math.min(
      ...values.map((bar) => bar.low),
      ...comparable.map((bar) => bar.equivalent),
    ),
    max = Math.max(
      ...values.map((bar) => bar.high),
      ...comparable.map((bar) => bar.equivalent),
    ),
    range = max - min || 1,
    maxVolume = Math.max(...values.map((bar) => bar.volume), 1),
    step = (width - pad * 2) / values.length,
    bodyWidth = Math.max(1.5, Math.min(7, step * 0.62)),
    y = (price) => pad + ((max - price) / range) * (priceHeight - pad * 2);
  const candles = values
      .map((bar, index) => {
        const x = pad + (index + 0.5) * step,
          open = y(bar.open),
          close = y(bar.close),
          high = y(bar.high),
          low = y(bar.low),
          up = bar.close >= bar.open,
          top = Math.min(open, close),
          bodyHeight = Math.max(1.5, Math.abs(open - close)),
          volumeHeight = (bar.volume / maxVolume) * 44;
        return `<line class="candle-wick" x1="${x.toFixed(2)}" y1="${high.toFixed(2)}" x2="${x.toFixed(2)}" y2="${low.toFixed(2)}"/><rect class="${up ? "candle-up" : "candle-down"}" x="${(x - bodyWidth / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}"/><rect class="volume-bar" x="${(x - bodyWidth / 2).toFixed(2)}" y="${(height - pad - volumeHeight).toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${volumeHeight.toFixed(2)}"/>`;
      })
      .join(""),
    line =
      comparable.length > 1
        ? `<polyline class="benchmark-line" points="${comparable.map((bar, index) => `${(pad + (index / (comparable.length - 1)) * (width - pad * 2)).toFixed(2)},${y(bar.equivalent).toFixed(2)}`).join(" ")}"/>`
        : "";
  return `<div class="chart-legend"><span><i class="legend-line"></i>${esc(benchmark?.symbol || "Benchmark")} normalized to company start</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily candlestick and volume chart from ${esc(money.format(values[0].close))} to ${esc(money.format(values.at(-1).close))}, compared with ${esc(benchmark?.symbol || "benchmark")}">${candles}${line}</svg>`;
}
function startCompanyStream(symbol) {
  if (!window.EventSource) return;
  if (companyStream && companyStreamSymbol === symbol) return;
  companyStream?.close();
  companyStreamSymbol = symbol;
  companyStreamLastAt = 0;
  const status = $("#company-stream-status");
  if (status) status.textContent = "Connecting live IEX…";
  companyStream = new EventSource(
    `/api/market/stream?symbols=${encodeURIComponent(symbol)}`,
  );
  companyStream.onmessage = (event) => {
    const update = JSON.parse(event.data),
      badge = $("#company-stream-status");
    if (update.kind === "status") {
      if (badge)
        badge.textContent =
          update.state === "authenticated"
            ? "Live IEX connected"
            : `IEX ${String(update.state).replaceAll("_", " ")}`;
      return;
    }
    if (update.symbol !== companyStreamSymbol) return;
    companyStreamLastAt = Date.parse(update.timestamp);
    if (badge)
      badge.textContent = `Live IEX · ${new Date(update.timestamp).toLocaleTimeString()}`;
    if (update.kind === "quote") {
      if (update.midpoint !== null)
        $("#live-company-price").textContent = money.format(update.midpoint);
      $("#live-company-spread").textContent =
        update.spreadBps === null ? "—" : `${update.spreadBps.toFixed(1)} bps`;
    } else if (update.kind === "bar") {
      const date = update.timestamp.slice(0, 10),
        last = companyChartBars.at(-1);
      // Minute stream bars update the current daily candle; a new session
      // appends a candle instead of duplicating the same date.
      if (last?.timestamp.startsWith(date))
        companyChartBars[companyChartBars.length - 1] = {
          ...last,
          high: Math.max(last.high, update.high),
          low: Math.min(last.low, update.low),
          close: update.close,
          volume: last.volume + update.volume,
          vwap: update.vwap ?? last.vwap,
        };
      else companyChartBars.push(update);
      $("#company-chart").innerHTML = candlestickChart(
        companyChartBars,
        companyChartBenchmark,
      );
    }
  };
  companyStream.onerror = () => {
    const badge = $("#company-stream-status");
    if (badge) badge.textContent = "IEX reconnecting…";
  };
}
setInterval(() => {
  const badge = $("#company-stream-status");
  if (
    badge &&
    companyCoreSession &&
    companyStreamLastAt &&
    Date.now() - companyStreamLastAt > 120_000
  )
    badge.textContent = "Live IEX stale · reconnecting";
}, 30_000);
async function loadCompanyMarket(
  symbol = $("#research-symbol").value.trim().toUpperCase(),
  period = companyPeriod,
  benchmark = companyBenchmark,
) {
  if (!symbol) return;
  resetComparableTable(symbol);
  const button = $("#company-button");
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    const data = await api(
        `/api/company/market?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&benchmark=${encodeURIComponent(benchmark)}`,
      ),
      q = data.quote,
      s = data.stats,
      c = data.company,
      b = data.benchmark;
    companyPeriod = period;
    companyBenchmark = b.symbol;
    companyCoreSession = ["open", "core", "continuous"].includes(
      String(data.session.phase).toLowerCase(),
    );
    $("#company-benchmark").value = b.symbol;
    $("#research-symbol").value = c.symbol;
    $("#order-symbol").value = c.symbol;
    $("#company-periods")
      .querySelectorAll("button")
      .forEach((item) =>
        item.classList.toggle("active", item.dataset.period === period),
      );
    $("#company-title").textContent = `${c.name} · ${c.symbol}`;
    $("#company-asof").textContent =
      `${c.exchange} · ${data.session.phase.replaceAll("_", " ")} · IEX data · updated ${new Date(data.asOf).toLocaleTimeString()}`;
    $("#company-meta").innerHTML =
      [
        c.tradable ? "Tradable" : "Not tradable",
        c.fractionable ? "Fractional" : "Whole shares",
        c.shortable ? "Shortable" : "Not shortable",
        c.marginable ? "Marginable" : "Cash only",
      ]
        .map((label) => `<span class="pill">${esc(label)}</span>`)
        .join("") +
      '<span class="pill" id="company-stream-status">Connecting live IEX…</span>';
    $("#company-metrics").innerHTML =
      `<div class="metric"><strong id="live-company-price">${q.price === null ? "—" : esc(money.format(q.price))}</strong><span class="muted">Last trade</span></div><div class="metric"><strong class="${s.dayChangePercent === null ? "" : s.dayChangePercent >= 0 ? "gain" : "loss"}">${s.dayChangePercent === null ? "—" : esc(pct(s.dayChangePercent))}</strong><span class="muted">Change vs previous close</span></div><div class="metric"><strong id="live-company-spread">${q.spreadBps === null ? "—" : esc(q.spreadBps.toFixed(1)) + " bps"}</strong><span class="muted">Bid–ask spread</span></div><div class="metric"><strong class="${b.relativeStrengthPercent === null ? "" : b.relativeStrengthPercent >= 0 ? "gain" : "loss"}">${b.relativeStrengthPercent === null ? "—" : esc(pct(b.relativeStrengthPercent))}</strong><span class="muted">Relative strength vs ${esc(b.symbol)}</span></div>`;
    const qualityMessages = {
        healthy:
          "Quote is current and the spread is within the configured quality threshold.",
        market_closed:
          "The market is closed; this is the last observed IEX quote.",
        stale:
          "The market is open but the latest quote is stale. Do not rely on it for execution.",
        wide: "The latest spread is unusually wide. Use limit-price controls and verify liquidity.",
        unavailable: "No valid two-sided quote is available.",
      },
      benchmarkWarning =
        b.quality === "complete"
          ? ""
          : ` Benchmark coverage for ${b.symbol} is insufficient; relative strength is unavailable.`;
    $("#company-quality").innerHTML =
      `<div class="${["stale", "wide", "unavailable"].includes(q.quality) || benchmarkWarning ? "warnings" : "muted"}" style="margin-top:12px">${esc(qualityMessages[q.quality] || "Quote quality is unknown.")} ${q.quoteAt ? `Quote ${esc(new Date(q.quoteAt).toLocaleString())}.` : ""}${esc(benchmarkWarning)}</div>`;
    companyChartBars = [...data.bars];
    companyChartBenchmark = b;
    $("#company-chart").innerHTML = candlestickChart(companyChartBars, b);
    startCompanyStream(c.symbol);
    $("#company-stats").innerHTML = [
      [
        "Period return",
        s.periodReturnPercent === null ? "—" : pct(s.periodReturnPercent),
      ],
      [
        `${b.symbol} return`,
        b.returnPercent === null ? "—" : pct(b.returnPercent),
      ],
      ["Period high", s.periodHigh === null ? "—" : money.format(s.periodHigh)],
      ["Period low", s.periodLow === null ? "—" : money.format(s.periodLow)],
      [
        "Relative volume",
        s.relativeVolume === null ? "—" : s.relativeVolume.toFixed(2) + "×",
      ],
      [
        "Current volume",
        s.currentVolume === null ? "—" : compactNumber.format(s.currentVolume),
      ],
      [
        "20-day average",
        s.averageVolume20d === null
          ? "—"
          : compactNumber.format(s.averageVolume20d),
      ],
      [
        "Bid / ask",
        q.bid === null || q.ask === null
          ? "—"
          : `${money.format(q.bid)} / ${money.format(q.ask)}`,
      ],
    ]
      .map(
        ([label, value]) =>
          `<div class="market-stat"><span class="muted">${esc(label)}</span><strong>${esc(value)}</strong></div>`,
      )
      .join("");
    $("#company-news").innerHTML = data.news.length
      ? data.news
          .map(
            (article) =>
              `<article class="news-item"><div>${article.url ? `<a href="${esc(safeUrl(article.url))}" target="_blank" rel="noopener noreferrer">${esc(article.headline)}</a>` : `<strong>${esc(article.headline)}</strong>`}<div class="muted">${esc(article.summary || "No summary available.")}</div></div><div class="news-source"><strong>${esc(article.source)}</strong><div class="muted">${esc(new Date(article.createdAt).toLocaleString())}</div></div></article>`,
          )
          .join("")
      : '<div class="empty">No recent Alpaca news was available. This does not mean there are no material developments.</div>';
  } catch (error) {
    $("#company-metrics").innerHTML =
      `<div class="empty">${esc(error.message)}</div>`;
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "View company";
  }
}
let openFigiIdentitySymbol = null;
function renderOpenFigiIdentity(data) {
  const status = String(data.status || "unavailable").replaceAll("_", " "),
    keyStatus = String(data.keyStatus || "anonymous").replaceAll("_", " ");
  $("#openfigi-asof").textContent =
    `OpenFIGI v3 · ${status} · ${keyStatus} access · updated ${new Date(data.asOf).toLocaleTimeString()}`;
  const notices = (data.warnings || []).length
      ? `<div class="warnings">${data.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
      : "",
    selected = data.selected;
  if (selected) {
    const fields = [
      ["Canonical FIGI", data.canonicalFigi],
      ["Instrument FIGI", selected.figi],
      ["Share-class FIGI", selected.shareClassFigi],
      ["Mapped name", selected.name],
      ["Security type", selected.securityType2 || selected.securityType],
      ["Exchange scope", selected.exchangeCode],
      [
        "Match quality",
        String(data.matchQuality || "matched").replaceAll("_", " "),
      ],
    ];
    return `${notices}<div class="identity-grid">${fields.map(([label, value]) => `<div class="identity-field"><span class="muted">${esc(label)}</span><strong>${esc(value || "—")}</strong></div>`).join("")}</div><div class="eval-note">This canonical FIGI is the cross-provider security identity for the current research run. Ticker text remains display metadata.</div>`;
  }
  if (data.candidates?.length) {
    return `${notices}<div class="identity-candidates">${data.candidates.map((item) => `<div class="identity-candidate"><strong>${esc(item.name)} · ${esc(item.ticker)}</strong><span class="muted">${esc(item.compositeFigi || item.figi)} · ${esc(item.securityType2 || item.securityType || "type unavailable")}</span></div>`).join("")}</div><div class="eval-note">No candidate was selected. Cross-provider joins remain symbol-scoped until the ambiguity is resolved.</div>`;
  }
  return (
    notices ||
    '<div class="empty">No OpenFIGI identity evidence is available. Cross-provider joins remain symbol-scoped.</div>'
  );
}
async function loadOpenFigiIdentity(
  symbol = $("#research-symbol").value.trim().toUpperCase(),
) {
  if (!symbol || symbol === openFigiIdentitySymbol) return;
  const root = $("#openfigi-identity");
  root.innerHTML = '<div class="empty spin">Loading OpenFIGI identity…</div>';
  try {
    const data = await api(
      `/api/research/openfigi?symbol=${encodeURIComponent(symbol)}`,
    );
    root.innerHTML = renderOpenFigiIdentity(data);
    openFigiIdentitySymbol = symbol;
  } catch (error) {
    $("#openfigi-asof").textContent =
      "OpenFIGI identity unavailable · cross-provider joins remain symbol-scoped";
    root.innerHTML = `<div class="warnings"><div>${esc(error.message)}</div></div>`;
    throw error;
  }
}
let gdeltSignalSymbol = null;
function renderGdeltSignals(data) {
  $("#gdelt-asof").textContent =
    `GDELT · ${data.windowDays}-day window · ${data.available ? "updated " + new Date(data.asOf).toLocaleTimeString() : "coverage unavailable"} · media signal, not verified fact`;
  const notices = (data.warnings || []).length
    ? `<div class="warnings">${data.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
    : "";
  if (!data.available)
    return (
      notices ||
      '<div class="warnings"><div>GDELT is temporarily unavailable.</div></div>'
    );
  if (!data.articles?.length)
    return `${notices}<div class="empty">No headline-relevant GDELT media signals were returned. This does not imply that no material event exists.</div>`;
  return `${notices}${data.articles.map((article) => `<article class="news-item"><div><a href="${esc(safeUrl(article.url))}" target="_blank" rel="noopener noreferrer">${esc(article.headline)}</a><div class="muted gdelt-signal-meta">${esc(article.domain)} · ${esc(article.language)} · ${esc(article.sourceCountry)} · public-web media signal</div></div><div class="news-source"><strong>GDELT</strong><div class="muted">${esc(new Date(article.publishedAt).toLocaleString())}</div></div></article>`).join("")}`;
}
async function loadGdeltSignals(
  symbol = $("#research-symbol").value.trim().toUpperCase(),
) {
  if (!symbol || symbol === gdeltSignalSymbol) return;
  const root = $("#gdelt-news");
  root.innerHTML = '<div class="empty spin">Loading GDELT coverage…</div>';
  try {
    const data = await api(
      `/api/research/gdelt?symbol=${encodeURIComponent(symbol)}`,
    );
    root.innerHTML = renderGdeltSignals(data);
    gdeltSignalSymbol = symbol;
  } catch (error) {
    $("#gdelt-asof").textContent =
      "GDELT coverage unavailable · media signal, not verified fact";
    root.innerHTML = `<div class="warnings"><div>${esc(error.message)}</div></div>`;
    throw error;
  }
}
let finnhubEnrichmentSymbol = null;
function renderFinnhubEnrichment(data) {
  const status = String(data.status || "unavailable").replaceAll("_", " ");
  $("#finnhub-asof").textContent =
    `Finnhub · ${status} · ${data.configured ? "updated " + new Date(data.asOf).toLocaleTimeString() : "optional API key not configured"} · SEC remains authoritative`;
  const notices = (data.warnings || []).length
    ? `<div class="warnings">${data.warnings.map((item) => `<div>${esc(item)}</div>`).join("")}</div>`
    : "";
  if (!data.configured)
    return (
      notices ||
      '<div class="empty">Optional Finnhub enrichment is not configured.</div>'
    );
  const number = (value) =>
      Number.isFinite(value)
        ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(
            value,
          )
        : "—",
    profile = data.profile,
    profileFields = profile
      ? [
          ["Company", profile.name],
          ["Exchange", profile.exchange],
          ["Industry", profile.industry],
          ["Country", profile.country],
          ["Currency", profile.currency],
          ["IPO date", profile.ipoDate],
        ]
      : [],
    profileHtml = profileFields.length
      ? `<div class="finnhub-profile">${profileFields.map(([label, value]) => `<div class="finnhub-field"><span class="muted">${esc(label)}</span><strong>${esc(value || "—")}</strong></div>`).join("")}${profile.webUrl ? `<div class="finnhub-field"><span class="muted">Company site</span><a href="${esc(safeUrl(profile.webUrl))}" target="_blank" rel="noopener noreferrer">Open website ↗</a></div>` : ""}</div>`
      : '<div class="empty">No matching Finnhub profile was available.</div>',
    earningsHtml = data.earnings?.length
      ? `<h4 class="finnhub-subhead">Provider-reported earnings surprises</h4>${data.earnings.map((item) => `<div class="finnhub-earnings-row"><span><span class="muted">Period</span><strong>${esc(item.period)}</strong></span><span><span class="muted">Actual</span><strong>${esc(number(item.actual))}</strong></span><span><span class="muted">Estimate</span><strong>${esc(number(item.estimate))}</strong></span><span><span class="muted">Surprise</span><strong>${item.surprisePercent === null ? "—" : esc(number(item.surprisePercent)) + "%"}</strong></span></div>`).join("")}`
      : '<div class="empty">No usable Finnhub earnings surprises were returned.</div>',
    newsHtml = data.news?.length
      ? `<h4 class="finnhub-subhead">Finnhub company news</h4><div class="news-list">${data.news.map((article) => `<article class="news-item"><div><a href="${esc(safeUrl(article.url))}" target="_blank" rel="noopener noreferrer">${esc(article.headline)}</a><div class="muted">${esc(article.summary || "No summary available.")}<br>${esc(article.category)} · media signal, not verified fact</div></div><div class="news-source"><strong>${esc(article.source)}</strong><div class="muted">${esc(new Date(article.publishedAt).toLocaleString())}</div></div></article>`).join("")}</div>`
      : '<div class="empty">No usable Finnhub company-news items were returned. This does not imply that no material event exists.</div>';
  return `${notices}${profileHtml}${earningsHtml}${newsHtml}<div class="eval-note">Finnhub profile and earnings values are licensed-provider records. Official SEC filing evidence takes precedence for reported fundamentals.</div>`;
}
async function loadFinnhubEnrichment(
  symbol = $("#research-symbol").value.trim().toUpperCase(),
) {
  if (!symbol || symbol === finnhubEnrichmentSymbol) return;
  const root = $("#finnhub-enrichment");
  root.innerHTML =
    '<div class="empty spin">Loading optional Finnhub enrichment…</div>';
  try {
    const data = await api(
      `/api/research/finnhub?symbol=${encodeURIComponent(symbol)}`,
    );
    root.innerHTML = renderFinnhubEnrichment(data);
    finnhubEnrichmentSymbol = symbol;
  } catch (error) {
    $("#finnhub-asof").textContent =
      "Finnhub enrichment unavailable · SEC remains authoritative";
    root.innerHTML = `<div class="warnings"><div>${esc(error.message)}</div></div>`;
    throw error;
  }
}
new MutationObserver(() => {
  const logo = $("#company-logo"),
    symbol = $("#research-symbol").value.trim().toUpperCase();
  if (symbol) {
    logo.src = `/api/assets/${encodeURIComponent(symbol)}/logo`;
    logo.alt = `${$("#company-title").textContent} logo`;
  }
}).observe($("#company-title"), { childList: true });
$("#company-button").onclick = () =>
  Promise.allSettled([
    loadCompanyMarket(),
    loadOpenFigiIdentity(),
    loadSecEvidence(),
    loadGdeltSignals(),
    loadFinnhubEnrichment(),
    loadMacroContext(),
  ]);
$("#company-periods").onclick = (event) => {
  const button = event.target.closest("button[data-period]");
  if (button) loadCompanyMarket(undefined, button.dataset.period);
};
$("#company-benchmark").onchange = (event) =>
  loadCompanyMarket(undefined, undefined, event.target.value);
let optionData = null,
  optionsLoaded = false,
  optionsLoading = null;
function optionPayoffChart(contract) {
  if (!contract?.midpoint)
    return '<div class="empty">A valid two-sided quote is required for a payoff.</div>';
  const points = Array.from({ length: 41 }, (_, index) => {
      const price = contract.strike * (0.6 + index * 0.02),
        profit =
          ((contract.type === "call"
            ? Math.max(price - contract.strike, 0)
            : Math.max(contract.strike - price, 0)) -
            contract.midpoint) *
          contract.multiplier;
      return { price, profit };
    }),
    width = 620,
    height = 220,
    pad = 18,
    min = Math.min(...points.map((point) => point.profit), 0),
    max = Math.max(...points.map((point) => point.profit), 0),
    range = max - min || 1,
    x = (index) => pad + (index / (points.length - 1)) * (width - pad * 2),
    y = (value) => pad + ((max - value) / range) * (height - pad * 2),
    zero = y(0);
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Long ${esc(contract.type)} expiry payoff"><line x1="${pad}" y1="${zero}" x2="${width - pad}" y2="${zero}" stroke="currentColor" opacity=".3"/><polyline class="benchmark-line" points="${points.map((point, index) => `${x(index).toFixed(1)},${y(point.profit).toFixed(1)}`).join(" ")}"/></svg>`;
}
equityChart = function (points) {
  if (points.length < 2)
    return '<div class="muted">More history is needed to draw an equity curve.</div>';
  const width = 700,
    height = 230,
    pad = 24,
    values = points.map((point) => point.equity),
    min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1,
    coords = points.map((point, index) => [
      pad + (index / (points.length - 1)) * (width - pad * 2),
      pad + ((max - point.equity) / range) * (height - pad * 2 - 18),
    ]),
    line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
    area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`,
    last = coords.at(-1);
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Portfolio equity from ${esc(money.format(values[0]))} to ${esc(money.format(values.at(-1)))}, range ${esc(money.format(min))} to ${esc(money.format(max))}"><line class="chart-base" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"/><text class="chart-axis" x="${pad}" y="14">${esc(money.format(max))}</text><text class="chart-axis" x="${pad}" y="${height - 6}">${esc(money.format(min))}</text><polygon class="chart-fill" points="${area}"/><polyline class="chart-line" points="${line}"/><circle class="chart-marker" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4"/><text class="chart-axis" x="${Math.max(pad, last[0] - 112).toFixed(1)}" y="${Math.max(18, last[1] - 10).toFixed(1)}">Latest ${esc(money.format(values.at(-1)))}</text></svg><div class="chart-note">Cashflow-adjusted view: start ${esc(money.format(values[0]))}, latest ${esc(money.format(values.at(-1)))}, observed range ${esc(money.format(min))}–${esc(money.format(max))}.</div>`;
};
const rawCandlestickChart = candlestickChart;
candlestickChart = function (bars, benchmark) {
  const values = bars.slice(-110);
  if (values.length < 2) return rawCandlestickChart(bars, benchmark);
  const closes = values.map((bar) => bar.close),
    last = values.at(-1),
    min = Math.min(...values.map((bar) => bar.low)),
    max = Math.max(...values.map((bar) => bar.high)),
    returnPct = (last.close / values[0].close - 1) * 100;
  return `${rawCandlestickChart(bars, benchmark)}<div class="chart-note">Price range ${esc(money.format(min))}–${esc(money.format(max))}; latest close ${esc(money.format(last.close))}; period move ${esc(pct(returnPct))}. Volume bars are scaled within this visible window.</div>`;
};
optionPayoffChart = function (contract) {
  if (!contract?.midpoint)
    return '<div class="empty">A valid two-sided quote is required for a payoff.</div>';
  const points = Array.from({ length: 41 }, (_, index) => {
      const price = contract.strike * (0.6 + index * 0.02),
        profit =
          ((contract.type === "call"
            ? Math.max(price - contract.strike, 0)
            : Math.max(contract.strike - price, 0)) -
            contract.midpoint) *
          contract.multiplier;
      return { price, profit };
    }),
    width = 620,
    height = 240,
    pad = 28,
    min = Math.min(...points.map((point) => point.profit), 0),
    max = Math.max(...points.map((point) => point.profit), 0),
    range = max - min || 1,
    x = (index) => pad + (index / (points.length - 1)) * (width - pad * 2),
    y = (value) => pad + ((max - value) / range) * (height - pad * 2 - 16),
    zero = y(0),
    breakEven =
      contract.type === "call"
        ? contract.strike + contract.midpoint
        : contract.strike - contract.midpoint,
    breakEvenIndex = Math.max(
      0,
      Math.min(
        points.length - 1,
        (breakEven / (contract.strike * 0.6) - 1) / 0.02,
      ),
    );
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Long ${esc(contract.type)} expiry payoff; max loss premium ${esc(money.format(contract.midpoint * contract.multiplier))}, break-even ${esc(money.format(breakEven))}"><line x1="${pad}" y1="${zero}" x2="${width - pad}" y2="${zero}" stroke="currentColor" opacity=".3"/><text class="chart-axis" x="${pad}" y="${Math.max(14, zero - 6)}">$0 P/L</text><text class="chart-axis" x="${pad}" y="${height - 8}">${esc(money.format(points[0].price))}</text><text class="chart-axis" x="${width - 82}" y="${height - 8}">${esc(money.format(points.at(-1).price))}</text><line class="chart-base" x1="${x(breakEvenIndex).toFixed(1)}" y1="${pad}" x2="${x(breakEvenIndex).toFixed(1)}" y2="${height - pad}" stroke-dasharray="4 4"/><polyline class="benchmark-line" points="${points.map((point, index) => `${x(index).toFixed(1)},${y(point.profit).toFixed(1)}`).join(" ")}"/></svg><div class="chart-note">Expiry payoff estimate for a long ${esc(contract.type)}: premium/max loss ${esc(money.format(contract.midpoint * contract.multiplier))}; break-even ${esc(money.format(breakEven))}; horizontal axis is underlying price at expiry.</div>`;
};
function selectOptionContract(symbol) {
  const contract = optionData?.contracts.find((item) => item.symbol === symbol);
  if (!contract) return;
  $("#options-payoff").innerHTML = optionPayoffChart(contract);
  const breakEven =
    contract.type === "call"
      ? contract.strike + contract.midpoint
      : contract.strike - contract.midpoint;
  $("#options-selected").innerHTML =
    `<div class="market-stat"><span class="muted">Selected contract</span><strong>${esc(contract.symbol)}</strong></div><div class="market-stat"><span class="muted">Long premium / max loss</span><strong>${esc(money.format(contract.midpoint * contract.multiplier))}</strong></div><div class="market-stat"><span class="muted">Expiry break-even</span><strong>${esc(money.format(breakEven))}</strong></div><div class="market-stat"><span class="muted">Alpaca / model delta</span><strong>${contract.greeks ? esc(contract.greeks.delta.toFixed(3)) : "—"} / ${contract.modelGreeks ? esc(contract.modelGreeks.delta.toFixed(3)) : "—"}</strong><span class="muted">${esc(optionData.modelAssumptions)}</span></div><div class="watchlist-actions"><button class="ghost draft-long-option" type="button" data-symbol="${esc(contract.symbol)}">Draft long</button><button class="ghost add-vertical-option" type="button" data-symbol="${esc(contract.symbol)}">Add to vertical</button></div>`;
}
function renderOptionChain() {
  if (!optionData) return;
  const type = $("#options-type").value,
    minOi = Number($("#options-open-interest").value || 0),
    maxSpread = Number($("#options-spread").value || Infinity),
    rows = optionData.contracts
      .filter(
        (contract) =>
          (type === "all" || contract.type === type) &&
          (contract.openInterest ?? 0) >= minOi &&
          (contract.spreadBps ?? Infinity) <= maxSpread,
      )
      .slice(0, 120);
  $("#options-chain").innerHTML = rows.length
    ? rows
        .map(
          (contract) =>
            `<button class="option-row option-contract" data-symbol="${esc(contract.symbol)}"><span><strong>${esc(contract.type.toUpperCase())} ${esc(money.format(contract.strike))}</strong><span class="muted"> · ${esc(contract.expiration)}</span></span><span>${contract.bid === null || contract.ask === null ? "—" : `${esc(money.format(contract.bid))} / ${esc(money.format(contract.ask))}`}</span><span>${esc(contract.openInterest ?? "—")} / ${esc(contract.volume ?? "—")}</span><span>${contract.impliedVolatility === null ? "—" : esc(pct(contract.impliedVolatility * 100))}</span><span>${contract.greeks?.delta === null || !contract.greeks ? "—" : esc(contract.greeks.delta.toFixed(3))}</span><span>${contract.spreadBps === null ? "—" : esc(contract.spreadBps.toFixed(0)) + " bps"}</span></button>`,
        )
        .join("")
    : '<div class="empty">No contracts pass these liquidity filters.</div>';
  if (rows.length && optionData.contracts.length > rows.length)
    $("#options-chain").insertAdjacentHTML(
      "beforeend",
      `<div class="option-chain-limit muted">Showing ${esc(rows.length)} of ${esc(optionData.contracts.length)} available contracts. Tighten liquidity or type filters to narrow the chain.</div>`,
    );
  const nearest = rows.toSorted(
    (a, b) =>
      Math.abs(a.strike - optionData.underlyingPrice) -
      Math.abs(b.strike - optionData.underlyingPrice),
  )[0];
  if (nearest) selectOptionContract(nearest.symbol);
}
async function loadOptions() {
  const button = $("#options-button"),
    symbol = $("#options-symbol").value.trim().toUpperCase(),
    expiration = $("#options-expiration").value;
  try {
    button.disabled = true;
    button.textContent = "Loading…";
    optionData = await api(
      `/api/options/chain?symbol=${encodeURIComponent(symbol)}${expiration ? `&expiration=${encodeURIComponent(expiration)}` : ""}`,
    );
    optionsLoaded = true;
    const selectedExpiration = optionData.contracts[0]?.expiration || "";
    $("#options-expiration").innerHTML = optionData.expirations
      .map(
        (value) =>
          `<option value="${esc(value)}"${value === selectedExpiration ? " selected" : ""}>${esc(new Date(value + "T12:00:00Z").toLocaleDateString())}</option>`,
      )
      .join("");
    $("#options-metrics").innerHTML =
      `<div class="metric"><strong>${esc(money.format(optionData.underlyingPrice))}</strong><span class="muted">${esc(symbol)} underlying</span></div><div class="metric"><strong>${esc(optionData.contracts.length)}</strong><span class="muted">Available contracts · 120 display cap</span></div><div class="metric"><strong>Level ${esc(optionData.account.tradingLevel)}</strong><span class="muted">Paper options permission</span></div><div class="metric"><strong>${optionData.account.buyingPower === null ? "—" : esc(money.format(optionData.account.buyingPower))}</strong><span class="muted">Options buying power</span></div>`;
    const quoteCount = optionData.contracts.filter((contract) => {
        const bid = Number(contract.bid),
          ask = Number(contract.ask);
        return (
          Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid
        );
      }).length,
      ivCount = optionData.contracts.filter(
        (contract) =>
          Number.isFinite(Number(contract.impliedVolatility)) &&
          Number(contract.impliedVolatility) > 0,
      ).length,
      greekCount = optionData.contracts.filter((contract) =>
        ["delta", "gamma", "theta", "vega", "rho"].every((key) => {
          const value = contract.greeks?.[key];
          return (
            value !== null &&
            value !== undefined &&
            Number.isFinite(Number(value))
          );
        }),
      ).length,
      responseTime =
        optionData.time?.serverResponseTime || optionData.serverRespondedAt;
    $("#options-coverage").innerHTML =
      `<div class="coverage-strip"><div><strong>Snapshot coverage</strong><span class="muted">${esc(quoteCount)}/${esc(optionData.contracts.length)} two-sided quotes · ${esc(ivCount)}/${esc(optionData.contracts.length)} IV · ${esc(greekCount)}/${esc(optionData.contracts.length)} Greeks</span></div><span class="pill ${greekCount === optionData.contracts.length ? "gain" : "loss"}">${greekCount === optionData.contracts.length ? "Complete" : "Partial data"}</span></div>${greekCount < optionData.contracts.length ? `<div class="warnings"><div>Greeks are unavailable for ${esc(optionData.contracts.length - greekCount)} contracts. Delta filters and model comparisons cannot be relied on for those rows.</div></div>` : ""}${responseTime ? `<div class="muted coverage-time">Server response ${esc(new Date(responseTime).toLocaleString())}</div>` : ""}`;
    renderOptionChain();
  } catch (error) {
    notify(error.message);
    $("#options-chain").innerHTML =
      `<div class="empty">${esc(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = "Load chain";
  }
}
$("#option-portfolio-greeks").insertAdjacentHTML(
  "afterend",
  '<div id="option-positions"></div>',
);
async function loadOptionPortfolio() {
  const data = await api("/api/options/portfolio"),
    t = data.totals;
  $("#option-portfolio-greeks").innerHTML =
    `<div class="metric"><strong>${esc(t.delta.toFixed(2))}</strong><span class="muted">Portfolio delta shares</span></div><div class="metric"><strong>${esc(t.gamma.toFixed(2))}</strong><span class="muted">Portfolio gamma</span></div><div class="metric"><strong>${esc(t.theta.toFixed(2))}</strong><span class="muted">Daily theta</span></div><div class="metric"><strong>${esc(t.vega.toFixed(2))}</strong><span class="muted">Vega per vol point</span></div>${data.scenarios.map((item) => `<div class="metric"><strong class="${item.estimatedPnl >= 0 ? "gain" : "loss"}">${esc(signedMoney(item.estimatedPnl))}</strong><span class="muted">${esc(item.name)} · delta-gamma estimate</span></div>`).join("")}`;
  $("#option-positions").innerHTML = data.legs.length
    ? data.legs
        .map(
          (leg) =>
            `<div class="source"><div><strong>${esc(leg.symbol)}</strong><div class="muted">${esc(leg.qty)} contracts · ${esc(money.format(leg.marketValue))}</div></div>${leg.qty > 0 ? `<div class="watchlist-actions"><button class="ghost option-position-action" data-symbol="${esc(leg.symbol)}" data-action="exercise">Exercise</button><button class="danger option-position-action" data-symbol="${esc(leg.symbol)}" data-action="do_not_exercise">Do not exercise</button></div>` : ""}</div>`,
        )
        .join("")
    : '<div class="muted" style="margin-top:14px">No open option positions. Expiry actions will appear here for exact long positions.</div>';
}
function syncOptionOrder() {
  const vertical = $("#option-order-kind").value === "vertical";
  if (vertical) $("#option-order-type").value = "limit";
  $("#option-order-type").disabled = vertical;
  $("#option-order-limit").hidden = $("#option-order-type").value !== "limit";
}
function ensureOptionsLoaded() {
  if (optionsLoaded) return Promise.resolve(optionData);
  optionsLoading ??= Promise.all([
    loadOptions(),
    loadOptionPortfolio(),
  ]).finally(() => {
    optionsLoading = null;
  });
  return optionsLoading;
}
$("#options-form").onsubmit = (event) => {
  event.preventDefault();
  loadOptions();
};
$("#options-expiration").onchange = () => loadOptions();
["#options-type", "#options-open-interest", "#options-spread"].forEach(
  (selector) => ($(selector).onchange = renderOptionChain),
);
$("#options-chain").onclick = (event) => {
  const button = event.target.closest(".option-contract");
  if (button) selectOptionContract(button.dataset.symbol);
};
$("#options-selected").onclick = (event) => {
  const long = event.target.closest(".draft-long-option"),
    vertical = event.target.closest(".add-vertical-option");
  if (long) {
    $("#option-order-kind").value = "single";
    $("#option-order-legs").value = long.dataset.symbol;
    $("#option-order-type").value = "market";
    syncOptionOrder();
    $("#option-order-form").scrollIntoView({ behavior: "smooth" });
  }
  if (vertical) {
    const existing = $("#option-order-legs")
      .value.trim()
      .split(/\s+/)
      .filter(Boolean);
    $("#option-order-kind").value = "vertical";
    $("#option-order-legs").value = [
      ...existing
        .filter((symbol) => symbol !== vertical.dataset.symbol)
        .slice(0, 1),
      vertical.dataset.symbol,
    ].join("\n");
    syncOptionOrder();
    $("#option-order-form").scrollIntoView({ behavior: "smooth" });
  }
};
$("#option-order-kind").onchange = syncOptionOrder;
$("#option-order-type").onchange = syncOptionOrder;
syncOptionOrder();
$("#option-order-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#option-order-button");
  try {
    button.disabled = true;
    const kind = $("#option-order-kind").value,
      symbols = $("#option-order-legs")
        .value.trim()
        .split(/\s+/)
        .filter(Boolean),
      legs =
        kind === "single"
          ? [{ symbol: symbols[0], side: "buy", positionIntent: "buy_to_open" }]
          : [
              {
                symbol: symbols[0],
                side: "buy",
                positionIntent: "buy_to_open",
              },
              {
                symbol: symbols[1],
                side: "sell",
                positionIntent: "sell_to_open",
              },
            ],
      ticket = {
        kind,
        legs,
        qty: $("#option-order-qty").value,
        type: $("#option-order-type").value,
        limitPrice: $("#option-order-limit").hidden
          ? null
          : $("#option-order-limit").value || null,
      },
      result = await api("/api/options/orders/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ticket),
      }),
      preview = result.preview,
      details = preview.legs
        .map(
          (leg) =>
            `${leg.side.toUpperCase()} ${leg.symbol} · ${leg.optionType} ${money.format(leg.strike)} · ${money.format(leg.bid)} / ${money.format(leg.ask)}`,
        )
        .join("\n");
    if (
      !(await reviewDialog(
        `Review this defined-risk paper option order?\n\n${details}\n\nQuantity: ${preview.qty}\nMaximum loss: ${money.format(preview.maxLoss)}\nMaximum profit: ${preview.maxProfit === null ? "unbounded" : money.format(preview.maxProfit)}\nReference net debit: ${money.format(result.referenceDebit)}\nExercise cash requirement: ${money.format(preview.exerciseCost)}\nShort-leg assignment notional: ${money.format(preview.assignmentNotional)}\n\nQuotes and permissions will be revalidated. Options can expire worthless; short legs may be assigned before expiry, and Alpaca controls complex-order handling.`,
      ))
    )
      return;
    const submitted = await api("/api/options/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        previewToken: result.previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    notify(
      `Option order ${submitted.status.replaceAll("_", " ")}. Receipt ${submitted.receiptId.slice(0, 8)} created.`,
    );
    await Promise.all([loadOrders(), loadReceipts(), loadOptionPortfolio()]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
};
document
  .querySelector('[data-view="options"]')
  .addEventListener("click", () =>
    ensureOptionsLoaded().catch((error) => notify(error.message)),
  );
addEventListener("hashchange", () => {
  if (location.hash === "#options")
    ensureOptionsLoaded().catch((error) => notify(error.message));
});
if (location.hash === "#options")
  queueMicrotask(() =>
    ensureOptionsLoaded().catch((error) => notify(error.message)),
  );
$("#option-positions").onclick = async (event) => {
  const button = event.target.closest(".option-position-action");
  if (!button) return;
  try {
    button.disabled = true;
    const result = await api(
        `/api/options/positions/${encodeURIComponent(button.dataset.symbol)}/action-preview?action=${encodeURIComponent(button.dataset.action)}`,
      ),
      preview = result.preview,
      label =
        preview.action === "exercise" ? "exercise" : "mark do not exercise";
    if (
      !(await reviewDialog(
        `${label.toUpperCase()} ${preview.qty} ${preview.symbol}?\n\nExpiration: ${preview.expiration}\nStrike: ${money.format(preview.strike)}\nExercise cash requirement: ${money.format(preview.exerciseCost)}\n\nThis instruction is sent directly to Alpaca and may be subject to expiry-day cutoffs. It cannot be assumed reversible.`,
      ))
    )
      return;
    await api(
      `/api/options/positions/${encodeURIComponent(preview.symbol)}/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewToken: result.previewToken }),
      },
    );
    notify(`Alpaca accepted the ${label} instruction.`);
    await loadOptionPortfolio();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
};
