import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb, closeDb, makeProgramme, makeIntake, makeStudent, makeEnrolment, makeStaff, principalOf } from "./helpers";
import { db } from "@/db/client";
import { paymentEvents, paymentSubmissions, receiptAssets } from "@/db/schema";
import { approveSubmission, pendingQueue, queueFilters } from "@/server/services/review";

beforeEach(async () => { process.env.T2T_FAKE_NOW = "2026-11-16T06:00:00Z"; await resetDb(); });
afterAll(closeDb);

async function fixture(scan: typeof receiptAssets.$inferInsert["scan"], validation: typeof receiptAssets.$inferInsert["validation"] = "CLEAN") {
  const programme = await makeProgramme(), intake = await makeIntake(programme.id), student = await makeStudent();
  const e = await makeEnrolment(student.id, intake.id, [{ amountMinor: 10000, dueDate: "2026-11-01" }]);
  const staff = await makeStaff("SUPER_ADMIN"), p = principalOf(staff);
  const [asset] = await db().insert(receiptAssets).values({ enrolmentId: e.enrolment.id, objectKey: `receipts/${randomUUID()}`, sha256: randomUUID(), mime: "image/png", sizeBytes: 100, scan, validation }).returning();
  const [submission] = await db().insert(paymentSubmissions).values({ enrolmentId: e.enrolment.id, targetInstalmentId: e.instalments[0].id, assetId: asset.id, claimedMinor: 10000, transferDate: "2026-11-15", idempotencyKey: randomUUID() }).returning();
  return { p, submission, asset };
}
describe("receipt readiness and queue calendar validation", () => {
  it.each(["ERROR", "PENDING", "INFECTED"] as const)("blocks approval while malware scan is %s, preserving pending evidence and money", async scan => {
    const x = await fixture(scan);
    await expect(approveSubmission(x.p, { submissionId: x.submission.id, expectedVersion: x.submission.version }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
    const [row] = await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.id, x.submission.id));
    expect(row.status).toBe("PENDING_REVIEW"); expect(await db().select().from(paymentEvents)).toHaveLength(0);
  });
  it.each(["CLEAN", "NOT_CONFIGURED"] as const)("retains supported approval behavior for scan %s", async scan => {
    const x = await fixture(scan);
    expect(await approveSubmission(x.p, { submissionId: x.submission.id, expectedVersion: x.submission.version }, randomUUID())).toMatchObject({ status: "APPROVED" });
    expect(await db().select().from(paymentEvents)).toHaveLength(1);
  });
  it("does not let a clean scan bypass quarantined file validation", async () => {
    const x = await fixture("CLEAN", "QUARANTINED");
    await expect(approveSubmission(x.p, { submissionId: x.submission.id, expectedVersion: x.submission.version }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(paymentEvents)).toHaveLength(0);
  });
  it.each(["2026-99-99", "2026-02-30", "2025-02-29", "2026-11-31", "bad-date"])("rejects impossible date %s before querying PostgreSQL", date => {
    expect(queueFilters.safeParse({ from: date }).success).toBe(false);
    expect(queueFilters.safeParse({ to: date }).success).toBe(false);
  });
  it("rejects reversed date ranges and allows real leap days and inclusive endpoints", async () => {
    expect(queueFilters.safeParse({ from: "2026-11-16", to: "2026-11-15" }).success).toBe(false);
    expect(queueFilters.safeParse({ from: "2024-02-29", to: "2024-02-29" }).success).toBe(true);
    const x = await fixture("CLEAN");
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit" }).format(x.submission.submittedAt);
    const result = await pendingQueue(db(), x.p, queueFilters.parse({ from: day, to: day }));
    expect(result.items.map(row => row.id)).toEqual([x.submission.id]);
  });
});
