import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { staffAccounts } from "../../src/db/schema";
import { hashPassword } from "../../src/lib/crypto";
import { e2eUrl } from "./environment";

test("Super Admin measures actual storage and loses global access immediately after demotion", async ({ page }, testInfo) => {
  const client = postgres(e2eUrl, { max: 1, onnotice: () => {} });
  const database = drizzle(client);
  const password = "Synthetic-storage-acceptance-762!";
  const email = `storage-${randomUUID()}@example.test`;
  const [staff] = await database.insert(staffAccounts).values({ name: "Storage Acceptance", email, role: "SUPER_ADMIN", capabilities: [], passwordHash: await hashPassword(password) }).returning();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("/staff/login");
    await page.getByLabel("Work email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in to your workspace", exact: true }).click();
    await expect(page).toHaveURL(/\/staff$/);
    const refresh = page.getByRole("button", { name: "Refresh storage usage" });
    await expect(refresh).toBeVisible();
    const result = page.waitForResponse(r => r.url().endsWith("/api/staff/storage/refresh") && r.request().method() === "POST");
    await refresh.click();
    const response = await result;
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.usage.usedBytes).toBeGreaterThanOrEqual(0);
    expect(body.usage.objectCount).toBeGreaterThanOrEqual(0);
    expect(body.usage.remainingBytes).toBe(Math.max(0, body.usage.budgetBytes - body.usage.usedBytes));
    await expect(page.getByRole("progressbar", { name: "App storage budget used" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("storage-capacity.png"), fullPage: true });
    const csrf = await page.locator('meta[name="csrf-token"]').getAttribute("content");
    await database.update(staffAccounts).set({ role: "ADMIN" }).where(eq(staffAccounts.id, staff.id));
    await page.reload();
    await expect(refresh).toHaveCount(0);
    const denied = await page.request.post("/api/staff/storage/refresh", { headers: { "x-csrf-token": csrf!, "Idempotency-Key": randomUUID() }, data: {} });
    expect(denied.status()).toBe(403);
    expect(errors).toEqual([]);
  } finally { await client.end(); }
});
