import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { e2eUrl } from "./environment";
import { seedStudent } from "./support";
import { intakes } from "../../src/db/schema";

test("shared programme link asks only NIC and overrides a different remembered course", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const student = await seedStudent();
  const other = await seedStudent();
  const entry = await page.goto(`/join/${student.intakeId}`);
  expect(entry?.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByLabel("NIC number", { exact: true })).toBeVisible();
  expect(pageErrors, "the pinned entry page should hydrate without a browser exception").toEqual([]);
  await expect(page.getByRole("combobox", { name: "Course and intake", exact: true })).toHaveCount(0);
  await page.evaluate(id => localStorage.setItem("t2t:lastIntake", id), other.intakeId);
  await page.reload();
  await page.getByLabel("NIC number", { exact: true }).fill(student.nic);
  expect(pageErrors, "the pinned entry page should remain free of hydration exceptions after reload").toEqual([]);
  const entered = page.waitForResponse(response => response.url().endsWith("/api/student/entry") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const response = await entered;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().intakeId).toBe(student.intakeId);
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole("heading", { name: student.name, exact: true })).toBeVisible();
});

test("shared link keeps a NIC from another intake out with the neutral eligibility message", async ({ page }) => {
  const student = await seedStudent();
  const other = await seedStudent();
  await page.goto(`/join/${student.intakeId}`);
  await page.getByLabel("NIC number", { exact: true }).fill(other.nic);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("We could not find an eligible enrolment.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/join/${student.intakeId}$`));
});

test("invalid and non-public shared links cannot expose an entry form", async ({ page }) => {
  const student = await seedStudent();
  const client = postgres(e2eUrl, { max: 1, onnotice: () => {} });
  try { await drizzle(client).update(intakes).set({ isPublic: false }).where(eq(intakes.id, student.intakeId)); }
  finally { await client.end(); }
  for (const id of ["not-a-course", randomUUID(), student.intakeId]) {
    const response = await page.goto(`/join/${id}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByLabel("NIC number", { exact: true })).toHaveCount(0);
  }
});
