import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { closeDb, fakeNic, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";
import { db, withTx } from "@/db/client";
import { admissions, auditEvents, callAttempts, enrolments, exemptionAwards, exportJobs, followUpTasks, paymentEvents, paymentPromises, paymentSubmissions, programmes, receiptAssets, staffAccounts, staffScopes, students } from "@/db/schema";
import { CAPABILITIES, enrolmentInScope, type Capability } from "@/server/auth/policy";
import type { StudentPrincipal } from "@/server/auth/student";
import { createStaffSession, loadStaffPrincipal } from "@/server/auth/staff";
import { audit, redact } from "@/server/audit";
import { AppError, errorBody } from "@/server/http";
import { approveSubmission, claimLease, pendingQueue, queueFilters, rejectSubmission, releaseLease, reviewContext } from "@/server/services/review";
import { applyCredit, createAdmission, createFeePlanVersion, decideAdmission, enrolmentDetail, grantExemption, previewExemption, previewWithdrawal, revokeExemption, withdrawEnrolment } from "@/server/services/enrolments";
import { admissionDirectory, editStudent, listProgrammes, programmeDetail, saveProgramme, searchStudents, studentDetail } from "@/server/services/directory";
import { getCallCard, getCallQueue } from "@/server/services/followups/queue";
import { recordCallAttempt } from "@/server/services/followups/attempts";
import { closeTask, leaseTask } from "@/server/services/followups/tasks";
import { saveHoliday } from "@/server/services/followups/calendar";
import { COMMAND_METRIC_DEFINITIONS, getCommandCentreMetrics, getMetricDrillDown } from "@/server/services/reports/metrics";
import { EXPORT_REPORTS, exportReportCsv } from "@/server/services/reports/exports";
import { createExportJob, downloadExportJob, runExportJobs } from "@/server/services/reports/export-jobs";
import { assertReportScope, outstandingAgeing, programmeIntakeTotals } from "@/server/services/reports/reports";
import { importStudents as importStudentsService, STUDENT_IMPORT_HEADERS } from "@/server/services/imports/students-import";
import { assetBytes, finalizeSubmission } from "@/server/services/submissions";
import { listTeam } from "@/server/services/governance";
import { listTrash } from "@/server/services/trash";
import { objectStore } from "@/server/storage";
import { parseCsv, toCsv } from "@/lib/csv";

// Acceptance 10, 12, 22 (export injection). No application services are mocked.
const TODAY = "2026-11-16";
const AT = new Date("2026-11-16T04:30:00Z");
const writtenKeys: string[] = [];
const unexpectedImportErrors: unknown[] = [];
beforeEach(async () => { await resetDb(); pinNow(AT.toISOString()); });
afterEach(async () => {
  unpinNow(); for (const key of writtenKeys.splice(0)) await objectStore().delete(key);
});
afterAll(async () => {
  // A suite-level check stays outside each it.fails result, including its per-test hooks.
  try { expect(unexpectedImportErrors, "Import infrastructure must work before judging scope defects").toEqual([]); }
  finally { await closeDb(); }
});
async function importStudents(...args: Parameters<typeof importStudentsService>) {
  try { return await importStudentsService(...args); }
  catch (error) {
    if (!(error instanceof AppError) && !(error instanceof ZodError)) unexpectedImportErrors.push(error);
    throw error;
  }
}

async function fixture(caps: Capability[] = [...CAPABILITIES]) {
  const pa = await makeProgramme({ code: "VISIBLE_A", name: "Visible programme" });
  const pb = await makeProgramme({ code: "HIDDEN_B", name: "Hidden programme" });
  const ia = await makeIntake(pa.id, { code: "A_BATCH" });
  const ib = await makeIntake(pb.id, { code: "B_BATCH" });
  const shared = await makeStudent({ fullName: "Shared Person" });
  const hidden = await makeStudent({ fullName: "Hidden Only Person" });
  const a = await makeEnrolment(shared.id, ia.id, [{ amountMinor: 10000, dueDate: "2026-11-01" }, { amountMinor: 10000, dueDate: "2026-11-02" }]);
  const b = await makeEnrolment(shared.id, ib.id, [{ amountMinor: 900000, dueDate: "2026-11-01" }, { amountMinor: 800000, dueDate: "2026-11-02" }]);
  const hb = await makeEnrolment(hidden.id, ib.id, [{ amountMinor: 700000, dueDate: "2026-11-01" }]);
  const account = await makeStaff("ADMIN", { capabilities: caps, scopes: [{ programmeId: pa.id }] });
  const p = principalOf(account, [{ programmeId: pa.id }]);
  const superAccount = await makeStaff("SUPER_ADMIN");
  const superP = principalOf(superAccount);
  const submissions = [];
  for (const e of [a, b, hb]) {
    const [asset] = await db().insert(receiptAssets).values({ enrolmentId: e.enrolment.id, objectKey: `receipts/security/${randomUUID()}`, mime: "image/png", sha256: randomUUID(), sizeBytes: 12, validation: "CLEAN" }).returning();
    const [sub] = await db().insert(paymentSubmissions).values({ enrolmentId: e.enrolment.id, targetInstalmentId: e.instalments[0].id, assetId: asset.id, claimedMinor: 1000, transferDate: TODAY, idempotencyKey: randomUUID(), submittedAt: AT }).returning();
    submissions.push({ ...sub, asset });
  }
  return { pa, pb, ia, ib, shared, hidden, a, b, hb, account, p, superP, sa: submissions[0], sb: submissions[1], sh: submissions[2] };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const approve = (f: Fixture, id = f.sa.id, key = randomUUID()) => approveSubmission(f.p, { submissionId: id, expectedVersion: 1 }, key);
const award = (f: Fixture, e = f.a) => ({ enrolmentId: e.enrolment.id, type: "DISCOUNT" as const, basis: "FIXED" as const, value: 100, reason: "Scoped acceptance award", effectiveFrom: "2026-01-01", instalmentIds: [e.instalments[0].id], expectedEnrolmentVersion: 1 });
const withdrawal = (f: Fixture, e = f.a) => ({ enrolmentId: e.enrolment.id, expectedVersion: 1, effectiveDate: TODAY, reason: "Scoped withdrawal test" });
const credit = (f: Fixture, e = f.a) => ({ enrolmentId: e.enrolment.id, instalmentId: e.instalments[1]?.id ?? e.instalments[0].id, amountMinor: 100, reason: "Scoped credit test" });
const fee = (f: Fixture) => ({ intakeId: f.ia.id, notes: "Acceptance fee version", items: [{ periodLabel: "New", component: "TUITION", amountMinor: 1000, dueDate: TODAY }] });
function assertPrivate(f: Fixture, value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of [f.b.enrolment.id, f.hb.enrolment.id, f.hidden.id, f.hidden.ref, f.sb.id, f.sh.id, f.pb.id, f.ib.id, "HIDDEN_B", "Hidden Only Person", f.shared.nic, f.hidden.nic]) expect(serialized).not.toContain(secret);
}
async function hiddenAward(f: Fixture) {
  return (await db().insert(exemptionAwards).values({ enrolmentId: f.b.enrolment.id, type: "DISCOUNT", basis: "FIXED", value: 100, reason: "Hidden award", approverId: f.superP.id, effectiveFrom: TODAY }).returning())[0];
}
function importCsv(f: Fixture, nic = fakeNic(), intake = f.ia.code, programme = f.pa.code, ref = "") {
  return toCsv([...STUDENT_IMPORT_HEADERS], [[ref, "Import Test Person", nic, "", "", programme, intake, 1, "Opening", "10.00", TODAY]]);
}

describe("scope isolation across a multi-programme student (scenario 10)", () => {
  it("filters review queue and counts, denies hidden context and approval, and preserves B", async () => {
    const f = await fixture();
    const queue = await pendingQueue(db(), f.p, queueFilters.parse({}));
    expect(queue.items.map(x => x.id)).toEqual([f.sa.id]); expect(queue.totalPending).toBe(1); assertPrivate(f, queue);
    expect((await pendingQueue(db(), f.superP, queueFilters.parse({}))).totalPending).toBe(3);
    assertPrivate(f, await reviewContext(db(), f.p, f.sa.id));
    await expect(reviewContext(db(), f.p, f.sb.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(approve(f, f.sb.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db().select().from(paymentEvents)).toHaveLength(0);
    expect((await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.id, f.sb.id)))[0]).toMatchObject({ status: "PENDING_REVIEW", version: 1 });
  });

  it("filters call cards/history/tasks and rejects hidden attempts and task ids", async () => {
    const f = await fixture();
    const [task] = await db().insert(followUpTasks).values({ enrolmentId: f.b.enrolment.id, type: "COLLECTION_CALL", dueAt: AT, dedupeKey: randomUUID() }).returning();
    await db().insert(callAttempts).values({ enrolmentId: f.b.enrolment.id, operatorId: f.superP.id, clientAttemptId: randomUUID(), outcome: "NO_ANSWER", notes: "Hidden call note", balanceSnapshot: {} });
    const q = await getCallQueue(f.p); expect(q.items.map(x => x.id)).toEqual([f.a.enrolment.id]); assertPrivate(f, q);
    const card = await getCallCard(f.p, f.a.enrolment.id); assertPrivate(f, card); expect(card.contactHistory).toEqual([]);
    await expect(getCallCard(f.p, f.b.enrolment.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(recordCallAttempt(f.p, { enrolmentId: f.b.enrolment.id, expectedVersion: 1, clientAttemptId: randomUUID(), outcome: "NO_ANSWER" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(leaseTask(f.p, task.id, { expectedVersion: 1 }, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(closeTask(f.p, task.id, { expectedVersion: 1, reason: "Forbidden close" }, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db().select().from(callAttempts)).toHaveLength(1);
  });

  it("scopes directory name/NIC search, person detail, programme and admission lists", async () => {
    const f = await fixture();
    const results = await searchStudents(db(), f.p, { q: "Person" });
    expect(results.count).toBe(1); expect(results.rows[0].enrolments.map(e => e.id)).toEqual([f.a.enrolment.id]); assertPrivate(f, results);
    expect((await searchStudents(db(), f.p, { nic: f.hidden.nic })).count).toBe(0);
    expect((await searchStudents(db(), f.p, { q: f.hidden.ref })).rows).toEqual([]);
    assertPrivate(f, await studentDetail(db(), f.p, f.shared.id));
    await expect(studentDetail(db(), f.p, f.hidden.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    assertPrivate(f, await listProgrammes(db(), f.p)); assertPrivate(f, await programmeDetail(db(), f.p, f.pa.id));
    await expect(programmeDetail(db(), f.p, f.pb.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().insert(admissions).values([{ intakeId: f.ia.id, applicantName: "Visible applicant", state: "UNDER_REVIEW" }, { intakeId: f.ib.id, applicantName: "Hidden Only Person", state: "UNDER_REVIEW" }]);
    const directory = await admissionDirectory(db(), f.p); expect(directory.rows).toHaveLength(1); assertPrivate(f, directory);
  });

  it("limits an intake-only grant even inside a visible programme", async () => {
    const f = await fixture(); const sibling = await makeIntake(f.pa.id);
    const e = await makeEnrolment(f.shared.id, sibling.id, [{ amountMinor: 300, dueDate: TODAY }]);
    const account = await makeStaff("ADMIN", { scopes: [{ programmeId: f.pa.id, intakeId: f.ia.id }] });
    const p = principalOf(account, [{ programmeId: f.pa.id, intakeId: f.ia.id }]);
    expect((await studentDetail(db(), p, f.shared.id)).enrolments.map(x => x.id)).toEqual([f.a.enrolment.id]);
    expect((await programmeDetail(db(), p, f.pa.id)).intakes.map(x => x.id)).toEqual([f.ia.id]);
    await expect(enrolmentDetail(db(), p, e.enrolment.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("denies hidden enrolment, exemption, withdrawal and credit reads/writes", async () => {
    const f = await fixture(); const aw = await hiddenAward(f);
    await expect(enrolmentDetail(db(), f.p, f.b.enrolment.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(previewExemption(db(), f.p, award(f, f.b))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(grantExemption(f.p, award(f, f.b), randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(revokeExemption(f.p, { awardId: aw.id, reason: "Denied revocation" }, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(previewWithdrawal(db(), f.p, f.b.enrolment.id, TODAY)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(withdrawEnrolment(f.p, withdrawal(f, f.b), randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(applyCredit(f.p, credit(f, f.b), randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(applyCredit(f.p, { ...credit(f), instalmentId: f.b.instalments[0].id }, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await db().select().from(enrolments).where(eq(enrolments.id, f.b.enrolment.id)))[0]).toMatchObject({ status: "ACTIVE", version: 1 });
  });

  it.each(["preview", "original"] as const)("rechecks evidence scope before serving %s bytes", async variant => {
    const f = await fixture();
    const allow = async (id: string) => { await enrolmentInScope(db(), f.p, id); return true; };
    const bytes = Buffer.from("synthetic private evidence"); writtenKeys.push(f.sa.asset.objectKey);
    await objectStore().put(f.sa.asset.objectKey, bytes, "image/png");
    expect((await assetBytes(db(), f.sa.id, variant, allow)).bytes).toEqual(bytes);
    await expect(assetBytes(db(), f.sb.id, variant, allow)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assetBytes(db(), f.sa.id, variant, () => false)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("excludes B from all metrics and drill-downs with populated private counters", async () => {
    const f = await fixture();
    for (const [e, intake] of [[f.a, f.ia], [f.b, f.ib]] as const) {
      await db().insert(admissions).values({ intakeId: intake.id, applicantName: "Applicant", state: "UNDER_REVIEW" });
      await db().insert(followUpTasks).values({ enrolmentId: e.enrolment.id, type: "COLLECTION_CALL", dueAt: AT, dedupeKey: randomUUID() });
      await db().insert(callAttempts).values({ enrolmentId: e.enrolment.id, operatorId: f.superP.id, clientAttemptId: randomUUID(), outcome: "NO_ANSWER", balanceSnapshot: {}, createdAt: AT });
      await db().insert(paymentPromises).values({ enrolmentId: e.enrolment.id, staffId: f.superP.id, amountMinor: 1000, promisedDate: TODAY, targetInstalmentIds: [e.instalments[0].id], baselineAllocatedMinor: 0 });
      await db().insert(exemptionAwards).values({ enrolmentId: e.enrolment.id, type: "SPONSORSHIP", basis: "FIXED", value: 100, reason: "Scoped sponsor", approverId: f.superP.id, effectiveFrom: TODAY });
    }
    const m = await getCommandCentreMetrics(db(), f.p);
    expect(m).toMatchObject({ totalRegisteredStudents: 1, activeStudents: 1, activeEnrolments: 1, activeProgrammes: 1, freeSponsorStudents: 1, pendingSlips: 1, studentsWithDues: 1, outstandingMinor: 20000, dueNowMinor: 20000, overdueMinor: 20000, callsDueToday: 1, unansweredFollowUps: 1, promisedPaymentsDue: 1, promisedPaymentsDueMinor: 1000, admissionsAwaitingDecision: 1 });
    const all = await getCommandCentreMetrics(db(), f.superP); expect(all.activeEnrolments).toBe(3); expect(all.outstandingMinor).toBe(2420000);
    for (const def of COMMAND_METRIC_DEFINITIONS) {
      const drill = await getMetricDrillDown(db(), f.p, def.key); assertPrivate(f, drill);
      const value = def.key === "outstanding" ? m.outstandingMinor : def.key === "dueNow" ? m.dueNowMinor : def.key === "overdue" ? m.overdueMinor : m[def.key];
      expect(def.unit === "money" ? drill.totalMinor : drill.count).toBe(value);
    }
    expect((await outstandingAgeing(db(), f.p)).totals.outstandingMinor).toBe(20000);
    expect((await programmeIntakeTotals(db(), f.p))[0]).toMatchObject({ groupId: f.pa.id, enrolmentCount: 1, outstandingMinor: 20000 });
    await expect(assertReportScope(db(), f.p, f.b.enrolment.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(EXPORT_REPORTS)("keeps %s CSV scoped and masks NICs", async report => {
    const f = await fixture();
    if (report === "exemptions") {
      await grantExemption(f.p, award(f), randomUUID());
      await grantExemption(f.superP, award(f, f.b), randomUUID());
    }
    if (report === "follow-up-outcomes") {
      for (const e of [f.a, f.b]) await db().insert(callAttempts).values({ enrolmentId: e.enrolment.id, operatorId: f.superP.id, clientAttemptId: randomUUID(), outcome: "NO_ANSWER", balanceSnapshot: {}, createdAt: AT });
    }
    // Populate receipts/allocations/throughput and credit on both scopes, not just empty reports.
    await approve(f);
    await approveSubmission(f.superP, { submissionId: f.sb.id, expectedVersion: 1 }, randomUUID());
    await db().insert(paymentEvents).values([{ enrolmentId: f.a.enrolment.id, kind: "RECEIPT", amountMinor: 500, effectiveDate: TODAY }, { enrolmentId: f.b.enrolment.id, kind: "RECEIPT", amountMinor: 500, effectiveDate: TODAY }]);
    const result = await exportReportCsv(db(), f.p, { report, from: "2020-01-01", to: "2030-01-01" }); assertPrivate(f, result);
    expect(result.fullIdentifiers).toBe(false);
    const data = parseCsv(result.csv).filter(row => !row[0]?.startsWith("#"));
    const headers = data[0]; const first = Object.fromEntries(headers.map((key, i) => [key, data[1]?.[i]]));
    expect(result.rowCount).toBeGreaterThan(0);
    if (report === "receipts" || report === "transfer-receipts") {
      const sum = (column: string) => data.slice(1).reduce((n, row) => n + Number(row[headers.indexOf(column)]), 0);
      expect(sum("receipt_count")).toBe(2); expect(sum("receipts_minor")).toBe(1500);
    }
    if (report === "follow-up-outcomes") expect(first).toMatchObject({ outcome: "NO_ANSWER", count: "1" });
    if (report === "exemptions") expect(result.rowCount).toBe(1);
    expect((await db().select().from(auditEvents).where(eq(auditEvents.action, "export.download")))).toHaveLength(1);
  });
  it("keeps background exports private to their owner and invalidates downloads after scope revocation", async () => {
    const f = await fixture(); const job = await createExportJob(f.p, { report: "students" }, randomUUID());
    const key = `exports/${job.id}.csv`; writtenKeys.push(key);
    expect((await runExportJobs()).processed).toBe(1);
    const response = await downloadExportJob(f.p, job.id);
    expect(response.headers.get("cache-control")).toContain("no-store"); assertPrivate(f, await response.text());
    const other = await makeStaff("ADMIN", { capabilities: ["exports.download"], scopes: [{ programmeId: f.pa.id }] });
    await expect(downloadExportJob(principalOf(other, [{ programmeId: f.pa.id }]), job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().delete(staffScopes).where(eq(staffScopes.staffId, f.account.id));
    await expect(downloadExportJob(f.p, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rechecks export worker authority after job creation", async () => {
    const f = await fixture(); const job = await createExportJob(f.p, { report: "students" }, randomUUID());
    writtenKeys.push(`exports/${job.id}.csv`);
    await db().update(staffAccounts).set({ status: "DEACTIVATED", authVersion: 2 }).where(eq(staffAccounts.id, f.account.id));
    expect((await runExportJobs()).failed).toBe(1);
    expect((await db().select().from(exportJobs).where(eq(exportJobs.id, job.id)))[0].status).toBe("FAILED");
    expect(await objectStore().exists(`exports/${job.id}.csv`)).toBe(false);
    await expect(downloadExportJob(f.p, job.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("deny-by-default capabilities and live sessions (scenario 12)", () => {
  it.each(["fees.adjust", "exemptions.manage", "withdrawals.manage", "exports.download", "admissions.decide", "programme.manage", "programme.create", "imports.run"] as const)("requires %s", async cap => {
    const f = await fixture([]);
    const action: Record<Capability, () => Promise<unknown>> = {
      "fees.adjust": () => applyCredit(f.p, credit(f), randomUUID()),
      "exemptions.manage": () => grantExemption(f.p, award(f), randomUUID()),
      "withdrawals.manage": () => withdrawEnrolment(f.p, withdrawal(f), randomUUID()),
      "exports.download": () => exportReportCsv(db(), f.p, { report: "students" }),
      "admissions.decide": () => decideAdmission(f.p, { admissionId: randomUUID(), decision: "WAITLISTED", expectedVersion: 1, confirmExistingStudent: false }, randomUUID()),
      "programme.manage": () => saveProgramme(f.p, { id: f.pa.id, expectedVersion: 1, code: f.pa.code, name: "Changed programme", status: "ACTIVE", isPublic: true }, randomUUID()),
      "programme.create": () => saveProgramme(f.p, { code: "NEW", name: "New programme", status: "ACTIVE", isPublic: true }, randomUUID()),
      "imports.run": () => importStudents(f.p, importCsv(f), { batchKey: randomUUID(), dryRun: true }),
    };
    await expect(action[cap]()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("keeps governance, Trash, full identifiers, NIC corrections and holidays Super Admin-only", async () => {
    const f = await fixture();
    await expect(listTeam(f.p)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listTrash(f.p)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(exportReportCsv(db(), f.p, { report: "students", fullIdentifiers: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(saveHoliday(f.p, { day: TODAY, label: "Denied holiday", expectedLabel: null }, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(editStudent(f.p, { studentId: f.shared.id, fullName: f.shared.fullName, phone: f.shared.phone, email: null, doNotCall: false, wrongNumber: false, expectedVersion: 1, nic: fakeNic(), reason: "Denied identity edit" }, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["DEACTIVATED", "AUTH_VERSION", "TRASHED"] as const)("rejects existing session after %s and never revives it on restore", async change => {
    const f = await fixture(); const issued = await createStaffSession(db(), f.account.id, 1);
    expect((await loadStaffPrincipal(issued.token))?.id).toBe(f.account.id);
    await db().update(staffAccounts).set(change === "DEACTIVATED" ? { status: "DEACTIVATED", authVersion: 2 } : change === "TRASHED" ? { trashedAt: AT, authVersion: 2 } : { authVersion: 2 }).where(eq(staffAccounts.id, f.account.id));
    expect(await loadStaffPrincipal(issued.token)).toBeNull();
    await db().update(staffAccounts).set({ status: "ACTIVE", trashedAt: null, authVersion: 3 }).where(eq(staffAccounts.id, f.account.id));
    expect(await loadStaffPrincipal(issued.token)).toBeNull();
  });
  it("loads current grants and invalidates sessions after scope version changes", async () => {
    const f = await fixture(); const issued = await createStaffSession(db(), f.account.id, 1);
    await db().delete(staffScopes).where(eq(staffScopes.staffId, f.account.id));
    expect((await loadStaffPrincipal(issued.token))?.scopes).toEqual([]);
    await db().update(staffAccounts).set({ authVersion: 2 }).where(eq(staffAccounts.id, f.account.id));
    expect(await loadStaffPrincipal(issued.token)).toBeNull();
    await expect(recordCallAttempt(f.p, { enrolmentId: f.a.enrolment.id, expectedVersion: 1, clientAttemptId: randomUUID(), outcome: "NO_ANSWER" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("CSV, privacy and known defects (see docs/security-review.md)", () => {
  it.each(["=1+1", "+SUM(1,2)", "-1+2", "@SUM(1,2)", "\t=1+1", "\r=1+1", '=HYPERLINK("https://invalid.test","click")'])("neutralizes exported user cell %j", async name => {
    const f = await fixture(); await db().update(students).set({ fullName: name }).where(eq(students.id, f.shared.id));
    const r = await exportReportCsv(db(), f.p, { report: "students" });
    const rows = parseCsv(r.csv); const header = rows.findIndex(row => row[0] === "student_ref");
    expect(rows[header + 1][2]).toBe(`'${name}`);
  });
  it("returns generic internal errors without stack traces or SQL details", () => {
    const r = errorBody(new Error("synthetic private query detail"), "security-request");
    expect(r.status).toBe(500); expect(JSON.stringify(r.body)).not.toMatch(/private query|stack|Error:/);
  });

  // F-01: financial/review services trust stale incoming principals inside their transactions.
  it.each(["approve", "reject", "lease", "exemption", "withdrawal", "credit", "admission", "fee-plan"] as const)("F-01 rejects revoked staff at the %s transaction boundary", async action => {
    const f = await fixture();
    await db().insert(paymentEvents).values({ enrolmentId: f.a.enrolment.id, kind: "RECEIPT", amountMinor: 500, effectiveDate: TODAY });
    await db().update(staffAccounts).set({ status: "DEACTIVATED", authVersion: 2 }).where(eq(staffAccounts.id, f.account.id));
    const actions = {
      approve: () => approve(f), reject: () => rejectSubmission(f.p, { submissionId: f.sa.id, expectedVersion: 1, reason: "Stale reviewer" }, randomUUID()),
      lease: () => claimLease(f.p, f.sa.id), exemption: () => grantExemption(f.p, award(f), randomUUID()),
      withdrawal: () => withdrawEnrolment(f.p, withdrawal(f), randomUUID()), credit: () => applyCredit(f.p, credit(f), randomUUID()),
      admission: () => createAdmission(f.p, { intakeId: f.ia.id, applicantName: "Stale applicant" }, randomUUID()),
      "fee-plan": () => createFeePlanVersion(f.p, fee(f)),
    };
    await expect(actions[action]()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  // F-01: authorization must precede even an idempotency-cache replay.
  it("F-01 denies approval replay after grants are revoked", async () => {
    const f = await fixture(); const key = randomUUID(); await approve(f, f.sa.id, key);
    await db().delete(staffScopes).where(eq(staffScopes.staffId, f.account.id));
    await expect(approve(f, f.sa.id, key)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  // F-02: global NIC lookup exposes a person who has only an invisible B enrolment.
  it("F-02 hides out-of-scope admission duplicate-person warnings", async () => {
    const f = await fixture();
    const a = await createAdmission(f.p, { intakeId: f.ia.id, applicantName: "Applicant", nic: f.hidden.nic }, randomUUID());
    await expect(decideAdmission(f.p, { admissionId: a.id, decision: "ACCEPTED", expectedVersion: 1, confirmExistingStudent: false }, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  // F-03: import validation distinguishes globally existing intakes and identities.
  it("F-03 makes hidden and missing intake import errors indistinguishable", async () => {
    const f = await fixture(); const nic = fakeNic();
    const hidden = await importStudents(f.p, importCsv(f, nic, f.ib.code, f.pb.code), { batchKey: randomUUID(), dryRun: true });
    const missing = await importStudents(f.p, importCsv(f, nic, "MISSING", "MISSING"), { batchKey: randomUUID(), dryRun: true });
    expect(hidden.errors).toEqual(missing.errors);
  });
  it.each(["NIC", "reference"] as const)("F-03 does not expose hidden %s collisions through import dry-run", async field => {
    const f = await fixture();
    const csv = field === "NIC" ? importCsv(f, f.hidden.nic) : importCsv(f, fakeNic(), f.ia.code, f.pa.code, f.hidden.ref);
    const r = await importStudents(f.p, csv, { batchKey: randomUUID(), dryRun: true });
    expect(r.errors.some(e => e.code === (field === "NIC" ? "NIC_ALREADY_REGISTERED" : "STUDENT_REF_EXISTS"))).toBe(false);
  });
  // F-04: imports have no authoritative staff/capability reload before committing.
  it("F-04 rejects an import commit after deactivation", async () => {
    const f = await fixture(); await db().update(staffAccounts).set({ status: "DEACTIVATED", authVersion: 2 }).where(eq(staffAccounts.id, f.account.id));
    await expect(importStudents(f.p, importCsv(f), { batchKey: randomUUID(), dryRun: false })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  // F-05: export authorization uses stale capabilities and scope supplied by the caller.
  it("F-05 rejects export after the account is deactivated", async () => {
    const f = await fixture(); await db().update(staffAccounts).set({ status: "DEACTIVATED", authVersion: 2 }).where(eq(staffAccounts.id, f.account.id));
    await expect(exportReportCsv(db(), f.p, { report: "students" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  // F-06: nested array entries are not recursively redacted by audit().
  it("F-06 redacts identifiers inside persisted audit arrays", async () => {
    const f = await fixture(); await withTx(tx => audit(tx, { actorType: "STAFF", actorId: f.p.id, action: "security.redaction", entityType: "test", after: { rows: [{ nic: f.hidden.nic }] } }));
    const rows = await db().select().from(auditEvents).where(eq(auditEvents.action, "security.redaction"));
    expect(JSON.stringify(rows)).not.toContain(f.hidden.nic);
    expect(redact({ nic: f.hidden.nic })).toEqual({ nic: "[redacted]" });
  });
  // F-07: releasing a lease never checks the enrolment scope or current staff state.
  it("F-07 rejects releasing a hidden submission lease after a scope change", async () => {
    const f = await fixture(); await db().update(paymentSubmissions).set({ leaseHolder: f.p.id, leaseExpiresAt: new Date(AT.getTime() + 60000) }).where(eq(paymentSubmissions.id, f.sb.id));
    await expect(releaseLease(f.p, f.sb.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  // F-08: parent programme Trash is not checked in admission acceptance / fee versions.
  it.each(["admission", "fee-plan"] as const)("F-08 suspends %s when its parent programme is trashed", async action => {
    const f = await fixture(); const a = await createAdmission(f.p, { intakeId: f.ia.id, applicantName: "Applicant", nic: fakeNic() }, randomUUID());
    await db().update(programmes).set({ trashedAt: AT }).where(eq(programmes.id, f.pa.id));
    await expect(action === "admission" ? decideAdmission(f.p, { admissionId: a.id, decision: "ACCEPTED", expectedVersion: 1, confirmExistingStudent: false }, randomUUID()) : createFeePlanVersion(f.p, fee(f))).rejects.toMatchObject({ code: "CONFLICT" });
  });
  // F-10: direct services must validate too; route-only parsing is insufficient for server callers.
  it.each(["admission", "revocation"] as const)("F-10 validates %s inputs inside the service", async action => {
    const f = await fixture();
    const granted = await grantExemption(f.p, award(f), randomUUID());
    await expect(action === "admission"
      ? createAdmission(f.p, { intakeId: f.ia.id, applicantName: "" }, randomUUID())
      : revokeExemption(f.p, { awardId: granted.awardId, reason: "" }, randomUUID())).rejects.toBeInstanceOf(ZodError);
  });
  // F-11: credit/revocation have no expected version contract and accept stale form state.
  it.each(["credit", "revocation"] as const)("F-11 rejects stale enrolment version for %s", async action => {
    const f = await fixture(); const granted = await grantExemption(f.p, award(f), randomUUID());
    await db().insert(paymentEvents).values({ enrolmentId: f.a.enrolment.id, kind: "RECEIPT", amountMinor: 500, effectiveDate: TODAY });
    const staleCredit = { ...credit(f), expectedEnrolmentVersion: 1 };
    const staleRevocation = { awardId: granted.awardId, reason: "Stale revoke request", expectedEnrolmentVersion: 1 };
    await expect(action === "credit" ? applyCredit(f.p, staleCredit, randomUUID()) : revokeExemption(f.p, staleRevocation, randomUUID())).rejects.toMatchObject({ code: "STALE" });
  });
  // F-12: replay lookup returns the old submission even when amount/target/payload changed.
  it("F-12 rejects changed student submission payload under an existing key", async () => {
    const f = await fixture();
    const student: StudentPrincipal = { kind: "student", sessionId: randomUUID(), csrfSecret: "synthetic", studentId: f.shared.id, enrolmentId: f.a.enrolment.id, intakeId: f.ia.id, programmeId: f.pa.id };
    const input = { intentId: randomUUID(), targetInstalmentId: f.a.instalments[0].id, claimedMinor: f.sa.claimedMinor + 1, transferDate: TODAY, bankReference: null, studentNote: null };
    await expect(finalizeSubmission(student, input, f.sa.idempotencyKey)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });
  // F-13: the loose shared UUID guard passes malformed IDs through to PostgreSQL.
  it("F-13 treats malformed guessed enrolment IDs as NOT_FOUND instead of an internal DB error", async () => {
    const f = await fixture();
    await expect(enrolmentDetail(db(), f.p, "-".repeat(36))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
