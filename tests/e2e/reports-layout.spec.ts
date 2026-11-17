import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { STAFF_EMAIL, STAFF_PASSWORD } from "./environment";

// These extra scenarios represent separate clients; sharing the runner's single
// loopback address would exhaust the real 20-login IP bucket for unrelated tests.
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": testInfo.project.name.startsWith("mobile") ? "192.0.2.202" : "192.0.2.201" });
});

test("simple entry and login pages fit common laptop and phone viewports", async ({ page }) => {
  const overflowMeasurements = [];
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 600 }, { width: 390, height: 844 }, { width: 390, height: 667 }]) {
    await page.setViewportSize(viewport);
    for (const route of ["/", "/staff/login"]) {
      await page.goto(route);
      await expect(page.getByRole("button", { name: route === "/" ? "Continue" : "Sign in to your workspace", exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
      overflowMeasurements.push({ route, ...viewport, ...overflow });
    }
  }
  expect(overflowMeasurements.filter(size => size.x > 0 || size.y > 0)).toEqual([]);
});

test("staff sidebar fits the viewport, keeps readable navigation and supports keyboard dismissal", async ({ page }) => {
  await page.goto("/staff/login");
  await page.getByLabel("Work email", { exact: true }).fill(STAFF_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
  await page.getByRole("button", { name: "Sign in to your workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/staff$/);
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 600 }, { width: 390, height: 844 }, { width: 390, height: 600 }]) {
    await page.setViewportSize(viewport);
    const mobile = viewport.width < 1024;
    if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const navigation = mobile ? page.getByRole("dialog").getByRole("navigation") : page.locator("aside").getByRole("navigation");
    await expect(navigation.getByRole("link")).toHaveCount(10);
    await expect(navigation.getByRole("link", { name: "Trash", exact: true })).toBeVisible();
    const fits = await navigation.evaluate(nav => {
      const group = nav.querySelector(".staff-nav-groups")!;
      const bounds = nav.getBoundingClientRect();
      const links = [...nav.querySelectorAll("a")].map(link => link.getBoundingClientRect());
      const account = nav.querySelector(".staff-account")!.getBoundingClientRect();
      return { scroll: group.scrollHeight - group.clientHeight, controlsFit: links.every(rect => rect.height >= 44),
        fontSize: Number.parseFloat(getComputedStyle(nav.querySelector("a")!).fontSize),
        labelsVisible: [...nav.querySelectorAll(".staff-group-label")].every(label => label.getBoundingClientRect().height > 0),
        accountFit: account.bottom <= innerHeight, height: bounds.height };
    });
    expect(fits.scroll, JSON.stringify(viewport)).toBeLessThanOrEqual(1);
    expect(fits.height).toBe(viewport.height);
    expect(fits.fontSize).toBeGreaterThanOrEqual(14);
    expect(fits.labelsVisible).toBe(true);
    expect(fits.controlsFit).toBe(true);
    expect(fits.accountFit).toBe(true);
    await navigation.getByRole("link", { name: "Trash", exact: true }).scrollIntoViewIfNeeded();
    await expect(navigation.getByRole("link", { name: "Trash", exact: true })).toBeInViewport();
    if (mobile) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeFocused();
    }
  }
});

test("PDF report downloads with real session and CSRF while CSV stays available", async ({ page }) => {
  await page.goto("/staff/login");
  await page.getByLabel("Work email", { exact: true }).fill(STAFF_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
  await page.getByRole("button", { name: "Sign in to your workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await page.goto("/staff/reports?from=2020-01-01&to=2026-12-31");
  await expect(page.getByRole("combobox", { name: "Export report", exact: true })).toBeVisible();
  const denied = await page.request.post("/api/staff/reports/export", { data: { report: "receipts", format: "pdf" } });
  expect(denied.status()).toBe(403);
  const downloadEvent = page.waitForEvent("download");
  const responseEvent = page.waitForResponse(response => response.url().endsWith("/api/staff/reports/export") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadEvent, responseEvent]);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.request().headers()["x-csrf-token"]).toBeTruthy();
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const pdf = await PDFDocument.load(await readFile((await download.path())!));
  expect(pdf.getPageCount()).toBeGreaterThan(0);
  expect(pdf.getTitle()).toBe("T2T - Receipts by approval date");
  await expect(page.getByRole("button", { name: "Download CSV", exact: true })).toBeEnabled();
  const csvEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  expect((await csvEvent).suggestedFilename()).toMatch(/\.csv$/);
});
