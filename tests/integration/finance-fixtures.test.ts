/** Spec §7 worked fixtures + §17 scenarios 6, 7, 8, 9 against real PostgreSQL. */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { resetDb, closeDb, makeProgramme, makeIntake, makeStudent, makeEnrolment, makeStaff, principalOf } from "./helpers";
import { db } from "@/db/client";
import { paymentSubmissions, receiptAssets, reviewActions, paymentEvents } from "@/db/schema";
import { loadLedger } from "@/server/services/ledger";
import { approveSubmission, rejectSubmission, undoDecision, correctApproval } from "@/server/services/review";
import { grantExemption, applyCredit, withdrawEnrolment } from "@/server/services/enrolments";

const L = (lkr: number) => lkr * 100;

async function setup(schedule = [{ amountMinor: L(10000), dueDate: "2026-12-01" }]) {
  const prog = await makeProgramme();
  const intake = await makeIntake(prog.id);
  const st = await makeStudent();
  const { enrolment, instalments } = await makeEnrolment(st.id, intake.id, schedule);
  const sa = await makeStaff("SUPER_ADMIN");
  return { prog, intake, st, enrolment, instalments, p: principalOf(sa) };
}

async function submit(enrolmentId: string, instalmentId: string, claimedMinor: number) {
  const [asset] = await db().insert(receiptAssets).values({
    enrolmentId, objectKey: `receipts/${enrolmentId}/${randomUUID()}`, sha256: randomUUID(), mime: "image/png", sizeBytes: 100, validation: "CLEAN",
  }).returning();
  const [s] = await db().insert(paymentSubmissions).values({
    enrolmentId, targetInstalmentId: instalmentId, assetId: asset.id, claimedMinor, transferDate: "2026-11-10", idempotencyKey: randomUUID(),
  }).returning();
  return s;
}

const approve = (p: ReturnType<typeof principalOf>, s: { id: string; version: number }, extra: Partial<Parameters<typeof approveSubmission>[1]> = {}) =>
  approveSubmission(p, { submissionId: s.id, expectedVersion: s.version, spillOver: false, ...extra }, randomUUID());

beforeEach(async () => { process.env.T2T_FAKE_NOW = "2026-11-15T06:00:00Z"; await resetDb(); });
afterAll(async () => { await closeDb(); });

describe("worked fixtures (spec §7)", () => {
  it("1-4: pending, partial approval, rejection, over-payment to credit", async () => {
    const { enrolment, instalments, p } = await setup();
    const i = instalments[0];

    // 1. pending claim contributes zero
    const s1 = await submit(enrolment.id, i.id, L(10000));
    let lg = await loadLedger(db(), enrolment.id);
    expect(lg.summary.collectedMinor).toBe(0);
    expect(lg.instalments[0].remainingMinor).toBe(L(10000));
    expect(lg.summary.pendingClaimedMinor).toBe(L(10000));

    // 2. approve 4,000 (confirmed differs from claim => reason required)
    await expect(approve(p, s1, { confirmedMinor: L(4000) })).rejects.toThrow(/reason/i);
    await approve(p, s1, { confirmedMinor: L(4000), amountChangeReason: "Slip shows 4,000" });
    lg = await loadLedger(db(), enrolment.id);
    expect(lg.summary.collectedMinor).toBe(L(4000));
    expect(lg.summary.approvedAllocatedMinor).toBe(L(4000));
    expect(lg.instalments[0].remainingMinor).toBe(L(6000));
    expect(lg.instalments[0].state).toBe("PARTIALLY_PAID");
    const [ev] = await db().select().from(paymentEvents).where(eq(paymentEvents.submissionId, s1.id));
    expect(ev.claimedMinor).toBe(L(10000)); // both values retained

    // 3. reject a further 6,000
    const s2 = await submit(enrolment.id, i.id, L(6000));
    await expect(rejectSubmission(p, { submissionId: s2.id, expectedVersion: 1, reason: "   " as string }, randomUUID())).rejects.toThrow();
    await rejectSubmission(p, { submissionId: s2.id, expectedVersion: 1, reason: "Unreadable" }, randomUUID());
    lg = await loadLedger(db(), enrolment.id);
    expect(lg.instalments[0].remainingMinor).toBe(L(6000));

    // 4. approve 7,000 against remaining 6,000
    const s3 = await submit(enrolment.id, i.id, L(7000));
    await approve(p, s3);
    lg = await loadLedger(db(), enrolment.id);
    expect(lg.instalments[0].allocatedMinor).toBe(L(10000));
    expect(lg.summary.creditMinor).toBe(L(1000));
    expect(lg.summary.collectedMinor).toBe(L(11000));
    expect(lg.instalments[0].state).toBe("PAID");
    expect(lg.summary.settled).toBe(true);
  });

  it("5: full waiver = zero obligation, zero cash", async () => {
    const { enrolment, instalments, p } = await setup();
    await grantExemption(p, { enrolmentId: enrolment.id, type: "FREE_CARD", basis: "PERCENT", value: 10000, reason: "Free card", effectiveFrom: "2026-01-01", instalmentIds: [instalments[0].id], expectedEnrolmentVersion: 1 }, randomUUID());
    const lg = await loadLedger(db(), enrolment.id);
    expect(lg.instalments[0].netObligationMinor).toBe(0);
    expect(lg.instalments[0].state).toBe("EXEMPT");
    expect(lg.summary.collectedMinor).toBe(0);
    expect(lg.summary.dueNowMinor).toBe(0);
  });

  it("6: waiver after allocation releases excess to credit", async () => {
    const { enrolment, instalments, p } = await setup();
    const s = await submit(enrolment.id, instalments[0].id, L(4000));
    await approve(p, s);
    await grantExemption(p, { enrolmentId: enrolment.id, type: "SPONSORSHIP", basis: "FIXED", value: L(8000), reason: "Sponsor", effectiveFrom: "2026-01-01", instalmentIds: [instalments[0].id], expectedEnrolmentVersion: 1 }, randomUUID());
    const lg = await loadLedger(db(), enrolment.id);
    expect(lg.instalments[0].netObligationMinor).toBe(L(2000));
    expect(lg.instalments[0].allocatedMinor).toBe(L(2000));
    expect(lg.summary.creditMinor).toBe(L(2000));
    expect(lg.summary.collectedMinor).toBe(L(4000));
  });

  it("7: undo reverses atomically; dependent credit use blocks quick undo; correction handles it", async () => {
    const { enrolment, instalments, p } = await setup([{ amountMinor: L(5000), dueDate: "2026-11-01" }, { amountMinor: L(5000), dueDate: "2026-12-01" }]);
    const s = await submit(enrolment.id, instalments[0].id, L(7000));
    const r = await approve(p, s);
    let lg = await loadLedger(db(), enrolment.id);
    expect(lg.summary.creditMinor).toBe(L(2000));

    // quick undo works while no dependents
    await undoDecision(p, { submissionId: s.id, actionId: r.actionId });
    lg = await loadLedger(db(), enrolment.id);
    expect(lg.summary.collectedMinor).toBe(0);
    expect(lg.summary.approvedAllocatedMinor).toBe(0);
    const actions = await db().select().from(reviewActions).where(eq(reviewActions.submissionId, s.id));
    expect(actions.map((a) => a.kind).sort()).toEqual(["APPROVE", "UNDO"]);

    // re-approve, then use credit elsewhere -> quick undo blocked
    const [cur] = await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.id, s.id));
    const r2 = await approve(p, cur);
    await applyCredit(p, { enrolmentId: enrolment.id, instalmentId: instalments[1].id, amountMinor: L(2000), reason: "Apply credit" }, randomUUID());
    lg = await loadLedger(db(), enrolment.id);
    expect(lg.summary.collectedMinor).toBe(L(7000)); // credit application is not new collection
    await expect(undoDecision(p, { submissionId: s.id, actionId: r2.actionId })).rejects.toThrow(/correction/i);

    const [cur2] = await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.id, s.id));
    await correctApproval(p, { submissionId: s.id, expectedVersion: cur2.version, reason: "Approved in error" });
    lg = await loadLedger(db(), enrolment.id);
    expect(lg.summary.collectedMinor).toBe(0);
    expect(lg.summary.approvedAllocatedMinor).toBe(0);
    expect(lg.summary.creditMinor).toBe(0);
  });
});

