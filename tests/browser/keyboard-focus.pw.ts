import { expect, test, type Page, type Route } from "@playwright/test";

const generatedAt = "2026-07-13T08:00:00.000Z";

function policy(active = false) {
  return {
    policy: {
      maxOrderNotional: 25_000,
      maxSymbolExposureNotional: 50_000,
      maxPortfolioExposurePercent: 90,
      maxSectorExposurePercent: 40,
      maxDrawdownPercent: 20,
      maxDailyTurnoverPercent: 50,
      globalKillSwitch: {
        active,
        reason: active ? "Browser regression" : null,
        activatedBy: active ? "browser-test" : null,
      },
      updatedAt: generatedAt,
    },
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installApiFixtures(page: Page) {
  const mutations: { method: string; path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET")
      mutations.push({
        method: request.method(),
        path: url.pathname,
        body: request.postData() ? request.postDataJSON() : null,
      });
    if (
      url.pathname === "/api/operations/policy" &&
      request.method() === "GET"
    )
      return fulfillJson(route, policy(false));
    if (
      url.pathname === "/api/operations/kill-switch" &&
      request.method() === "POST"
    )
      return fulfillJson(route, policy(true));
    if (
      url.pathname === "/api/operations/closed-beta-evidence" &&
      request.method() === "GET"
    )
      return fulfillJson(route, {
        generatedAt,
        targetWindowDays: 30,
        summary: {
          readyForExitReview: false,
          pass: 0,
          fail: 0,
          needsEvidence: 8,
          totalTargets: 8,
        },
        targets: [],
      });
    if (url.pathname === "/api/orders" && request.method() === "GET")
      return fulfillJson(route, {
        orders: [],
        sync: {
          streamState: "disconnected",
          stale: false,
          lastRecoveryAt: null,
        },
      });
    return fulfillJson(
      route,
      { error: `Fixture unavailable for ${url.pathname}` },
      503,
    );
  });
  return mutations;
}

test("keyboard navigation, table filtering, and error announcements remain operable", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await installApiFixtures(page);
  await page.goto("/");

  const portfolio = page.getByRole("button", { name: "Portfolio" });
  await portfolio.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#portfolio$/);
  await expect(portfolio).toHaveAttribute("aria-current", "page");
  await expect(portfolio).not.toHaveAttribute("aria-selected");
  await expect(page.locator('.nav [aria-current="page"]')).toHaveCount(1);
  await expect(page.locator("#portfolio-view")).toBeVisible();

  const orderFilter = page.getByLabel("Filter orders");
  await orderFilter.focus();
  await expect(orderFilter).toBeFocused();
  await orderFilter.press("c");
  await expect(orderFilter).toHaveValue("closed");
  await expect(page.locator("#orders-asof")).toContainText("closed orders");

  const strategies = page.getByRole("button", { name: "Strategy Lab" });
  await strategies.focus();
  await page.keyboard.press("Enter");
  await page.locator("#strategy-compare-ids").fill("one-backtest-id");
  const compare = page.getByRole("button", { name: "Compare backtests" });
  await compare.focus();
  await page.keyboard.press("Enter");
  const status = page.getByRole("status");
  await expect(status).toContainText("Add at least two backtest IDs");
  await expect(status).toBeVisible();
  await expect(compare).toBeFocused();
  expect(pageErrors).toEqual([]);
});

test("destructive confirmation traps focus, cancels safely, and restores focus", async ({
  page,
}) => {
  const mutations = await installApiFixtures(page);
  await page.goto("/");

  await page.getByLabel("Kill-switch reason").fill("Browser regression");
  const trigger = page.locator("#operations-kill-toggle");
  await expect(trigger).toHaveAccessibleName("Activate kill switch");
  await trigger.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", {
    name: "Activate the global kill switch?",
  });
  const confirm = dialog.getByRole("button", { name: "Confirm" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(dialog).toBeVisible();
  await expect(confirm).toHaveClass("danger");
  await expect(confirm).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(mutations).toEqual([]);

  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(trigger).toHaveAccessibleName("Clear kill switch");
  await expect(page.getByRole("status")).toContainText(
    "Global kill switch activated",
  );
  expect(mutations).toEqual([
    {
      method: "POST",
      path: "/api/operations/kill-switch",
      body: { active: true, reason: "Browser regression" },
    },
  ]);
});
