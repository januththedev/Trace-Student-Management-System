import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, test } from "@playwright/test";
import { e2eUrl } from "./environment";
import { chooseIntake, seedStudent, signInStaff } from "./support";

test("admission creation survives a lost success response without duplicating the application", async ({ page }) => {
  const fixture = await seedStudent();
  const name = `Retry Applicant ${randomUUID()}`;
  await signInStaff(page);
  await page.goto("/staff/admissions");
  await page.getByText("New application", { exact: true }).click();
  await chooseIntake(page, "Programme / intake", fixture);
  await page.getByLabel("Applicant name", { exact: true }).fill(name);
  await page.getByLabel("NIC", { exact: true }).fill(fixture.nic);

  const keys: string[] = [];
  let committedId: string | null = null;
  await page.route("**/api/staff/admissions", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) {
      // Commit through the real server/database, then lose only the browser's response.
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committedId = (await response.json()).id;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByRole("button", { name: "Create application", exact: true }).click();
  const form = page.getByLabel("Applicant name", { exact: true }).locator("xpath=ancestor::form");
  await expect(form.getByRole("alert")).toContainText("Network problem");
  const response = page.waitForResponse(r => r.url().endsWith("/api/staff/admissions") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Create application", exact: true }).click();
  const replay = await response;
  expect(replay.status()).toBe(200);
  expect((await replay.json()).id).toBe(committedId);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  await expect(form.getByRole("status")).toHaveText("Saved successfully.");

  const client = postgres(e2eUrl, { max: 1, onnotice: () => {} });
  try {
    const [result] = await client`
      select count(*)::int as applications,
        (select count(*)::int from admission_events where admission_id = ${committedId}::uuid) as events,
        (select count(*)::int from audit_events where entity_id = ${committedId}::text and action = 'admission.create') as audits
      from admissions where applicant_name = ${name}`;
    expect(result).toEqual({ applications: 1, events: 1, audits: 1 });
  } finally { await client.end(); }
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(1);
});
