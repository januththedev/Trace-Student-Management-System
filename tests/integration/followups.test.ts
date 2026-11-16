import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";
import { db, withTx } from "@/db/client";
import { businessHolidays, callAttempts, chargeAdjustments, enrolments, exemptionApplications, exemptionAwards, followUpTasks, jobLeases, jobRuns, paymentAllocations, paymentEvents, paymentPromises, paymentSubmissions, programmes, staffAccounts, staffScopes, students } from "@/db/schema";
import { recordCallAttempt } from "@/server/services/followups/attempts";
import { inContactWindow, isBusinessDay, nextBusinessDay, saveHoliday } from "@/server/services/followups/calendar";
import { runFollowUpJobs } from "@/server/services/followups/jobs";
import { recomputePromises } from "@/server/services/followups/promises";
import { getCallCard, getCallQueue } from "@/server/services/followups/queue";
import { closeTask, leaseTask, upsertTask } from "@/server/services/followups/tasks";
import { loadLedger } from "@/server/services/ledger";
import { NextRequest } from "next/server";
import { POST as cronPost } from "@/app/api/cron/followups/route";

beforeEach(async () => { await resetDb(); pinNow("2026-11-16T04:30:00Z"); });
afterEach(() => { unpinNow(); delete process.env.T2T_BUSINESS_WEEKDAYS; });
afterAll(closeDb);
async function fixture(role: "ADMIN" | "SUPER_ADMIN" = "SUPER_ADMIN") {
  const programme = await makeProgramme(); const intake = await makeIntake(programme.id); const student = await makeStudent();
  const staff = await makeStaff(role, { scopes: [{ programmeId: programme.id }] }); const p = principalOf(staff, [{ programmeId: programme.id }]);
  const e = await makeEnrolment(student.id, intake.id, [{ amountMinor: 10000, dueDate: "2026-11-01" }, { amountMinor: 10000, dueDate: "2026-11-02" }]);
  return { programme, intake, student, staff, p, ...e };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function attempt(f: Fixture, outcome: string, extra: Record<string, unknown> = {}) {
  const [e] = await db().select().from(enrolments).where(eq(enrolments.id, f.enrolment.id));
  return recordCallAttempt(f.p, { enrolmentId: e.id, expectedVersion: e.version, expectedStudentVersion: f.student.version, clientAttemptId: randomUUID(), outcome, ...extra });
}
async function promise(f: Fixture, extra: Record<string, unknown> = {}) {
  const saved = await attempt(f, "PROMISED_TO_PAY", { amountMinor: 10000, promisedDate: "2026-11-17", targetInstalmentIds: [f.instalments[0].id], notes: "Will pay first instalment", ...extra });
  return (await db().select().from(paymentPromises).where(eq(paymentPromises.id, saved.attempt.promiseId!)))[0];
}
async function approve(f: Fixture, amountMinor: number, index = 0) {
  const [event] = await db().insert(paymentEvents).values({ enrolmentId: f.enrolment.id, kind: "RECEIPT", amountMinor, effectiveDate: "2026-11-16", createdAt: new Date(process.env.T2T_FAKE_NOW!) }).returning();
  const [allocation] = await db().insert(paymentAllocations).values({ enrolmentId: f.enrolment.id, instalmentId: f.instalments[index].id, paymentEventId: event.id, amountMinor, source: "SUBMISSION", createdAt: new Date(process.env.T2T_FAKE_NOW!) }).returning();
  await withTx(tx => recomputePromises(tx, f.enrolment.id)); return { event, allocation };
}
async function currentPromise(id: string) { return (await db().select().from(paymentPromises).where(eq(paymentPromises.id, id)))[0]; }
async function waive(f: Fixture) {
  const [award] = await db().insert(exemptionAwards).values({ enrolmentId: f.enrolment.id, type: "ARREARS_WAIVER", basis: "FIXED", value: 10000, reason: "Approved waiver", approverId: f.staff.id, effectiveFrom: "2026-11-16" }).returning();
  await db().insert(exemptionApplications).values({ awardId: award.id, enrolmentId: f.enrolment.id, instalmentId: f.instalments[0].id, amountMinor: 10000 });
  await withTx(tx => recomputePromises(tx, f.enrolment.id));
}

describe("follow-up outcomes (acceptance 13)", () => {
  it("records immutable no answers, retries next business day and pauses at three", async () => {
    const f = await fixture();
    await db().insert(businessHolidays).values({ day: "2026-11-17", label: "Explicit holiday" });
    const first = await attempt(f, "NO_ANSWER");
    const retry = (await db().select().from(followUpTasks).where(eq(followUpTasks.id, first.attempt.followUpTaskId!)))[0];
    expect(retry.type).toBe("COLLECTION_CALL"); expect(retry.dueAt.toISOString()).toBe("2026-11-18T03:30:00.000Z");
    pinNow("2026-11-18T04:30:00Z"); await attempt(f, "NO_ANSWER");
    pinNow("2026-11-19T04:30:00Z"); await attempt(f, "NO_ANSWER");
    const tasks = await db().select().from(followUpTasks).where(and(eq(followUpTasks.enrolmentId, f.enrolment.id), eq(followUpTasks.state, "OPEN")));
    expect(tasks.map(t => t.type)).toEqual(["ESCALATION"]);
    pinNow("2026-11-20T04:30:00Z"); await runFollowUpJobs();
    expect((await getCallQueue(f.p)).items[0].callable).toBe(false);
    await expect(attempt(f, "NO_ANSWER")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(callAttempts)).toHaveLength(3);
  });
  it("requires answered notes and resolution or next action, and appends corrections", async () => {
    const f = await fixture();
    await expect(attempt(f, "ANSWERED", { notes: "Discussed" })).rejects.toThrow();
    const saved = await attempt(f, "ANSWERED", { notes: "Needs a callback", resolved: false, nextAction: "Discuss payment", nextDate: "2026-11-17" });
    expect((await db().select().from(followUpTasks))[0].type).toBe("CALLBACK");
    await attempt(f, "CORRECTION", { notes: "Callback requested in the afternoon", correctsAttemptId: saved.attempt.id });
    const rows = await db().select().from(callAttempts);
    expect(rows).toHaveLength(2); expect(rows.find(r => r.id === saved.attempt.id)?.notes).toBe("Needs a callback");
    expect(rows.find(r => r.outcome === "CORRECTION")?.correctsAttemptId).toBe(saved.attempt.id);
    pinNow("2026-11-17T04:30:00Z");
    await attempt(f, "ANSWERED", { notes: "Resolved", resolved: true });
    expect((await db().select().from(followUpTasks).where(eq(followUpTasks.state, "OPEN")))).toHaveLength(0);
  });
  it("already paid shows submissions and creates verification without changing money", async () => {
    const f = await fixture();
    const [sub] = await db().insert(paymentSubmissions).values({ enrolmentId: f.enrolment.id, targetInstalmentId: f.instalments[1].id, claimedMinor: 10000, transferDate: "2026-11-15", idempotencyKey: randomUUID() }).returning();
    const before = await loadLedger(db(), f.enrolment.id);
    const saved = await attempt(f, "ALREADY_PAID");
    expect(saved.submissions[0].id).toBe(sub.id); expect((await db().select().from(followUpTasks))[0].type).toBe("VERIFY_PAYMENT");
    expect((await loadLedger(db(), f.enrolment.id)).summary).toEqual(before.summary);
    expect(await db().select().from(paymentEvents)).toHaveLength(0); expect(await db().select().from(paymentAllocations)).toHaveLength(0);
    expect(saved.attempt.balanceSnapshot.outstandingMinor).toBe(20000);
  });
  it("records an owned assistance task with all required details", async () => {
    const f = await fixture();
    await expect(attempt(f, "NEEDS_ASSISTANCE")).rejects.toThrow();
    await attempt(f, "NEEDS_ASSISTANCE", { category: "Financial hardship", reason: "Needs a plan", priority: 1, dueDate: "2026-11-18" });
    expect((await db().select().from(followUpTasks))[0]).toMatchObject({ type: "ASSISTANCE", ownerId: f.staff.id, category: "Financial hardship", reason: "Needs a plan", priority: 1 });
  });
  it("not continuing returns a preview pointer without withdrawing", async () => {
    const f = await fixture(); const saved = await attempt(f, "NOT_CONTINUING");
    expect(saved.pointer).toContain("withdrawal"); expect((await db().select().from(enrolments))[0].status).toBe("ACTIVE"); expect((await loadLedger(db(), f.enrolment.id)).summary.outstandingMinor).toBe(20000);
  });
  it("opens authorised exemptions or creates an approval request for an Admin", async () => {
    const f = await fixture("ADMIN"); await attempt(f, "FREE_CARD_SPONSORED");
    expect((await db().select().from(followUpTasks))[0].type).toBe("EXEMPTION_APPROVAL");
    const superStaff = await makeStaff("SUPER_ADMIN"); f.p = principalOf(superStaff);
    const saved = await attempt(f, "FREE_CARD_SPONSORED", { manualOverrideReason: "Super Admin requested follow-up" });
    expect(saved.pointer).toContain("exemptions"); expect(await db().select().from(exemptionAwards)).toHaveLength(0);
  });
  it("flags wrong numbers and blocks further calls even with an override", async () => {
    const f = await fixture(); await attempt(f, "WRONG_NUMBER");
    expect((await db().select().from(students))[0].wrongNumber).toBe(true);
    const card = (await getCallQueue(f.p)).items[0]; expect(card.flags).toContain("Wrong number"); expect(card.callable).toBe(false);
    await expect(attempt(f, "NO_ANSWER", { manualOverrideReason: "Try again" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("replays concurrent saves by operator/client ID and rejects different payloads", async () => {
    const f = await fixture(); const input = { enrolmentId: f.enrolment.id, expectedVersion: 1, clientAttemptId: randomUUID(), outcome: "NO_ANSWER" };
    const [a, b] = await Promise.all([recordCallAttempt(f.p, input, "http-key-one"), recordCallAttempt(f.p, input, "http-key-two")]);
    expect(a.attempt.id).toBe(b.attempt.id); expect(await db().select().from(callAttempts)).toHaveLength(1);
    await expect(recordCallAttempt(f.p, { ...input, notes: "Changed" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(attempt(f, "NO_ANSWER")).rejects.toMatchObject({ code: "CONFLICT" });
    await attempt(f, "NO_ANSWER", { manualOverrideReason: "Requested second attempt" });
    expect(await db().select().from(callAttempts)).toHaveLength(2);
  });
});

describe("queue eligibility and scope (acceptance 14)", () => {
  it("holds only evidence targets while paid, exempt, withdrawn, inactive and trashed leave", async () => {
    const f = await fixture();
    await db().insert(paymentSubmissions).values({ enrolmentId: f.enrolment.id, targetInstalmentId: f.instalments[0].id, claimedMinor: 1, transferDate: "2026-11-16", idempotencyKey: randomUUID() });
    const queue = await getCallQueue(f.p); expect(queue.items).toHaveLength(1); expect(queue.items[0].dueInstalments.map(i => i.id)).toEqual([f.instalments[1].id]); expect(queue.items[0].pendingEvidence).toHaveLength(1);
    await approve(f, 10000, 1); expect((await getCallQueue(f.p)).items).toHaveLength(0);
    await db().update(paymentSubmissions).set({ status: "REJECTED" }); expect((await getCallQueue(f.p)).items).toHaveLength(1);
    await waive(f); expect((await getCallQueue(f.p)).items).toHaveLength(0);
    await db().update(exemptionApplications).set({ reversedAt: new Date() });
    await db().update(enrolments).set({ status: "WITHDRAWN" }); expect((await getCallQueue(f.p)).items).toHaveLength(0);
    await db().update(enrolments).set({ status: "INACTIVE" }); expect((await getCallQueue(f.p)).items).toHaveLength(0);
    await db().update(enrolments).set({ status: "ACTIVE" });
    await db().update(programmes).set({ trashedAt: new Date() }); expect((await getCallQueue(f.p)).items).toHaveLength(0);
    await expect(attempt(f, "NO_ANSWER")).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("shows do-not-call cards as flagged and excludes future-only obligations", async () => {
    const f = await fixture(); await db().update(students).set({ doNotCall: true });
    expect((await getCallQueue(f.p)).items[0]).toMatchObject({ callable: false, flags: ["Do not call"] });
    const student = await makeStudent(); await makeEnrolment(student.id, f.intake.id, [{ amountMinor: 10000, dueDate: "2027-01-01" }]);
    expect((await getCallQueue(f.p)).items).toHaveLength(1);
  });
  it("paginates without duplicate cards and reloads scopes/account state in mutations", async () => {
    const f = await fixture("ADMIN"); const second = await fixture();
    const queue = await getCallQueue(f.p, { limit: 1 }); expect(queue.items.map(c => c.id)).toEqual([f.enrolment.id]);
    expect((await getCallQueue(f.p, { cursor: queue.nextCursor, limit: 1 })).items).toHaveLength(0);
    await expect(getCallCard(f.p, second.enrolment.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().delete(staffScopes).where(eq(staffScopes.staffId, f.staff.id));
    await expect(attempt(f, "NO_ANSWER")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().update(staffAccounts).set({ status: "DEACTIVATED" }).where(eq(staffAccounts.id, f.staff.id));
    await expect(getCallQueue(f.p)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("rejects stale card versions and missing/out-of-scope targets", async () => {
    const f = await fixture();
    await expect(recordCallAttempt(f.p, { enrolmentId: f.enrolment.id, expectedVersion: 99, clientAttemptId: randomUUID(), outcome: "NO_ANSWER" })).rejects.toMatchObject({ code: "STALE" });
    await expect(promise(f, { targetInstalmentIds: [randomUUID()] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db().select().from(callAttempts)).toHaveLength(0);
  });
});

describe("promise accounting (acceptance 15)", () => {
  it("uses an approved allocation baseline, warns on excess and never changes the ledger", async () => {
    const f = await fixture(); await approve(f, 2000);
    const before = await loadLedger(db(), f.enrolment.id);
    const saved = await attempt(f, "PROMISED_TO_PAY", { amountMinor: 9000, promisedDate: "2026-11-17", targetInstalmentIds: [f.instalments[0].id], notes: "Promised partial payment" });
    expect(saved.warning).toBeTruthy(); expect((await currentPromise(saved.attempt.promiseId!)).baselineAllocatedMinor).toBe(2000);
    expect((await loadLedger(db(), f.enrolment.id)).summary).toEqual(before.summary);
  });
  it("ignores claims and unrelated allocations, then partially/fully fulfils and reopens on reversal", async () => {
    const f = await fixture(); await approve(f, 2000); const p = await promise(f, { amountMinor: 8000 });
    await db().insert(paymentSubmissions).values({ enrolmentId: f.enrolment.id, targetInstalmentId: f.instalments[0].id, claimedMinor: 8000, transferDate: "2026-11-16", idempotencyKey: randomUUID() });
    await approve(f, 3000, 1); expect((await currentPromise(p.id)).state).toBe("OPEN");
    await approve(f, 3000); expect(await currentPromise(p.id)).toMatchObject({ state: "PARTIALLY_FULFILLED", fulfilledMinor: 3000 });
    const { event, allocation } = await approve(f, 5000); expect(await currentPromise(p.id)).toMatchObject({ state: "FULFILLED", fulfilledMinor: 8000 });
    expect((await db().select().from(followUpTasks).where(eq(followUpTasks.type, "CALLBACK")))[0].state).toBe("DONE");
    await db().insert(paymentEvents).values({ enrolmentId: f.enrolment.id, kind: "REVERSAL", amountMinor: 5000, reversesEventId: event.id, effectiveDate: "2026-11-16" });
    await db().update(paymentAllocations).set({ reversedAt: new Date(), reversalReason: "Approval undone" }).where(eq(paymentAllocations.id, allocation.id));
    await withTx(tx => recomputePromises(tx, f.enrolment.id));
    expect(await currentPromise(p.id)).toMatchObject({ state: "PARTIALLY_FULFILLED", fulfilledMinor: 3000 });
  });
  it("keeps promises due through the Colombo day and breaks them strictly after midnight", async () => {
    const f = await fixture(); const p = await promise(f);
    pinNow("2026-11-17T18:29:59.999Z"); await withTx(tx => recomputePromises(tx, f.enrolment.id)); expect((await currentPromise(p.id)).state).toBe("OPEN");
    pinNow("2026-11-17T18:30:00.000Z"); await runFollowUpJobs(); expect((await currentPromise(p.id)).state).toBe("BROKEN");
  });
  it("supersedes earlier open promises while preserving their history", async () => {
    const f = await fixture(); const first = await promise(f); const second = await promise(f, { amountMinor: 5000, manualOverrideReason: "Student revised their promise" });
    expect(await currentPromise(first.id)).toMatchObject({ state: "SUPERSEDED", supersededById: second.id }); expect(await db().select().from(paymentPromises)).toHaveLength(2);
  });
  it("cancels waived or withdrawal-cancelled debt without cash fulfilment", async () => {
    const f = await fixture(); const p = await promise(f); await waive(f);
    expect(await currentPromise(p.id)).toMatchObject({ state: "CANCELLED", fulfilledMinor: 0 });
    const second = await fixture(); const p2 = await promise(second);
    await db().insert(chargeAdjustments).values({ enrolmentId: second.enrolment.id, instalmentId: second.instalments[0].id, amountMinor: -10000, kind: "WITHDRAWAL_CANCEL", reason: "Cancelled on withdrawal", effectiveDate: "2026-11-16" });
    await withTx(tx => recomputePromises(tx, second.enrolment.id)); expect(await currentPromise(p2.id)).toMatchObject({ state: "CANCELLED", fulfilledMinor: 0 });
  });
});

describe("calendar, coordination and jobs", () => {
  it("uses explicit holidays and configurable working days within 09:00–17:00", async () => {
    const f = await fixture(); expect(await isBusinessDay(db(), "2026-11-16")).toBe(true);
    await saveHoliday(f.p, { day: "2026-11-17", label: "Office holiday", expectedLabel: null }, "holiday-first");
    expect(await nextBusinessDay(db(), "2026-11-16")).toBe("2026-11-18");
    expect(await inContactWindow(db(), new Date("2026-11-16T03:29:59Z"))).toBe(false);
    expect(await inContactWindow(db(), new Date("2026-11-16T03:30:00Z"))).toBe(true);
    expect(await inContactWindow(db(), new Date("2026-11-16T11:30:00Z"))).toBe(false);
    process.env.T2T_BUSINESS_WEEKDAYS = "0,1,2,3,4,5,6"; expect(await isBusinessDay(db(), "2026-11-22")).toBe(true);
    const admin = await makeStaff("ADMIN"); await expect(saveHoliday(principalOf(admin), { day: "2026-11-18", label: "No", expectedLabel: null }, "holiday-admin")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await saveHoliday(f.p, { day: "2026-11-17", label: "Office holiday", expectedLabel: "Office holiday" }, "holiday-remove", true);
    expect(await isBusinessDay(db(), "2026-11-17")).toBe(true);
  });
  it("deduplicates tasks, leases briefly and requires a versioned reason to close", async () => {
    const f = await fixture();
    const create = () => withTx(tx => upsertTask(tx, { enrolmentId: f.enrolment.id, type: "ASSISTANCE", dedupeKey: "assistance:one", dueAt: new Date() }));
    const task = await create(); expect((await create()).id).toBe(task.id);
    const leased = await leaseTask(f.p, task.id, { expectedVersion: 1 }, "lease-the-task");
    const other = await makeStaff("SUPER_ADMIN");
    await expect(leaseTask(principalOf(other), task.id, { expectedVersion: 2 }, "another-lease")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(closeTask(f.p, task.id, { expectedVersion: 1, reason: "Done" }, "stale-close-key")).rejects.toMatchObject({ code: "STALE" });
    const done = await closeTask(f.p, task.id, { expectedVersion: leased.version, reason: "Assistance provided" }, "close-the-task");
    expect(done.state).toBe("DONE"); expect((await closeTask(f.p, task.id, { expectedVersion: leased.version, reason: "Assistance provided" }, "close-the-task")).id).toBe(task.id);
  });
  it("protects a leased call even when an attempt omits its task ID", async () => {
    const f = await fixture(); await runFollowUpJobs();
    const task = (await db().select().from(followUpTasks))[0];
    await leaseTask(f.p, task.id, { expectedVersion: task.version }, "call-task-lease");
    const other = await makeStaff("SUPER_ADMIN");
    await expect(recordCallAttempt(principalOf(other), { enrolmentId: f.enrolment.id, expectedVersion: 1, clientAttemptId: randomUUID(), outcome: "NO_ANSWER" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("resumes retries with a fresh unanswered streak after staff close an escalation", async () => {
    const f = await fixture();
    await attempt(f, "NO_ANSWER"); pinNow("2026-11-17T04:30:00Z"); await attempt(f, "NO_ANSWER"); pinNow("2026-11-18T04:30:00Z"); await attempt(f, "NO_ANSWER");
    const task = (await db().select().from(followUpTasks).where(eq(followUpTasks.type, "ESCALATION")))[0];
    await closeTask(f.p, task.id, { expectedVersion: task.version, reason: "Reviewed contact, resume attempts" }, "resolve-escalation");
    pinNow("2026-11-19T04:30:00Z"); await attempt(f, "NO_ANSWER");
    expect((await db().select().from(followUpTasks).where(eq(followUpTasks.state, "OPEN")))[0].type).toBe("COLLECTION_CALL");
  });
  it("catches up stale reviews and daily calls idempotently, respects the job lease", async () => {
    const f = await fixture(); await db().insert(paymentSubmissions).values({ enrolmentId: f.enrolment.id, targetInstalmentId: f.instalments[0].id, claimedMinor: 10000, transferDate: "2026-11-10", submittedAt: new Date("2026-11-10T00:00:00Z"), idempotencyKey: randomUUID() });
    await runFollowUpJobs(); await runFollowUpJobs();
    const tasks = await db().select().from(followUpTasks); expect(tasks.filter(t => t.type === "COLLECTION_CALL")).toHaveLength(1); expect(tasks.filter(t => t.type === "STALE_REVIEW")).toHaveLength(1);
    expect((await db().select().from(paymentSubmissions))[0].status).toBe("PENDING_REVIEW");
    expect((await db().select().from(jobRuns)).every(r => r.status === "SUCCEEDED")).toBe(true);
    await db().update(jobLeases).set({ holder: "other-worker", expiresAt: new Date("2026-11-16T05:00:00Z") });
    expect(await runFollowUpJobs()).toMatchObject({ skipped: true });
  });
  it("cancels obsolete scheduled tasks when evidence holds or withdrawal remove collectibility", async () => {
    const f = await fixture(); await runFollowUpJobs();
    await db().insert(paymentSubmissions).values(f.instalments.map(i => ({ enrolmentId: f.enrolment.id, targetInstalmentId: i.id, claimedMinor: 10000, transferDate: "2026-11-16", idempotencyKey: randomUUID() })));
    await runFollowUpJobs();
    expect((await db().select().from(followUpTasks).where(eq(followUpTasks.type, "COLLECTION_CALL")))[0].state).toBe("CANCELLED");
    await withTx(tx => upsertTask(tx, { enrolmentId: f.enrolment.id, type: "CALLBACK", dedupeKey: "withdrawn:callback", dueAt: new Date() }));
    await db().update(enrolments).set({ status: "WITHDRAWN" }); await runFollowUpJobs();
    expect((await db().select().from(followUpTasks).where(eq(followUpTasks.state, "OPEN")))).toHaveLength(0);
  });
  it("requires the cron bearer secret and sends private no-store responses", async () => {
    const ctx = { params: Promise.resolve({}) };
    const denied = await cronPost(new NextRequest("http://localhost/api/cron/followups", { method: "POST" }), ctx);
    expect(denied.status).toBe(401);
    const allowed = await cronPost(new NextRequest("http://localhost/api/cron/followups", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }), ctx);
    expect(allowed.status).toBe(200); expect(allowed.headers.get("cache-control")).toContain("no-store");
  });
});