describe("concurrency and idempotency (scenarios 6, 7)", () => {
  it("double-click replay returns one result", async () => {
    const { enrolment, instalments, p } = await setup();
    const s = await submit(enrolment.id, instalments[0].id, L(3000));
    const key = randomUUID();
    const input = { submissionId: s.id, expectedVersion: 1, spillOver: false };
    const [a, b] = await Promise.all([approveSubmission(p, input, key), approveSubmission(p, input, key).catch((e) => e)]);
    const ok = [a, b].filter((x) => !(x instanceof Error));
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const evs = await db().select().from(paymentEvents).where(eq(paymentEvents.submissionId, s.id));
    expect(evs.length).toBe(1);
  });

  it("two reviewers approving concurrently -> one payment, one conflict", async () => {
    const { enrolment, instalments, p, prog } = await setup();
    const p2 = principalOf(await makeStaff("SUPER_ADMIN"));
    void prog;
    const s = await submit(enrolment.id, instalments[0].id, L(3000));
    const res = await Promise.allSettled([approve(p, s), approve(p2, s)]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason.code).toBe("STALE");
    const evs = await db().select().from(paymentEvents).where(eq(paymentEvents.submissionId, s.id));
    expect(evs.length).toBe(1);
  });
});

describe("withdrawal (scenario 16)", () => {
  it("keeps past dues and cash, cancels future, paid-future becomes credit", async () => {
    const { enrolment, instalments, p } = await setup([
      { amountMinor: L(5000), dueDate: "2026-10-01" }, { amountMinor: L(5000), dueDate: "2026-11-01" }, { amountMinor: L(5000), dueDate: "2026-12-01" },
    ]);
    const s = await submit(enrolment.id, instalments[2].id, L(5000)); // advance payment of the future instalment
    await approve(p, s);
    const r = await withdrawEnrolment(p, { enrolmentId: enrolment.id, effectiveDate: "2026-11-15", reason: "Moving abroad", expectedVersion: 1 }, randomUUID());
    const lg = await loadLedger(db(), enrolment.id);
    expect(r.cancelled).toBe(1);
    expect(lg.instalments[2].state).toBe("CANCELLED");
    expect(lg.summary.outstandingMinor).toBe(L(10000)); // past dues retained
    expect(lg.summary.creditMinor).toBe(L(5000));
    expect(lg.summary.collectedMinor).toBe(L(5000));
  });
});

describe("scope (scenario 10)", () => {
  it("admin outside scope gets NOT_FOUND on approve", async () => {
    const { enrolment, instalments } = await setup();
    const other = await makeProgramme();
    const admin = await makeStaff("ADMIN", { scopes: [{ programmeId: other.id }] });
    const s = await submit(enrolment.id, instalments[0].id, L(1000));
    await expect(approve(principalOf(admin, [{ programmeId: other.id }]), s)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
