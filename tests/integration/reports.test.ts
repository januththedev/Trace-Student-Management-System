import { beforeEach, afterAll, describe, expect, it } from "vitest";
import {
  admissions, chargeAdjustments, exemptionApplications, exemptionAwards, followUpTasks, paymentAllocations, paymentEvents,
  paymentPromises, paymentSubmissions,
} from "@/db/schema";
import { db } from "@/db/client";
import {
  closeDb, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent,
  pinNow, principalOf, resetDb, unpinNow,
} from "./helpers";
import { getCommandCentreMetrics, getMetricDrillDown, type CommandMetricKey } from "@/server/services/reports/metrics";
import { collectionRateReport, receiptsByApprovalDate, receiptsByTransferDate, outstandingAgeing } from "@/server/services/reports/reports";
import { loadLedgers } from "@/server/services/ledger";
import { balanceMetrics, loadBalanceInstalments, loadBalanceSummaries } from "@/server/services/reports/balances";

const AS_OF = "2026-06-15";

describe("SQL ledger equivalence", () => {
  it("matches every ledger field for partial payments, credit, exemptions, cancellation and reversals", async () => {
    const p = await superAdmin();
    const programme = await makeProgramme();
    const intake = await makeIntake(programme.id);
    const s = await makeStudent();
    const e = await makeEnrolment(s.id, intake.id, [
      { amountMinor: 100_000, dueDate: "2026-06-01" },
      { amountMinor: 100_000, dueDate: AS_OF },
      { amountMinor: 100_000, dueDate: "2026-12-01" },
      { amountMinor: 100_000, dueDate: "2026-12-02" },
    ]);
    const empty = await makeEnrolment((await makeStudent()).id, intake.id, []);
    await addReceipt(e.enrolment.id, e.instalments[0].id, 100_000, { allocation: 40_000 });
    const reversedId = await addReceipt(e.enrolment.id, null, 50_000);
    await db().insert(paymentAllocations).values({ enrolmentId: e.enrolment.id, instalmentId: e.instalments[1].id,
      paymentEventId: reversedId, amountMinor: 30_000, source: "SUBMISSION", reversedAt: new Date() });
    await db().insert(paymentEvents).values({ enrolmentId: e.enrolment.id, kind: "REVERSAL", amountMinor: 50_000,
      reversesEventId: reversedId, effectiveDate: AS_OF });
    await db().insert(chargeAdjustments).values([
      { enrolmentId: e.enrolment.id, instalmentId: e.instalments[0].id, amountMinor: 1000, kind: "MANUAL", reason: "Correction", effectiveDate: AS_OF },
      { enrolmentId: e.enrolment.id, instalmentId: e.instalments[0].id, amountMinor: -500, kind: "FEE_CHANGE", reason: "Reduction", effectiveDate: AS_OF },
      { enrolmentId: e.enrolment.id, instalmentId: e.instalments[3].id, amountMinor: -100_000, kind: "WITHDRAWAL_CANCEL", reason: "Cancellation", effectiveDate: AS_OF },
    ]);
    const [award] = await db().insert(exemptionAwards).values({ enrolmentId: e.enrolment.id, type: "SPONSORSHIP", basis: "FIXED",
      value: 20_000, reason: "Sponsor", approverId: p.id, effectiveFrom: AS_OF }).returning();
    await db().insert(exemptionApplications).values([
      { awardId: award.id, enrolmentId: e.enrolment.id, instalmentId: e.instalments[1].id, amountMinor: 20_000 },
      { awardId: award.id, enrolmentId: e.enrolment.id, instalmentId: e.instalments[1].id, amountMinor: 5000, reversedAt: new Date() },
    ]);
    await db().insert(paymentSubmissions).values({ enrolmentId: e.enrolment.id, targetInstalmentId: e.instalments[0].id,
      claimedMinor: 2500, transferDate: AS_OF, idempotencyKey: "mixed-pending" });
    const ids = [e.enrolment.id, empty.enrolment.id];
    const expected = await loadLedgers(db(), ids, { today: AS_OF });
    const actual = await loadBalanceSummaries(db(), p, AS_OF);
    const details = await loadBalanceInstalments(db(), p, AS_OF);
    for (const id of ids) {
      expect(actual.get(id)).toEqual(expected.get(id)!.summary);
      expect(details.get(id) ?? []).toEqual(expected.get(id)!.instalments);
    }
    const aggregate = await balanceMetrics(db(), p, AS_OF);
    expect(aggregate.summary).toEqual(expected.get(e.enrolment.id)!.summary);
    expect(aggregate.summary).toMatchObject({ creditMinor: 60_000, outstandingMinor: 240_500, dueNowMinor: 140_500, overdueMinor: 60_500 });
    expect(aggregate.activeEnrolments).toBe(2);
    const metrics = await getCommandCentreMetrics(db(), p, { asOf: AS_OF });
    for (const key of ["outstanding", "dueNow", "overdue"] as const) {
      expect((await getMetricDrillDown(db(), p, key, { asOf: AS_OF })).totalMinor).toBe(metrics[`${key}Minor`]);
    }
  });
});

