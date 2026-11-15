import { expect, test } from "@playwright/test";

test("briefing and disclosure paper workflow work with keyboard and on a narrow viewport", async ({ page }) => {
  const accession = "0001104659-26-126785";
  const recordedAt = "2026-11-16T14:22:00.000Z";
  const trial = {
    accession, filer: "ARK Investment Management", symbol: "TSLA", recordedAt,
    tableUrl: "https://www.sec.gov/table.xml", rule: { benchmark: "SPY" },
  };
  let started = false;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/portfolio/briefing") return route.fulfill({ json: {
      equityChange: 32, equityChangePercent: 1.4, currency: "USD",
      accountSource: "Alpaca Paper Trading API", retrievedAt: recordedAt,
      contributors: [{ symbol: "AAPL", pnl: 40 }, { symbol: "TSLA", pnl: -8 }],
      coverage: { positions: 2, withIntradayPnl: 2, checkedForNews: 2, news: "available" },
      developments: [{
        headline: "Apple publishes an investor update", symbols: ["AAPL"],
        source: "Issuer", url: "https://www.apple.com/newsroom/", publishedAt: recordedAt,
      }],
    } });
    if (pathname === "/api/research/disclosures") return route.fulfill({ json: {
      sources: [
        { name: "Berkshire Hathaway", status: "unavailable", records: [] },
        { name: trial.filer, status: "available", checkedAt: recordedAt, records: [{
          accession, form: "13F-HR", reportDate: "2026-09-30", filingDate: "2026-11-13",
          url: "https://www.sec.gov/filing", canStartPaper: true,
        }] },
      ], trials: started ? [trial] : [],
    } });
    if (pathname === "/api/research/disclosures/paper" && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({ accession });
      started = true;
      return route.fulfill({ status: 201, json: { trial, created: true } });
    }
    if (pathname === "/api/research/disclosures/paper") return route.fulfill({ json: {
      trial, status: "pending", session: { close: "2026-11-17T21:00:00.000Z" },
      reason: "Waiting for the first eligible session to close.",
    } });
    return route.fulfill({ status: 503, json: { error: "Fixture unavailable" } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const briefing = page.getByRole("region", { name: "Portfolio briefing" });
  await expect(briefing.getByText("AAPL", { exact: true })).toBeVisible();
  await expect(briefing.getByRole("link", { name: "Apple publishes an investor update" })).toHaveAttribute("href", "https://www.apple.com/newsroom/");
  await expect(briefing.locator(".briefing-columns")).toHaveCSS("grid-template-columns", /^\d+(?:\.\d+)?px$/);
  await page.getByRole("button", { name: "Markets", exact: true }).click();
  const disclosures = page.getByRole("region", { name: "Public disclosures" });
  await expect(disclosures.getByText("SEC data unavailable for this filer.")).toBeVisible();
  const start = disclosures.getByRole("button", { name: "Start paper test for ARK Investment Management" });
  await start.focus();
  await start.press("Enter");
  const check = disclosures.getByRole("button", { name: "Check TSLA paper test for ARK Investment Management" });
  await expect(check).toBeFocused();
  await check.press("Enter");
  await expect(disclosures.locator("#disclosures-result")).toContainText("Waiting for the first eligible session");
  await expect(disclosures.getByRole("link", { name: "SEC information table" })).toBeVisible();
});
