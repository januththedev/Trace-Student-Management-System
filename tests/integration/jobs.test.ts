import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";
import { db, withTx } from "@/db/client";
import { auditEvents, followUpTasks, jobLeases, jobRuns, notifications, outboxEvents, paymentAllocations, paymentEvents, paymentPromises, paymentSubmissions, programmes, receiptAssets, uploadIntents } from "@/db/schema";
import { notify } from "@/server/audit";
import { runFollowUpJobs } from "@/server/services/followups/jobs";
import { runPurgeJob } from "@/server/services/trash/purge";
import { cleanupOrphanUploads } from "@/server/services/submissions";
import { approveSubmission } from "@/server/services/review";
import { loadLedger } from "@/server/services/ledger";
import { objectStore } from "@/server/storage";
import { GET as deliverOutbox } from "@/app/api/cron/outbox/route";
import { GET as cleanupRoute } from "@/app/api/cron/uploads-cleanup/route";
import { GET as followupsRoute } from "@/app/api/cron/followups/route";
import { POST as purgeRoute } from "@/app/api/cron/purge/route";

// Acceptance 21: persistent PostgreSQL jobs and real local storage; no provider sends.
const AT = new Date("2026-11-16T04:30:00Z");
const originalCronSecret = process.env.CRON_SECRET;
const writtenKeys: string[] = [];
beforeEach(async () => { await resetDb(); pinNow(AT.toISOString()); process.env.CRON_SECRET = "synthetic-jobs-test-secret"; });
afterEach(async () => {
  unpinNow();
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalCronSecret;
  for (const key of writtenKeys.splice(0)) await objectStore().delete(key);
});
afterAll(closeDb);

async function fixture() {
  const programme = await makeProgramme(); const intake = await makeIntake(programme.id);
  const student = await makeStudent(); const staff = await makeStaff("SUPER_ADMIN"); const p = principalOf(staff);
  const e = await makeEnrolment(student.id, intake.id, [{ amountMinor: 10000, dueDate: "2026-11-01" }, { amountMinor: 10000, dueDate: "2026-11-02" }]);
  const [asset] = await db().insert(receiptAssets).values({ enrolmentId: e.enrolment.id, objectKey: `receipts/jobs/${randomUUID()}`, mime: "image/png", sha256: randomUUID(), sizeBytes: 12, validation: "CLEAN" }).returning();
  const [sub] = await db().insert(paymentSubmissions).values({ enrolmentId: e.enrolment.id, targetInstalmentId: e.instalments[0].id, assetId: asset.id, claimedMinor: 10000, transferDate: "2026-11-16", idempotencyKey: randomUUID(), submittedAt: new Date("2026-11-10T04:30:00Z") }).returning();
  return { programme, intake, student, p, ...e, asset, sub };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function approve(f: Fixture) { return approveSubmission(f.p, { submissionId: f.sub.id, expectedVersion: 1 }, randomUUID()); }
async function financeSnapshot(f: Fixture) {
  return {
    sub: await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.id, f.sub.id)),
    events: await db().select().from(paymentEvents).where(eq(paymentEvents.enrolmentId, f.enrolment.id)).orderBy(paymentEvents.id),
    allocations: await db().select().from(paymentAllocations).where(eq(paymentAllocations.enrolmentId, f.enrolment.id)).orderBy(paymentAllocations.id),
    ledger: await loadLedger(db(), f.enrolment.id),
  };
}
function cronRequest(path: string, authorized = true) {
  return new NextRequest(`http://localhost/api/cron/${path}`, { headers: authorized ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {} });
}
async function delivery() {
  const res = await deliverOutbox(cronRequest("outbox"), { params: Promise.resolve({}) });
  expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toContain("no-store");
  return await res.json() as { sent: number; skipped: number };
}
async function oldIntent(f: Fixture, attached: boolean) {
  const key = `receipts/jobs-orphan/${randomUUID()}`; writtenKeys.push(key);
  await objectStore().put(key, Buffer.from("synthetic private object"), "image/png");
  const [intent] = await db().insert(uploadIntents).values({ enrolmentId: f.enrolment.id, objectKey: key, declaredMime: "image/png", maxBytes: 1024, expiresAt: new Date("2026-11-10T00:00:00Z"), uploadedAt: new Date("2026-11-09T00:00:00Z") }).returning();
  if (attached) await db().insert(receiptAssets).values({ enrolmentId: f.enrolment.id, uploadIntentId: intent.id, objectKey: key, mime: "image/png", sha256: randomUUID(), sizeBytes: 24, validation: "CLEAN" });
  return intent;
}