beforeEach(async () => {
  await resetDb();
  pinNow(`${AS_OF}T12:00:00+05:30`);
});

afterAll(async () => {
  unpinNow();
  await closeDb();
});

async function superAdmin() {
  const a = await makeStaff("SUPER_ADMIN");
  return principalOf(a);
}

async function addReceipt(
  enrolmentId: string,
  instalmentId: string | null,
  amountMinor: number,
  opts: { createdAt?: Date; effectiveDate?: string; allocation?: number } = {},
) {
  const [ev] = await db().insert(paymentEvents).values({
    enrolmentId,
    kind: "RECEIPT",
    amountMinor,
    effectiveDate: opts.effectiveDate ?? AS_OF,
    createdAt: opts.createdAt ?? new Date(`${AS_OF}T04:00:00Z`),
  }).returning({ id: paymentEvents.id });
  if (instalmentId && opts.allocation) {
    await db().insert(paymentAllocations).values({
      enrolmentId, instalmentId, paymentEventId: ev.id, amountMinor: opts.allocation, source: "SUBMISSION",
    });
  }
  return ev.id;
}

async function baseFixture() {
  const programme = await makeProgramme({ code: "PA", name: "Programme A" });
  const intake = await makeIntake(programme.id, { code: "IA", label: "Intake A" });
  const s1 = await makeStudent({ fullName: "Alice Perera" });
  const s2 = await makeStudent({ fullName: "Bob Silva" });
  const e1 = await makeEnrolment(s1.id, intake.id, [
    { amountMinor: 100_000, dueDate: "2026-06-01", label: "June" },
    { amountMinor: 100_000, dueDate: "2026-12-01", label: "December" },
  ]);
  const e2 = await makeEnrolment(s2.id, intake.id, [
    { amountMinor: 50_000, dueDate: "2026-06-10", label: "June" },
  ]);
  await addReceipt(e1.enrolment.id, e1.instalments[0].id, 40_000, { allocation: 40_000 });
  await addReceipt(e2.enrolment.id, e2.instalments[0].id, 20_000, { allocation: 20_000 });
  return { programme, intake, s1, s2, e1, e2 };
}

