import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db, withTx } from "@/db/client";
import {
  admissionEvents, admissions, auditEvents, enrolments, exemptionAwards, feePlanVersions, idempotencyRecords,
  instalments, intakes, notifications, outboxEvents, paymentEvents, paymentSubmissions, receiptAssets, reviewActions,
  staffAccounts, staffScopes, students,
} from "@/db/schema";
import { hashPayload } from "@/server/idempotency";
import { createStaffSession } from "@/server/auth/staff";
import { admissionInput, createAdmission, decideAdmission, grantExemption, revokeExemption } from "@/server/services/enrolments";
import { approveSubmission, correctApproval, undoDecision } from "@/server/services/review";
import { loadLedger } from "@/server/services/ledger";
import { POST as createRoute } from "@/app/api/staff/admissions/route";
import { POST as decideRoute } from "@/app/api/staff/admissions/[id]/route";
import { POST as enrolmentRoute } from "@/app/api/staff/enrolments/[id]/[action]/route";
import { POST as reviewRoute } from "@/app/api/staff/review/[id]/[action]/route";
import { closeDb, fakeNic, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";

// Supply only Next's request-local cookie boundary. Session lookup, CSRF and authorization
// still run against the real database through the production auth implementation.
const requestBoundary = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "t2t_staff" ? { value: requestBoundary.token } : undefined }),
  headers: async () => new Headers({ host: "localhost" }),
}));
beforeEach(async () => { await resetDb(); pinNow(new Date().toISOString()); requestBoundary.token = ""; });
afterAll(async () => { unpinNow(); await closeDb(); });

async function fixture(admin = false) {
  const programme = await makeProgramme();
  const intake = await makeIntake(programme.id);
  const student = await makeStudent();
  const schedule = await makeEnrolment(student.id, intake.id, [{ amountMinor: 1_000_000, dueDate: "2026-11-01" }]);
  const scopes = admin ? [{ programmeId: programme.id }] : [];
  const account = await makeStaff(admin ? "ADMIN" : "SUPER_ADMIN", { scopes, capabilities: ["admissions.decide", "exemptions.manage"] });
  const p = principalOf(account, scopes);
  return { programme, intake, student, ...schedule, account, p };
}

async function submission(f: Awaited<ReturnType<typeof fixture>>) {
  const [asset] = await db().insert(receiptAssets).values({
    enrolmentId: f.enrolment.id, objectKey: `receipts/${randomUUID()}`, sha256: randomUUID(), mime: "image/png", sizeBytes: 100, validation: "CLEAN",
  }).returning();
  const [sub] = await db().insert(paymentSubmissions).values({
    enrolmentId: f.enrolment.id, targetInstalmentId: f.instalments[0].id, assetId: asset.id,
    claimedMinor: 400_000, transferDate: "2026-11-16", idempotencyKey: randomUUID(),
  }).returning();
  return sub;
}

