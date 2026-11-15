const disclosuresPath = "/api/research/disclosures";
let disclosureBusy = false;
let disclosureData = null;

function renderDisclosures() {
  const feed = $("#disclosures-feed"), trials = $("#disclosures-trials");
  const recorded = new Set(disclosureData.trials.map(trial => trial.accession));
  feed.innerHTML = disclosureData.sources.map(source => `
    <h3>${esc(source.name)}</h3>
    ${source.status === "unavailable"
      ? '<p class="muted">SEC data unavailable for this filer. Refresh to retry.</p>'
      : source.records.length ? source.records.map(record => `
        <div class="disclosure-row">
          <div>
            <a href="${esc(safeUrl(record.url))}" target="_blank" rel="noopener noreferrer">${esc(record.form)} · ${esc(record.accession)}</a>
            <div class="muted">Report period ${esc(record.reportDate ?? "unknown")} · Filed ${esc(record.filingDate)}${record.form.endsWith("/A") ? " · Amendment" : ""}</div>
          </div>
          ${record.canStartPaper && !recorded.has(record.accession)
            ? `<button class="ghost" type="button" data-start-paper="${esc(record.accession)}" aria-label="Start paper test for ${esc(source.name)}">Start paper test</button>`
            : ""}
        </div>`).join("")
        : '<p class="muted">No recent Form 13F filings found.</p>'}
  `).join("");
  trials.innerHTML = disclosureData.trials.length ? disclosureData.trials.map(trial => `
    <div class="disclosure-row">
      <div><strong>${esc(trial.symbol)} vs ${esc(trial.rule.benchmark)}</strong>
        <div class="muted">${esc(trial.filer)} · Recorded ${esc(new Date(trial.recordedAt).toLocaleString())}</div>
        <a href="${esc(safeUrl(trial.tableUrl))}" target="_blank" rel="noopener noreferrer">SEC information table</a>
      </div>
      <button class="ghost" type="button" data-check-paper="${esc(trial.accession)}" aria-label="Check ${esc(trial.symbol)} paper test for ${esc(trial.filer)}">Check result</button>
    </div>`).join("") : '<p class="muted">Start a test from a recent eligible holdings report.</p>';
}

async function loadDisclosures() {
  if (disclosureBusy) return;
  disclosureBusy = true;
  const refresh = $("#disclosures-refresh"), status = $("#disclosures-status");
  refresh.disabled = true;
  $("#disclosures-feed").setAttribute("aria-busy", "true");
  status.textContent = "Checking SEC EDGAR…";
  try {
    disclosureData = await api(disclosuresPath);
    renderDisclosures();
    const checked = disclosureData.sources.map(source => source.checkedAt).filter(Boolean).sort();
    status.textContent = checked.length
      ? `SEC EDGAR last checked ${new Date(checked.at(-1)).toLocaleString()}`
      : "SEC filings unavailable";
  } catch (error) {
    status.textContent = error.message || "Disclosures unavailable. Refresh to retry.";
  } finally {
    $("#disclosures-feed").setAttribute("aria-busy", "false");
    refresh.disabled = false;
    disclosureBusy = false;
  }
}

async function reviewDisclosurePaper(button, accession, start) {
  if (disclosureBusy) return;
  disclosureBusy = true;
  const result = $("#disclosures-result");
  button.disabled = true;
  result.textContent = start ? "Recording a forward paper test…" : "Checking scheduled session and IEX prices…";
  try {
    if (start) {
      const { trial } = await api(`${disclosuresPath}/paper`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accession }),
      });
      disclosureData.trials = [trial, ...disclosureData.trials.filter(item => item.accession !== accession)].slice(0, 20);
      renderDisclosures();
      $("#disclosures-trials").querySelector("[data-check-paper]")?.focus();
      result.textContent = `Recorded ${trial.symbol} vs ${trial.rule.benchmark}. Check the result after the first eligible session closes.`;
    } else {
      const data = await api(`${disclosuresPath}/paper?accession=${encodeURIComponent(accession)}`);
      const name = `${data.trial.symbol} vs ${data.trial.rule.benchmark}`;
      const session = data.session ? ` · Session closes ${new Date(data.session.close).toLocaleString()}` : "";
      result.textContent = data.status === "complete"
        ? `${name} · ${pct(data.candidate.returnPercent)} vs ${pct(data.benchmark.returnPercent)} after modeled costs · ${data.excessPercentagePoints.toFixed(2)} percentage points excess${session}`
        : `${name}${session} · ${data.reason}`;
    }
  } catch (error) {
    result.textContent = error.message || "Paper test unavailable. Try again.";
  } finally {
    button.disabled = false;
    disclosureBusy = false;
  }
}
$("#disclosures-refresh").addEventListener("click", loadDisclosures);
$("#disclosures-feed").addEventListener("click", event => {
  const button = event.target.closest("[data-start-paper]");
  if (button) void reviewDisclosurePaper(button, button.dataset.startPaper, true);
});
$("#disclosures-trials").addEventListener("click", event => {
  const button = event.target.closest("[data-check-paper]");
  if (button) void reviewDisclosurePaper(button, button.dataset.checkPaper, false);
});