describe("command centre metrics", () => {
  it("totals equal filtered drill-downs", async () => {
    const p = await superAdmin();
    const { intake, s1, s2, e1, e2 } = await baseFixture();
    const staff = await makeStaff("SUPER_ADMIN");

    await db().insert(paymentSubmissions).values({
      enrolmentId: e1.enrolment.id, targetInstalmentId: e1.instalments[0].id,
      claimedMinor: 10_000, transferDate: "2026-06-02", idempotencyKey: "slip-pending-1", status: "PENDING_REVIEW",
    });
    await db().insert(paymentSubmissions).values({
      enrolmentId: e2.enrolment.id, targetInstalmentId: e2.instalments[0].id,
      claimedMinor: 5_000, transferDate: "2026-06-03", idempotencyKey: "slip-rejected-1", status: "REJECTED",
    });
    await db().insert(paymentPromises).values({
      enrolmentId: e1.enrolment.id, amountMinor: 50_000, promisedDate: AS_OF,
      targetInstalmentIds: [e1.instalments[0].id], baselineAllocatedMinor: 40_000, staffId: staff.id,
    });
    await db().insert(followUpTasks).values({
      enrolmentId: e1.enrolment.id, type: "COLLECTION_CALL", dueAt: new Date("2026-06-15T06:00:00Z"),
      dedupeKey: "CALL:E1:2026-06-15",
    });
    await db().insert(admissions).values({
      intakeId: intake.id, applicantName: "Carol Applicant", state: "UNDER_REVIEW",
    });
    await db().insert(exemptionAwards).values({
      enrolmentId: e1.enrolment.id, type: "SPONSORSHIP", basis: "FIXED", value: 1_000,
      reason: "Sponsor", approverId: staff.id, effectiveFrom: "2026-01-01",
    });

    const m = await getCommandCentreMetrics(db(), p, { asOf: AS_OF, periodFrom: "2026-01-01", periodTo: "2026-12-31" });

    expect(m.totalRegisteredStudents).toBe(2);
    expect(m.activeStudents).toBe(2);
    expect(m.activeEnrolments).toBe(2);
    expect(m.activeProgrammes).toBe(1);
    expect(m.freeSponsorStudents).toBe(1);
    expect(m.pendingSlips).toBe(1);
    expect(m.rejectedSlips).toBe(1);
    expect(m.studentsWithDues).toBe(2);
    expect(m.outstandingMinor).toBe(190_000);
    expect(m.dueNowMinor).toBe(90_000);
    expect(m.overdueMinor).toBe(90_000);
    expect(m.callsDueToday).toBe(1);
    expect(m.promisedPaymentsDue).toBe(1);
    expect(m.promisedPaymentsDueMinor).toBe(50_000);
    expect(m.admissionsAwaitingDecision).toBe(1);

    const drill = async (key: CommandMetricKey) => getMetricDrillDown(db(), p, key, { asOf: AS_OF, periodFrom: "2026-01-01", periodTo: "2026-12-31" });

    expect((await drill("totalRegisteredStudents")).count).toBe(m.totalRegisteredStudents);
    expect((await drill("activeStudents")).count).toBe(m.activeStudents);
    expect((await drill("activeEnrolments")).count).toBe(m.activeEnrolments);
    expect((await drill("activeProgrammes")).count).toBe(m.activeProgrammes);
    expect((await drill("freeSponsorStudents")).count).toBe(m.freeSponsorStudents);
    expect((await drill("pendingSlips")).count).toBe(m.pendingSlips);
    expect((await drill("rejectedSlips")).count).toBe(m.rejectedSlips);
    expect((await drill("studentsWithDues")).count).toBe(m.studentsWithDues);
    expect((await drill("callsDueToday")).count).toBe(m.callsDueToday);
    expect((await drill("promisedPaymentsDue")).count).toBe(m.promisedPaymentsDue);
    expect((await drill("promisedPaymentsDue")).totalMinor).toBe(m.promisedPaymentsDueMinor);
    expect((await drill("admissionsAwaitingDecision")).count).toBe(m.admissionsAwaitingDecision);

    const outstanding = await drill("outstanding");
    expect(outstanding.totalMinor).toBe(m.outstandingMinor);
    expect((outstanding.rows as { studentRef: string }[]).map((r) => r.studentRef).sort()).toEqual([s1.ref, s2.ref].sort());
    expect((await drill("dueNow")).totalMinor).toBe(m.dueNowMinor);
    expect((await drill("overdue")).totalMinor).toBe(m.overdueMinor);
  });

  it("scoped admins see only scoped data", async () => {
    const { programme, s1 } = await baseFixture();
    const otherProgramme = await makeProgramme({ code: "PB", name: "Programme B" });
    const otherIntake = await makeIntake(otherProgramme.id, { code: "IB", label: "Intake B" });
    const s3 = await makeStudent({ fullName: "Chris Other" });
    await makeEnrolment(s3.id, otherIntake.id, [{ amountMinor: 500_000, dueDate: "2026-01-01" }]);

    const adminRow = await makeStaff("ADMIN", { scopes: [{ programmeId: programme.id }] });
    const admin = principalOf(adminRow, [{ programmeId: programme.id }]);

    const m = await getCommandCentreMetrics(db(), admin, { asOf: AS_OF });
    expect(m.totalRegisteredStudents).toBe(2);
    expect(m.activeProgrammes).toBe(1);
    expect(m.outstandingMinor).toBe(190_000);

    const drill = await getMetricDrillDown(db(), admin, "totalRegisteredStudents", { asOf: AS_OF });
    expect(drill.rows.every((r) => "studentId" in r)).toBe(true);
    expect((drill.rows as { ref: string }[]).map((r) => r.ref)).not.toContain(s3.ref);
    expect((drill.rows as { ref: string }[]).map((r) => r.ref)).toContain(s1.ref);

    const dues = await getMetricDrillDown(db(), admin, "studentsWithDues", { asOf: AS_OF });
    expect(dues.rows.every((r) => "programmeId" in r && (r as { programmeId: string }).programmeId === programme.id)).toBe(true);
    expect(dues.count).toBe(2); // both Programme A students have a due-now balance
  });
});

