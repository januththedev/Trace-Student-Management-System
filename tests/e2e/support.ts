import { randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { expect, type Locator, type Page } from "@playwright/test";
import { e2eUrl, PROGRAMME_ID, STAFF_EMAIL, STAFF_PASSWORD } from "./environment";
import { enrolments, feePlanItems, feePlanVersions, instalments, intakes, studentSessions, students } from "../../src/db/schema";
import { encryptNic, hashToken, nicLookup } from "../../src/lib/crypto";
import { maskNic } from "../../src/lib/nic";

export async function seedStudent() {
  const client = postgres(e2eUrl, { max: 1, onnotice: () => {} });
  const database = drizzle(client);
  const suffix = randomUUID().slice(0, 8), nic = `1999${randomInt(10000000, 99999999)}`;
  try {
    return await database.transaction(async (tx) => {
      const [intake] = await tx.insert(intakes).values({ programmeId: PROGRAMME_ID, code: suffix, label: `Acceptance ${suffix}`, startDate: "2020-01-01" }).returning();
      const [student] = await tx.insert(students).values({ ref: `E2E-${suffix}`, fullName: `Acceptance Student ${suffix}`, phone: "+94770000000", nicEnc: encryptNic(nic), nicLookup: nicLookup(nic), nicMasked: maskNic(nic) }).returning();
      const [version] = await tx.insert(feePlanVersions).values({ intakeId: intake.id, versionNo: 1 }).returning();
      const [item] = await tx.insert(feePlanItems).values({ versionId: version.id, sequence: 1, periodLabel: "December tuition", amountMinor: 1_000_000, dueDate: "2020-12-20" }).returning();
      const [enrolment] = await tx.insert(enrolments).values({ studentId: student.id, intakeId: intake.id, feePlanVersionId: version.id }).returning();
      const [instalment] = await tx.insert(instalments).values({ enrolmentId: enrolment.id, feePlanItemId: item.id, sequence: 1, periodLabel: item.periodLabel, originalChargeMinor: item.amountMinor, dueDate: item.dueDate }).returning();
      return { nic, intakeId: intake.id, intakeLabel: intake.label, name: student.fullName, enrolmentId: enrolment.id, instalmentId: instalment.id };
    });
  } finally { await client.end(); }
}
export type StudentFixture = Awaited<ReturnType<typeof seedStudent>>;

export async function chooseIntake(page: Page, label: string, f: StudentFixture) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option").filter({ hasText: f.intakeLabel }).click();
}

export async function expireSession(token: string) {
  const client = postgres(e2eUrl, { max: 1, onnotice: () => {} });
  try {
    await drizzle(client).update(studentSessions).set({ idleExpiresAt: new Date(0) })
      .where(eq(studentSessions.tokenHash, hashToken(token, "student-session")));
  } finally { await client.end(); }
}

export async function enterStudent(page: Page, f: StudentFixture, remember = false) {
  await page.goto("/");
  await chooseIntake(page, "Course and intake", f);
  await page.getByLabel("NIC number", { exact: true }).fill(f.nic);
  if (remember) await page.getByLabel(/Remember on this device/).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // The isolated Next dev server compiles this private route on its first visit.
  await expect(page).toHaveURL(/\/me$/, { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: f.name, exact: true })).toBeVisible();
}

export async function uploadReceipt(page: Page, f: StudentFixture, amount = "4000") {
  await expect(page.getByRole("combobox", { name: "Instalment you paid for", exact: true })).toContainText("December tuition");
  await page.getByLabel("Amount transferred (LKR)", { exact: true }).fill(amount);
  await page.getByRole("button", { name: "Transfer date", exact: true }).click();
  await page.getByRole("combobox", { name: /year/i }).click();
  await page.getByRole("option", { name: "2020", exact: true }).click();
  await page.getByRole("combobox", { name: /month/i }).click();
  await page.getByRole("option", { name: "December", exact: true }).click();
  await page.getByRole("button", { name: /December 20.*2020/ }).click();
  await page.getByLabel("Receipt file", { exact: true }).setInputFiles(path.resolve("fixtures/receipts/receipt-1.png"));
  const response = page.waitForResponse((r) => r.url().endsWith("/api/student/submissions") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Submit receipt", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(201);
  expect(result.request().postDataJSON()).toMatchObject({ targetInstalmentId: f.instalmentId, transferDate: "2020-12-20" });
  await expect(page.getByText("Receipt submitted. Staff will review it.", { exact: true })).toBeVisible();
  const body = await result.json() as { submissionId: string };
  return body.submissionId;
}

export async function signInStaff(page: Page) {
  await page.goto("/staff/login");
  await page.getByLabel("Work email", { exact: true }).fill(STAFF_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
  await page.getByRole("button", { name: "Sign in to your workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

export async function openReview(page: Page, f: StudentFixture) {
  await page.goto("/staff/review");
  await chooseIntake(page, "Programme / intake", f);
  await expect(page.getByRole("img", { name: `Receipt from ${f.name}`, exact: true })).toBeVisible();
}

// Tab through actual document order so the keyboard case detects unreachable controls.
export async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 70; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