describe("background replay, concurrency and missed days (scenario 21)", () => {
  it("runs follow-up jobs twice and concurrently without duplicate tasks, notifications or payment changes", async () => {
    const f = await fixture(); await approve(f); const before = await financeSnapshot(f);
    await runFollowUpJobs(); await runFollowUpJobs(); await Promise.all([runFollowUpJobs(), runFollowUpJobs(), runFollowUpJobs()]);
    const tasks = await db().select().from(followUpTasks).where(eq(followUpTasks.enrolmentId, f.enrolment.id));
    expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ type: "COLLECTION_CALL", state: "OPEN" });
    expect(new Set(tasks.map(t => t.dedupeKey)).size).toBe(tasks.length);
    expect(await db().select().from(notifications)).toHaveLength(1); expect(await db().select().from(outboxEvents)).toHaveLength(1);
    expect(await financeSnapshot(f)).toEqual(before);
    expect((await db().select().from(jobLeases).where(eq(jobLeases.job, "followups")))[0]).toMatchObject({ holder: null, expiresAt: null });
  });

  it("catches up missed collection days, broken promises and stale review exactly once", async () => {
    const f = await fixture();
    const [promise] = await db().insert(paymentPromises).values({ enrolmentId: f.enrolment.id, staffId: f.p.id, amountMinor: 10000, promisedDate: "2026-11-17", targetInstalmentIds: [f.instalments[1].id], baselineAllocatedMinor: 0 }).returning();
    await runFollowUpJobs();
    pinNow("2026-11-23T04:30:00Z");
    await Promise.all([runFollowUpJobs(), runFollowUpJobs()]); await runFollowUpJobs();
    const tasks = await db().select().from(followUpTasks).where(eq(followUpTasks.enrolmentId, f.enrolment.id));
    expect(tasks.filter(t => t.type === "STALE_REVIEW")).toHaveLength(1);
    expect(tasks.filter(t => t.type === "COLLECTION_CALL" && t.state === "OPEN")).toHaveLength(1);
    expect(tasks.find(t => t.type === "COLLECTION_CALL" && t.state === "OPEN")?.dedupeKey).toContain("2026-11-23");
    expect((await db().select().from(paymentPromises).where(eq(paymentPromises.id, promise.id)))[0].state).toBe("BROKEN");
    expect((await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.id, f.sub.id)))[0].status).toBe("PENDING_REVIEW");
    expect(await db().select().from(paymentEvents)).toEqual([]);
  });

  it("recovers expired worker leases and marks abandoned runs failed", async () => {
    await fixture();
    await db().insert(jobLeases).values({ job: "followups", holder: "dead-worker", expiresAt: new Date(AT.getTime() - 1) });
    const [old] = await db().insert(jobRuns).values({ job: "followups", status: "RUNNING", startedAt: new Date(AT.getTime() - 3600000) }).returning();
    expect((await runFollowUpJobs()).skipped).toBe(false);
    expect((await db().select().from(jobRuns).where(eq(jobRuns.id, old.id)))[0]).toMatchObject({ status: "FAILED" });
    expect((await runFollowUpJobs()).skipped).toBe(false);
  });

  it("purges eligible tombstones twice/concurrently while retaining payment history", async () => {
    const f = await fixture(); await approve(f); const before = await financeSnapshot(f);
    await db().update(programmes).set({ trashedAt: new Date("2026-10-01T00:00:00Z"), purgeAfter: new Date("2026-10-31T00:00:00Z"), purgeStatus: "PENDING" }).where(eq(programmes.id, f.programme.id));
    const runs = await Promise.all([runPurgeJob(), runPurgeJob()]); await runPurgeJob();
    expect(runs.reduce((n, r) => n + r.processed, 0)).toBe(1); expect(runs.every(r => r.failed === 0)).toBe(true);
    expect((await db().select().from(programmes).where(eq(programmes.id, f.programme.id)))[0]).toMatchObject({ purgeStatus: "PURGED", bannerPath: null });
    expect(await db().select().from(auditEvents).where(and(eq(auditEvents.action, "programme.purge"), eq(auditEvents.entityId, f.programme.id)))).toHaveLength(1);
    expect(await financeSnapshot(f)).toEqual(before); expect(await db().select().from(notifications)).toHaveLength(1);
  });

  it("records retention dependency failure and safely retries without reversing approved payments", async () => {
    const f = await fixture(); await approve(f); const before = await financeSnapshot(f);
    // Path rejection is a real external-cleanup failure; it must not be reported as purged.
    await db().update(programmes).set({ bannerPath: "/../outside-public.png", trashedAt: new Date("2026-10-01T00:00:00Z"), purgeAfter: new Date("2026-10-31T00:00:00Z"), purgeStatus: "PENDING" }).where(eq(programmes.id, f.programme.id));
    expect((await runPurgeJob()).failed).toBe(1); expect((await runPurgeJob()).failed).toBe(1);
    expect((await db().select().from(programmes).where(eq(programmes.id, f.programme.id)))[0]).toMatchObject({ purgeStatus: "FAILED", bannerPath: "/../outside-public.png" });
    expect(await financeSnapshot(f)).toEqual(before);
    // An operator repairs disposable configuration; the next retry succeeds once.
    await db().update(programmes).set({ bannerPath: null }).where(eq(programmes.id, f.programme.id));
    expect((await runPurgeJob()).processed).toBe(1); expect((await runPurgeJob()).processed).toBe(0);
  });

  it("cleans old unattached uploads twice/concurrently and keeps attached evidence", async () => {
    const f = await fixture(); await approve(f); const before = await financeSnapshot(f);
    const orphan = await oldIntent(f, false); const attached = await oldIntent(f, true);
    const runs = await Promise.all([cleanupOrphanUploads(), cleanupOrphanUploads()]);
    expect(runs.reduce((n, r) => n + r.cleaned, 0)).toBe(1); expect((await cleanupOrphanUploads()).cleaned).toBe(0);
    expect(await objectStore().exists(orphan.objectKey)).toBe(false); expect(await objectStore().exists(attached.objectKey)).toBe(true);
    expect((await db().select().from(uploadIntents).where(eq(uploadIntents.id, attached.id)))[0].status).toBe("FINALIZED");
    expect(await financeSnapshot(f)).toEqual(before);
  });

  it("atomically deduplicates portal notifications and marks events SENT only once across retries", async () => {
    const f = await fixture(); await approve(f); const before = await financeSnapshot(f);
    const n = { recipientType: "STUDENT" as const, recipientId: f.enrolment.id, event: "jobs.test", title: "Synthetic notification", body: "No external provider", dedupeKey: "jobs-notification" };
    await Promise.all([withTx(tx => notify(tx, n)), withTx(tx => notify(tx, n))]);
    // Explicit past time avoids mixing application fake time with the outbox's database clock.
    await db().update(outboxEvents).set({ nextAttemptAt: new Date("2000-01-01T00:00:00Z") });
    expect(await delivery()).toEqual({ sent: 2, skipped: 0 }); expect(await delivery()).toEqual({ sent: 0, skipped: 0 });
    await Promise.all([delivery(), delivery()]);
    const events = await db().select().from(outboxEvents);
    expect(events).toHaveLength(2); expect(events.every(e => e.status === "SENT" && e.attempts === 1 && e.sentAt !== null)).toBe(true);
    expect(await db().select().from(notifications)).toHaveLength(2); expect(await financeSnapshot(f)).toEqual(before);
  });

  it("does not fabricate external delivery or roll back an approved decision when a channel is unavailable", async () => {
    const f = await fixture(); await approve(f); const before = await financeSnapshot(f);
    await db().insert(outboxEvents).values({ channel: "unconfigured-provider", event: "jobs.test", payload: {}, dedupeKey: randomUUID(), nextAttemptAt: new Date("2000-01-01T00:00:00Z") });
    await db().update(outboxEvents).set({ nextAttemptAt: new Date("2000-01-01T00:00:00Z") });
    expect(await delivery()).toEqual({ sent: 1, skipped: 1 }); expect(await delivery()).toEqual({ sent: 0, skipped: 0 });
    expect((await db().select().from(outboxEvents).where(eq(outboxEvents.channel, "unconfigured-provider")))[0]).toMatchObject({ status: "SKIPPED", sentAt: null, lastError: "channel not enabled" });
    expect(await financeSnapshot(f)).toEqual(before);
  });

  it.each(["outbox", "uploads-cleanup", "followups", "purge"])("rejects unauthenticated %s scheduler invocation before starting a run", async path => {
    const handler = path === "outbox" ? deliverOutbox : path === "uploads-cleanup" ? cleanupRoute : path === "followups" ? followupsRoute : purgeRoute;
    const res = await handler(cronRequest(path, false), { params: Promise.resolve({}) });
    expect(res.status).toBe(401); expect(await db().select().from(jobRuns)).toHaveLength(0);
  });

  // F-09: SELECT FOR UPDATE runs outside a transaction. Workers count CAS losers as sent.
  it("F-09 concurrent outbox workers report a portal event SENT exactly once", async () => {
    const f = await fixture(); await approve(f);
    // A batch keeps each worker active through many real awaited updates, so overlapping
    // invocations read some of the same pending events without a timing/sleep mock.
    await db().insert(outboxEvents).values(Array.from({ length: 128 }, () => ({ channel: "portal", event: "jobs.concurrent", payload: {}, dedupeKey: randomUUID() })));
    await db().update(outboxEvents).set({ nextAttemptAt: new Date("2000-01-01T00:00:00Z") });
    const results = await Promise.all([delivery(), delivery(), delivery(), delivery()]);
    const events = await db().select().from(outboxEvents);
    expect(events).toHaveLength(129);
    expect(events.every(e => e.status === "SENT" && e.attempts === 1)).toBe(true);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(events.length);
  });
});
