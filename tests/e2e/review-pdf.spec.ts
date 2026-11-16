import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { PDFDocument, rgb } from "pdf-lib";
import { expect, test } from "@playwright/test";
import { staffAccounts, staffScopes } from "../../src/db/schema";
import { hashPassword } from "../../src/lib/crypto";
import { e2eUrl, PROGRAMME_ID } from "./environment";
import { chooseIntake, enterStudent, seedStudent } from "./support";

const PASSWORD = "PDF-review-only-test-password-842!";

async function createScopedReviewer() {
  const client = postgres(e2eUrl, { max: 1, onnotice: () => {} });
  try {
    const database = drizzle(client);
    const email = `pdf-review-${randomUUID()}@example.test`;
    const [staff] = await database.insert(staffAccounts).values({
      email,
      name: "PDF Review Acceptance",
      role: "ADMIN",
      capabilities: [],
      passwordHash: await hashPassword(PASSWORD),
    }).returning();
    await database.insert(staffScopes).values({ staffId: staff.id, programmeId: PROGRAMME_ID });
    return email;
  } finally {
    await client.end();
  }
}

async function twoPagePdf() {
  const pdf = await PDFDocument.create();
  for (const [label, color] of [["PAGE ONE RED", rgb(0.9, 0.12, 0.12)], ["PAGE TWO BLUE", rgb(0.1, 0.25, 0.9)]] as const) {
    const page = pdf.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color });
    page.drawText(label, { x: 72, y: 700, size: 36, color: rgb(1, 1, 1) });
  }
  return Buffer.from(await pdf.save());
}

async function uploadPdf(page: import("@playwright/test").Page) {
  await expect(page.getByRole("combobox", { name: "Instalment you paid for", exact: true })).toContainText("December tuition");
  await page.getByLabel("Amount transferred (LKR)", { exact: true }).fill("4000");
  await page.getByRole("button", { name: "Transfer date", exact: true }).click();
  await page.getByRole("combobox", { name: /year/i }).click();
  await page.getByRole("option", { name: "2020", exact: true }).click();
  await page.getByRole("combobox", { name: /month/i }).click();
  await page.getByRole("option", { name: "December", exact: true }).click();
  await page.getByRole("button", { name: /December 20.*2020/ }).click();
  await page.getByLabel("Receipt file", { exact: true }).setInputFiles({
    name: "two-page-receipt.pdf",
    mimeType: "application/pdf",
    buffer: await twoPagePdf(),
  });
  const response = page.waitForResponse((r) => r.url().endsWith("/api/student/submissions") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Submit receipt", exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(page.getByText("Receipt submitted. Staff will review it.", { exact: true })).toBeVisible();
}

async function sampledCenter(page: import("@playwright/test").Page) {
  return page.locator("canvas[aria-label*=', PDF page']").evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    const context = element.getContext("2d");
    if (!context) throw new Error("PDF canvas is unavailable");
    const { data } = context.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1);
    return [data[0], data[1], data[2]];
  });
}

test("staff can render and navigate every page of a private PDF on desktop and mobile", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const failedAssets: string[] = [];
  page.on("requestfailed", (request) => failedAssets.push(request.url()));
  const fixture = await seedStudent();
  await enterStudent(page, fixture);
  await uploadPdf(page);

  const reviewerEmail = await createScopedReviewer();
  await page.goto("/staff/login");
  await page.getByLabel("Work email", { exact: true }).fill(reviewerEmail);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in to your workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/staff$/);

  await page.goto("/staff/review");
  await chooseIntake(page, "Programme / intake", fixture);
  const viewer = page.getByRole("region", { name: /^Receipt from / });
  const pageNumber = viewer.getByRole("spinbutton", { name: "PDF page number" });
  await expect(pageNumber).toHaveValue("1", { timeout: 20_000 });
  await expect(viewer.locator("canvas")).toBeVisible();
  await expect.poll(async () => {
    const [red, green, blue] = await sampledCenter(page);
    return red > blue * 2 && red > green * 2;
  }).toBe(true);

  await viewer.getByRole("button", { name: "Next PDF page" }).click();
  await expect(pageNumber).toHaveValue("2");
  await expect.poll(async () => {
    const [red, green, blue] = await sampledCenter(page);
    return blue > red * 2 && blue > green * 1.5;
  }).toBe(true);

  const canvas = viewer.locator("canvas");
  const widthBeforeZoom = await canvas.evaluate((node) => node.getBoundingClientRect().width);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(widthBeforeZoom);
  await page.getByRole("button", { name: "Rotate" }).click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await viewer.getByRole("button", { name: "Previous PDF page" }).click();
  await expect(pageNumber).toHaveValue("1");
  const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
  expect(errors).toEqual([]);
  expect(failedAssets.filter((url) => url.includes("/vendor/pdfjs/") || url.includes("pdfjs"))).toEqual([]);
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pdf-review.png"), fullPage: true });
});