async function authenticatedRequest(f: Awaited<ReturnType<typeof fixture>>, url: string, body: unknown, key?: string) {
  const { token, session } = await withTx(tx => createStaffSession(tx, f.account.id, f.account.authVersion));
  requestBoundary.token = token;
  return new NextRequest(`http://localhost${url}`, {
    method: "POST", headers: { cookie: `t2t_staff=${token}`, "x-csrf-token": session.csrfSecret,
      "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body),
  });
}

describe("payload-bound mutation retries", () => {
  it("creates exactly one admission, initial event and audit under concurrent retries without a raw NIC fingerprint", async () => {
    const f = await fixture();
    const key = randomUUID();
    const input = { intakeId: f.intake.id, applicantName: "Retry Applicant", nic: "991234567v" };
    const results = await Promise.all(Array.from({ length: 4 }, () => createAdmission(f.p, input, key)));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(await db().select().from(admissions)).toHaveLength(1);
    expect(await db().select().from(admissionEvents)).toHaveLength(1);
    expect(await db().select().from(auditEvents).where(eq(auditEvents.action, "admission.create"))).toHaveLength(1);
    expect((await createAdmission(f.p, { ...input, nic: " 991234567V " }, key)).id).toBe(results[0].id);
    await expect(createAdmission(f.p, { ...input, applicantName: "Changed Applicant" }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    const [record] = await db().select().from(idempotencyRecords);
    expect(record.requestHash).not.toBe(hashPayload({ ...admissionInput.parse(input), nic: "991234567V" }));
    expect(JSON.stringify(record)).not.toMatch(/991234567[vV]/);
  });

  it("rechecks current scope before replaying an admission result", async () => {
    const f = await fixture(true), key = randomUUID();
    const input = { intakeId: f.intake.id, applicantName: "Scoped Applicant" };
    await createAdmission(f.p, input, key);
    await db().delete(staffScopes).where(eq(staffScopes.staffId, f.account.id));
    await expect(createAdmission(f.p, input, key)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db().select().from(admissions)).toHaveLength(1);
  });

  it("replays non-acceptance decisions without duplicate history and rejects changed payloads or stale new requests", async () => {
    const f = await fixture(), key = randomUUID();
    const admission = await createAdmission(f.p, { intakeId: f.intake.id, applicantName: "Waiting Applicant" }, randomUUID());
    const input = { admissionId: admission.id, decision: "WAITLISTED" as const, reason: "Waiting for a place", expectedVersion: 1 };
    const results = await Promise.all([decideAdmission(f.p, input, key), decideAdmission(f.p, input, key)]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(await db().select().from(admissionEvents)).toHaveLength(2);
    await expect(decideAdmission(f.p, { ...input, reason: "Different reason" }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(decideAdmission(f.p, input, randomUUID())).rejects.toMatchObject({ code: "STALE" });
  });

  it("accepts concurrent retries into one student, enrolment and schedule", async () => {
    const f = await fixture(), key = randomUUID();
    await db().update(feePlanVersions).set({ isCurrent: true }).where(eq(feePlanVersions.id, f.enrolment.feePlanVersionId!));
    const admission = await createAdmission(f.p, { intakeId: f.intake.id, applicantName: "Accepted Applicant", nic: fakeNic() }, randomUUID());
    const input = { admissionId: admission.id, decision: "ACCEPTED" as const, expectedVersion: 1 };
    const results = await Promise.all([decideAdmission(f.p, input, key), decideAdmission(f.p, input, key)]);
    expect(results[0].enrolmentId).toBe(results[1].enrolmentId);
    expect(await db().select().from(students)).toHaveLength(2);
    expect(await db().select().from(enrolments)).toHaveLength(2);
    expect(await db().select().from(instalments)).toHaveLength(2);
    expect(await db().select().from(admissionEvents)).toHaveLength(2);
  });

  it("rechecks deactivation before replaying a successful admission decision", async () => {
    const f = await fixture(), key = randomUUID();
    const admission = await createAdmission(f.p, { intakeId: f.intake.id, applicantName: "Applicant" }, randomUUID());
    const input = { admissionId: admission.id, decision: "WAITLISTED" as const, expectedVersion: 1 };
    await decideAdmission(f.p, input, key);
    await db().update(staffAccounts).set({ status: "DEACTIVATED" }).where(eq(staffAccounts.id, f.account.id));
    await expect(decideAdmission(f.p, input, key)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it.each(["create", "decide"] as const)("rechecks Trash after %s waits on a locked intake", async action => {
    const f = await fixture();
    const admission = action === "decide"
      ? await createAdmission(f.p, { intakeId: f.intake.id, applicantName: "Existing Applicant" }, randomUUID()) : null;
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = withTx(async tx => {
      await tx.select().from(intakes).where(eq(intakes.id, f.intake.id)).for("update");
      ready(); await gate;
      await tx.update(intakes).set({ trashedAt: new Date() }).where(eq(intakes.id, f.intake.id));
    });
    await locked;
    const pending = (action === "create"
      ? createAdmission(f.p, { intakeId: f.intake.id, applicantName: "Blocked Applicant" }, randomUUID())
      : decideAdmission(f.p, { admissionId: admission!.id, decision: "WAITLISTED", expectedVersion: 1 }, randomUUID()))
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await vi.waitFor(async () => {
        const [result] = await db().execute<{ blocked: boolean }>(sql`select exists (
          select 1 from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and query like '%intakes%'
        ) as blocked`);
        expect(result.blocked).toBe(true);
      }, { timeout: 5000, interval: 20 });
    } finally { release(); await holding; }
    expect((await pending).error).toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(admissions)).toHaveLength(action === "create" ? 0 : 1);
    if (admission) expect((await db().select().from(admissions))[0].state).toBe("UNDER_REVIEW");
  });

  it("revokes an exemption once despite concurrent response retries", async () => {
    const f = await fixture(), key = randomUUID();
    const award = await grantExemption(f.p, { enrolmentId: f.enrolment.id, type: "FREE_CARD", basis: "PERCENT", value: 10000,
      reason: "Synthetic award", effectiveFrom: "2026-01-01", instalmentIds: [f.instalments[0].id], expectedEnrolmentVersion: 1 }, randomUUID());
    const input = { awardId: award.awardId, reason: "Award was entered in error", expectedEnrolmentVersion: 2 };
    const results = await Promise.all([revokeExemption(f.p, input, key), revokeExemption(f.p, input, key)]);
    expect(results[0]).toEqual(results[1]);
    expect((await loadLedger(db(), f.enrolment.id)).summary).toMatchObject({ netObligationMinor: 1_000_000, collectedMinor: 0 });
    expect((await db().select().from(enrolments))[0].version).toBe(3);
    expect((await db().select().from(exemptionAwards))[0].status).toBe("REVOKED");
    expect(await db().select().from(auditEvents).where(eq(auditEvents.action, "exemption.revoke"))).toHaveLength(1);
    await expect(revokeExemption(f.p, { ...input, reason: "Different reason" }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await db().update(staffAccounts).set({ status: "DEACTIVATED" }).where(eq(staffAccounts.id, f.account.id));
    await expect(revokeExemption(f.p, input, key)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it.each(["undo", "correct"] as const)("retries %s once without duplicate reversals, notifications or decisions", async action => {
    const f = await fixture(), key = randomUUID();
    const sub = await submission(f);
    const approved = await approveSubmission(f.p, { submissionId: sub.id, expectedVersion: 1, spillOver: false }, randomUUID());
    const input = action === "undo" ? { submissionId: sub.id, actionId: approved.actionId }
      : { submissionId: sub.id, expectedVersion: 2, reason: "Incorrect receipt approval" };
    const perform = (payload: { submissionId: string; actionId?: string; expectedVersion?: number; reason?: string } = input) => action === "undo"
      ? undoDecision(f.p, payload as { submissionId: string; actionId: string }, key)
      : correctApproval(f.p, payload as { submissionId: string; expectedVersion: number; reason: string }, key);
    const results = await Promise.all([perform(), perform()]);
    expect(results[0]).toEqual(results[1]);
    if (action === "undo") {
      pinNow(new Date(Date.now() + 120_000).toISOString());
      expect(await perform()).toEqual(results[0]);
    }
    expect(await db().select().from(paymentEvents).where(eq(paymentEvents.kind, "REVERSAL"))).toHaveLength(1);
    expect(await db().select().from(reviewActions)).toHaveLength(2);
    expect(await db().select().from(notifications)).toHaveLength(2);
    expect(await db().select().from(outboxEvents)).toHaveLength(2);
    expect((await loadLedger(db(), f.enrolment.id)).summary).toMatchObject({ collectedMinor: 0, approvedAllocatedMinor: 0, creditMinor: 0, outstandingMinor: 1_000_000 });
    const changed = action === "undo" ? { ...input, actionId: randomUUID() } : { ...input, reason: "Different correction reason" };
    await expect(perform(changed)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await db().update(staffAccounts).set({ status: "DEACTIVATED" }).where(eq(staffAccounts.id, f.account.id));
    await expect(perform()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it.each(["create", "decide", "revoke", "undo", "correct", "enrolment-correct"])("requires an idempotency header on the %s HTTP mutation", async action => {
    const f = await fixture();
    let response: Response;
    if (action === "create") {
      response = await createRoute(await authenticatedRequest(f, "/api/staff/admissions", { intakeId: f.intake.id, applicantName: "HTTP Applicant" }), { params: Promise.resolve({}) });
      expect(await db().select().from(admissions)).toHaveLength(0);
    } else if (action === "decide") {
      const admission = await createAdmission(f.p, { intakeId: f.intake.id, applicantName: "HTTP Applicant" }, randomUUID());
      response = await decideRoute(await authenticatedRequest(f, `/api/staff/admissions/${admission.id}`, { decision: "WAITLISTED", expectedVersion: 1 }), { params: Promise.resolve({ id: admission.id }) });
      expect((await db().select().from(admissions))[0].state).toBe("UNDER_REVIEW");
    } else if (action === "revoke") {
      const award = await grantExemption(f.p, { enrolmentId: f.enrolment.id, type: "FREE_CARD", basis: "PERCENT", value: 10000,
        reason: "Synthetic award", effectiveFrom: "2026-01-01", instalmentIds: [f.instalments[0].id], expectedEnrolmentVersion: 1 }, randomUUID());
      response = await enrolmentRoute(await authenticatedRequest(f, `/api/staff/enrolments/${f.enrolment.id}/revoke-exemption`, { awardId: award.awardId, reason: "HTTP revoke", expectedEnrolmentVersion: 2 }), { params: Promise.resolve({ id: f.enrolment.id, action: "revoke-exemption" }) });
      expect((await db().select().from(exemptionAwards))[0].status).toBe("ACTIVE");
    } else {
      const sub = await submission(f);
      const approved = await approveSubmission(f.p, { submissionId: sub.id, expectedVersion: 1, spillOver: false }, randomUUID());
      if (action === "enrolment-correct") {
        response = await enrolmentRoute(await authenticatedRequest(f, `/api/staff/enrolments/${f.enrolment.id}/correction`, { submissionId: sub.id, expectedVersion: 2, reason: "HTTP correction" }), { params: Promise.resolve({ id: f.enrolment.id, action: "correction" }) });
      } else {
        const body = action === "undo" ? { actionId: approved.actionId } : { expectedVersion: 2, reason: "HTTP correction" };
        response = await reviewRoute(await authenticatedRequest(f, `/api/staff/review/${sub.id}/${action}`, body), { params: Promise.resolve({ id: sub.id, action }) });
      }
      expect(await db().select().from(paymentEvents).where(eq(paymentEvents.kind, "REVERSAL"))).toHaveLength(0);
    }
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION", message: "Idempotency-Key header is required." } });
  });
});
