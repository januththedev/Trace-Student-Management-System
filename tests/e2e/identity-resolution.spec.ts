import { randomInt, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { e2eUrl } from "./environment";
import { seedStudent, signInStaff } from "./support";
import { enrolments, instalments, students } from "../../src/db/schema";
import { nicLookup } from "../../src/lib/crypto";

test("Super Admin corrects a staged identifier and imports its opening schedule", async ({ page }) => {
  const f = await seedStudent();
  const suffix = randomUUID().slice(0, 8);
  const name = `Identifier Acceptance ${suffix}`;
  const correctedNic = `1999${randomInt(10000000, 99999999)}`;
  const intakeCode = f.intakeLabel.replace("Acceptance ", "");
  await signInStaff(page);
  await page.goto("/staff/imports");
  const csv = [
    "student_ref,full_name,nic,programme_code,intake_code,instalment_sequence,period_label,amount,due_date",
    `ID-${suffix},${name},,ACCEPTANCE,${intakeCode},1,Opening tuition,1000.00,2034-12-20`,
  ].join("\n");
  await page.getByLabel("CSV contents", { exact: true }).fill(csv);
  await page.getByRole("button", { name: "Run dry-run", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dry-run results", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Commit reviewed import", exact: true }).click();
  await expect(page.getByText(/Created 0 students, 0 enrolments and 0 instalments\. Identity resolutions: 1/)).toBeVisible();
  await page.getByRole("link", { name: "Identity resolution queue", exact: true }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await row.getByRole("button", { name: "Resolve", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Correct identifier and import", exact: true });
  await dialog.getByLabel("Corrected NIC", { exact: true }).fill(correctedNic);
  await dialog.getByLabel("Reason for the correction", { exact: true }).fill("Synthetic acceptance correction confirmed with source record");
  await expect(dialog.getByLabel("Instalment 1 amount in LKR", { exact: true })).toHaveValue("1000.00");
  const resolved = page.waitForResponse(response => response.url().endsWith("/resolve") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Import corrected record", exact: true }).click();
  expect((await resolved).status()).toBe(200);
  await expect(dialog).not.toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByRole("tab", { name: /^Resolved/ }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  const client = postgres(e2eUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await drizzle(client).select({ name: students.fullName, charge: instalments.originalChargeMinor, date: instalments.dueDate })
      .from(students).innerJoin(enrolments, eq(enrolments.studentId, students.id))
      .innerJoin(instalments, eq(instalments.enrolmentId, enrolments.id))
      .where(eq(students.nicLookup, nicLookup(correctedNic)));
    expect(rows).toEqual([{ name, charge: 100000, date: "2034-12-20" }]);
  } finally { await client.end(); }
});
