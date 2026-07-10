/** Global provider and dataset health surfaced consistently across workspaces. */
let latestDataQuality = null;

function dataQualityStatus(data) {
  if (data.summary.degradedProviders || data.summary.failedDatasets)
    return { label: "Data degraded", className: "loss" };
  if (data.summary.warningDatasets)
    return { label: "Data warnings", className: "warning" };
  if (data.summary.healthyProviders)
    return { label: "Data observed", className: "gain" };
  return { label: "Data unobserved", className: "" };
}

function renderDataQuality(data) {
  latestDataQuality = data;
  const status = dataQualityStatus(data),
    button = $("#data-quality-toggle"),
    summary = data.summary,
    providers = data.providers.toSorted((left, right) => {
      const order = {
        degraded: 0,
        throttled: 1,
        stale: 2,
        unobserved: 3,
        healthy: 4,
      };
      return (order[left.status] ?? 5) - (order[right.status] ?? 5);
    });
  $("#data-quality-label").textContent = status.label;
  button.className = `data-health-button ${status.className}`.trim();
  $("#data-quality-asof").textContent =
    `Local evidence · updated ${new Date(data.generatedAt).toLocaleString()}`;
  $("#data-quality-summary").innerHTML =
    `<div class="metric"><strong>${esc(summary.healthyProviders)}</strong><span class="muted">Healthy providers</span></div><div class="metric"><strong>${esc(summary.degradedProviders)}</strong><span class="muted">Degraded or throttled</span></div><div class="metric"><strong>${esc(summary.unobservedProviders)}</strong><span class="muted">Unobserved providers</span></div><div class="metric"><strong>${esc(summary.warningDatasets + summary.failedDatasets)}</strong><span class="muted">Dataset warnings</span></div>`;
  $("#data-quality-list").innerHTML = providers
    .map(
      (provider) =>
        `<div class="data-quality-row"><div><strong>${esc(provider.provider)}</strong><div class="muted">${esc(provider.coverage.slice(0, 3).join(" · "))}</div></div><div class="data-quality-meta"><span class="pill ${provider.status === "healthy" ? "gain" : ["degraded", "throttled"].includes(provider.status) ? "loss" : ""}">${esc(provider.status)}</span><span class="muted">${provider.lastSuccessAt ? `Last success ${esc(new Date(provider.lastSuccessAt).toLocaleString())}` : "No local success evidence"}</span></div></div>`,
    )
    .join("");
}

async function loadDataQuality() {
  renderDataQuality(await api("/api/operations/data-quality"));
}

const dataQualityPanel = $("#data-quality-panel"),
  dataQualityToggle = $("#data-quality-toggle");
dataQualityToggle.onclick = () => {
  const open = dataQualityPanel.hidden;
  dataQualityPanel.hidden = !open;
  dataQualityToggle.setAttribute("aria-expanded", String(open));
  if (open && !latestDataQuality)
    loadDataQuality().catch((error) => notify(error.message));
};
$("#data-quality-refresh").onclick = () =>
  loadDataQuality().catch((error) => notify(error.message));

loadDataQuality().catch((error) => {
  $("#data-quality-label").textContent = "Data unavailable";
  $("#data-quality-summary").innerHTML = cardError(
    "Data health unavailable",
    error,
    "Provider and dataset evidence could not be loaded.",
  );
});