describe("collection rate", () => {
  it("returns null / N/A for a zero denominator", async () => {
    const p = await superAdmin();
    const r = await collectionRateReport(db(), p, { asOf: AS_OF });
    expect(r.denominatorMinor).toBe(0);
    expect(r.rate).toBeNull();
    expect(r.display).toBe("N/A");
  });

  it("excludes advance payments from the due-through ratio", async () => {
    const p = await superAdmin();
    const programme = await makeProgramme({ code: "PC", name: "Programme C" });
    const intake = await makeIntake(programme.id, { code: "IC", label: "Intake C" });
    const s = await makeStudent();
    const e = await makeEnrolment(s.id, intake.id, [
      { amountMinor: 100_000, dueDate: "2026-06-01" },
      { amountMinor: 100_000, dueDate: "2026-12-01" },
    ]);
    const eventId = await addReceipt(e.enrolment.id, null, 200_000);
    await db().insert(paymentAllocations).values([
      { enrolmentId: e.enrolment.id, instalmentId: e.instalments[0].id, paymentEventId: eventId, amountMinor: 100_000, source: "SUBMISSION" },
      { enrolmentId: e.enrolment.id, instalmentId: e.instalments[1].id, paymentEventId: eventId, amountMinor: 100_000, source: "SUBMISSION" },
    ]);

    const r = await collectionRateReport(db(), p, { asOf: AS_OF });
    expect(r.denominatorMinor).toBe(100_000);
    expect(r.numeratorMinor).toBe(100_000);
    expect(r.rate).toBe(1);
    expect(r.display).toBe("100.00%");
    expect(r.settlement.outstandingMinor).toBe(0);
  });
});

describe("ageing", () => {
  it("buckets overdue remaining into 1-30 / 31-60 / 61-90 / 91+", async () => {
    const p = await superAdmin();
    const programme = await makeProgramme({ code: "PD", name: "Programme D" });
    const intake = await makeIntake(programme.id, { code: "ID", label: "Intake D" });
    const s = await makeStudent();
    await makeEnrolment(s.id, intake.id, [
      { amountMinor: 1_000, dueDate: "2026-06-05" },
      { amountMinor: 1_000, dueDate: "2026-05-01" },
      { amountMinor: 1_000, dueDate: "2026-03-27" },
      { amountMinor: 1_000, dueDate: "2026-02-15" },
    ]);

    const a = await outstandingAgeing(db(), p, { asOf: AS_OF });
    expect(a.totals.outstandingMinor).toBe(4_000);
    expect(a.totals.overdueMinor).toBe(4_000);
    expect(a.totals.buckets).toEqual({ "1-30": 1_000, "31-60": 1_000, "61-90": 1_000, "91+": 1_000 });
  });
});

describe("receipt reports", () => {
  it("separates gross approvals from corrections and labels the transfer-date view", async () => {
    const p = await superAdmin();
    const programme = await makeProgramme({ code: "PE", name: "Programme E" });
    const intake = await makeIntake(programme.id, { code: "IE", label: "Intake E" });
    const s = await makeStudent();
    const e = await makeEnrolment(s.id, intake.id, [{ amountMinor: 100_000, dueDate: "2026-06-01" }]);

    const receiptId = await addReceipt(e.enrolment.id, e.instalments[0].id, 40_000, {
      createdAt: new Date("2026-06-10T04:00:00Z"), effectiveDate: "2026-06-08", allocation: 20_000,
    });
    await db().insert(paymentEvents).values({
      enrolmentId: e.enrolment.id, kind: "REVERSAL", amountMinor: 10_000, reversesEventId: receiptId,
      effectiveDate: "2026-06-09", createdAt: new Date("2026-06-12T04:00:00Z"),
    });

    const approval = await receiptsByApprovalDate(db(), p, { from: "2026-06-01", to: "2026-06-30" });
    expect(approval.basis).toBe("APPROVAL_DATE");
    expect(approval.totals.receiptMinor).toBe(40_000);
    expect(approval.totals.correctionsMinor).toBe(10_000);
    expect(approval.totals.netMinor).toBe(30_000);
    expect(approval.rows.map((r) => r.date)).toEqual(["2026-06-10", "2026-06-12"]);

    const transfer = await receiptsByTransferDate(db(), p, { from: "2026-06-01", to: "2026-06-30" });
    expect(transfer.basis).toBe("TRANSFER_DATE");
    expect(transfer.basisLabel).toContain("transfer");
    expect(transfer.rows.map((r) => r.date)).toEqual(["2026-06-08", "2026-06-09"]);
    expect(transfer.totals.netMinor).toBe(30_000);
  });
});
