/** Synthetic development fixtures. Run with --conditions=react-server --import tsx. */
import "dotenv/config";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db, closeDb, withTx } from "../src/db/client";
import { enrolments, intakes, programmes, staffAccounts, students } from "../src/db/schema";
import { isValidNicFormat } from "../src/lib/nic";
import { businessDate, now, addDays } from "../src/lib/time";
import { audit } from "../src/server/audit";
import type { StaffPrincipal } from "../src/server/auth/policy";
import type { StudentPrincipal } from "../src/server/auth/student";
import { bootstrapSuperAdmin, inviteStaff, acceptInvitation } from "../src/server/services/governance";
import { saveProgramme, saveIntake } from "../src/server/services/directory";
import { admissionInput, decisionInput, feePlanInput, createFeePlanVersion, createAdmission, decideAdmission, grantExemption, withdrawEnrolment, applyCredit } from "../src/server/services/enrolments";
import { approveSubmission, rejectSubmission } from "../src/server/services/review";
import { createUploadIntent, uploadToIntent, finalizeSubmission, submitInput } from "../src/server/services/submissions";
import { recordCallAttempt } from "../src/server/services/followups/attempts";
import { recomputePromises } from "../src/server/services/followups/promises";
import { mutateTrash } from "../src/server/services/trash";
import { loadLedger, loadLedgers } from "../src/server/services/ledger";

export function syntheticNic(index: number): string {
  const serial = String(index + 1).padStart(4, "0");
  const nic = index % 2 === 0 ? `99001${serial}V` : `1999001${String(index + 1).padStart(5, "0")}`;
  if (!isValidNicFormat(nic)) throw new Error("Invalid synthetic NIC fixture");
  return nic;
}

function principal(a: typeof staffAccounts.$inferSelect): StaffPrincipal {
  return { kind: "staff", id: a.id, name: a.name, email: a.email, role: a.role, capabilities: new Set(), scopes: [], authVersion: a.authVersion, sessionId: randomUUID(), csrfSecret: "seed-operator" };
}

async function main() {
  const { values } = parseArgs({ options: { reset: { type: "boolean", default: false } }, strict: true });
  if (process.env.NODE_ENV === "production") throw new Error("Development seed (including --reset) is forbidden in production.");
  const password = process.env.T2T_SEED_PASSWORD ?? "T2T-development-only!";
  if (password.length < 12) throw new Error("T2T_SEED_PASSWORD must contain at least 12 characters.");
  if (!process.env.T2T_SEED_PASSWORD) console.warn("WARNING: using development password T2T-development-only! Set T2T_SEED_PASSWORD to override.");
  const [{ count }] = await db().select({ count: sql<number>`count(*)::int` }).from(students);
  if (count && !values.reset) throw new Error("Database already has students. Use --reset only for disposable development data.");
  if (values.reset) {
    await withTx(async tx => {
      const tables = await tx.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public' and tablename <> 'governance_lock'`);
      if (tables.length) await tx.execute(sql.raw(`truncate ${tables.map(t => '"' + t.tablename.replaceAll('"', '""') + '"').join(",")} restart identity cascade`));
      await tx.execute(sql`update governance_lock set bootstrapped_at = null`);
    });
  }
  const originalClock = process.env.T2T_FAKE_NOW;
  // Fixture event dates are deliberate; no machine clock or application setting is changed.
  process.env.T2T_FAKE_NOW = "2026-11-15T04:30:00Z";
  try {
    const boot = await bootstrapSuperAdmin({ email: "superadmin@t2t.example.test", name: "Synthetic Super Admin", password });
    const [account] = await db().select().from(staffAccounts).where(eq(staffAccounts.id, boot.id));
    const superAdmin = principal(account);
    const courses = ["Software Engineering", "Business Management", "Graphic Design", "English Language"];
    const slugs = ["software-engineering", "business-management", "graphic-design", "english-language"];
    const batches: (typeof intakes.$inferSelect)[] = [];
    for (let c = 0; c < courses.length; c++) {
      const p = await saveProgramme(superAdmin, { code: `DEMO-${c + 1}`, name: courses[c], description: "SYNTHETIC development programme", bannerPath: `/banners/${slugs[c]}.webp`, status: "ACTIVE", isPublic: true }, `seed-programme-${c}`);
      // The programme editor currently has no logo field; seed-only metadata, audited in place.
      await withTx(async tx => {
        await tx.update(programmes).set({ logoPath: "/brand/t2t-logo.png", version: p.version + 1 }).where(eq(programmes.id, p.id));
        await audit(tx, { actorType: "SYSTEM", action: "seed.programme.logo", entityType: "programme", entityId: p.id, after: { logoPath: "/brand/t2t-logo.png" } });
      });
      for (let b = 0; b < (c === 0 ? 3 : 2); b++) {
        const intake = await saveIntake(superAdmin, { programmeId: p.id, code: `2026-${b + 1}`, label: `Demo ${b + 1} · Oct 2026`, startDate: "2026-10-01", endDate: "2027-03-31", status: "ACTIVE", isPublic: true }, `seed-intake-${c}-${b}`);
        batches.push(intake);
        await createFeePlanVersion(superAdmin, feePlanInput.parse({ intakeId: intake.id, notes: "Synthetic six-month LKR schedule", items: ["2026-10-05", "2026-11-05", "2026-12-05", "2027-01-05", "2027-02-05", "2027-03-05"].map(d => ({ periodLabel: d.slice(0, 7), dueDate: d, amountMinor: 1_000_000 })) }));
      }
    }
    const invitation = await inviteStaff(superAdmin, { email: "admin@t2t.example.test", name: "Synthetic Scoped Admin", role: "ADMIN", capabilities: ["exports.download", "exemptions.manage"], scopes: [{ programmeId: batches[0].programmeId, intakeId: null }] }, "seed-admin-invitation");
    await acceptInvitation({ token: invitation.token, password }, "seed-admin-acceptance");
    const names = ["Nimal", "Kamal", "Amali", "Saman", "Dilini", "Kasun", "Tharushi", "Ruwan", "Nadeesha", "Isuru"];
    const surnames = ["Perera", "Silva", "Fernando", "Jayasinghe", "Senanayake", "Wijesinghe"];
    const enrolled: { id: string; studentId: string; intake: typeof intakes.$inferSelect; nic: string }[] = [];
    // Keep the third software intake empty: it demonstrates safe Trash without masking a scenario.
    const liveBatches = batches.filter((_, i) => i !== 2);
    async function admit(index: number, intake: typeof intakes.$inferSelect, existing = false) {
      const a = await createAdmission(superAdmin, admissionInput.parse({ intakeId: intake.id, applicantName: `${names[index % 10]} ${surnames[Math.floor(index / 10) % 6]} (Demo)`, nic: syntheticNic(index), phone: `+94 77 000 ${String(index).padStart(4, "0")}`, email: `student${index + 1}@example.test`, notes: "SYNTHETIC fixture; never contact" }));
      const result = await decideAdmission(superAdmin, decisionInput.parse({ admissionId: a.id, decision: "ACCEPTED", expectedVersion: a.version, confirmExistingStudent: existing }));
      if (!result.enrolmentId) throw new Error("Admission failed to create enrolment");
      const [e] = await db().select().from(enrolments).where(eq(enrolments.id, result.enrolmentId));
      enrolled.push({ id: e.id, studentId: e.studentId, intake, nic: syntheticNic(index) });
    }
    for (let i = 0; i < 60; i++) await admit(i, liveBatches[i % liveBatches.length]);
    await admit(0, liveBatches[3], true); // One person, two distinct programmes.
    await createAdmission(superAdmin, admissionInput.parse({ intakeId: batches[0].id, applicantName: "Anuki Demo Applicant", nic: syntheticNic(80), phone: "+94 77 000 0080", email: "applicant@example.test", sponsorshipRequested: "Synthetic sponsorship awaiting decision" }));
    const fixtureBytes = await Promise.all([1, 2, 3].map(n => readFile(`fixtures/receipts/receipt-${n}.png`)));
    async function receipt(index: number, amount: number, mode: "approve" | "pending" | "reject" = "approve", supersedes?: string, targetSequence = 0) {
      const e = enrolled[index];
      const ledger = await loadLedger(db(), e.id);
      const p: StudentPrincipal = { kind: "student", studentId: e.studentId, enrolmentId: e.id, intakeId: e.intake.id, programmeId: e.intake.programmeId, sessionId: randomUUID(), csrfSecret: "synthetic-student" };
      const bytes = fixtureBytes[index % 3];
      const intent = await createUploadIntent(p, { mime: "image/png", sizeBytes: bytes.length });
      await uploadToIntent(p, intent.intentId, bytes);
      const key = `seed-receipt-${index}-${targetSequence}-${supersedes ?? mode}`;
      const result = await finalizeSubmission(p, submitInput.parse({ intentId: intent.intentId, targetInstalmentId: ledger.instalments[targetSequence].id, claimedMinor: amount, transferDate: "2026-11-10", bankReference: `SYNTHETIC-${index}-${targetSequence}`, studentNote: "Synthetic receipt fixture", supersedesSubmissionId: supersedes }), key);
      if (mode === "approve") await approveSubmission(superAdmin, { submissionId: result.submission.id, expectedVersion: result.submission.version, spillOver: true }, `${key}-approve`);
      if (mode === "reject") await rejectSubmission(superAdmin, { submissionId: result.submission.id, expectedVersion: result.submission.version, reason: "Synthetic rejection: provide a clearer receipt" }, `${key}-reject`);
      return result.submission.id;
    }
    await receipt(0, 6_000_000); // Fully paid plan.
    await receipt(1, 400_000); // Partially paid.
    await receipt(2, 1_000_000, "pending");
    const rejected = await receipt(3, 1_000_000, "reject");
    await receipt(3, 1_000_000, "pending", rejected);
    await receipt(4, 6_500_000); // LKR 5,000 unapplied credit.
    for (const [index, type, value] of [[5, "FREE_CARD", 10000], [6, "SPONSORSHIP", 5000]] as const) {
      const e = enrolled[index];
      const [row] = await db().select().from(enrolments).where(eq(enrolments.id, e.id));
      const ledger = await loadLedger(db(), e.id);
      await grantExemption(superAdmin, { enrolmentId: e.id, type, basis: "PERCENT", value, reason: "Synthetic demonstration award", sponsorName: type === "SPONSORSHIP" ? "Example Test Foundation" : undefined, effectiveFrom: "2026-10-01", effectiveTo: "2027-03-31", instalmentIds: ledger.instalments.map(i => i.id), expectedEnrolmentVersion: row.version }, `seed-award-${index}`);
    }
    await withdrawEnrolment(superAdmin, { enrolmentId: enrolled[7].id, effectiveDate: "2026-11-15", reason: "Synthetic withdrawal retaining arrears", expectedVersion: 1 }, "seed-withdrawal-7");
    // Partial target allocation leaves credit which is then deliberately applied through the service.
    const e8 = enrolled[8];
    const p8: StudentPrincipal = { kind: "student", studentId: e8.studentId, enrolmentId: e8.id, intakeId: e8.intake.id, programmeId: e8.intake.programmeId, sessionId: randomUUID(), csrfSecret: "seed" };
    const l8 = await loadLedger(db(), e8.id);
    const intent8 = await createUploadIntent(p8, { mime: "image/png", sizeBytes: fixtureBytes[0].length });
    await uploadToIntent(p8, intent8.intentId, fixtureBytes[0]);
    const s8 = await finalizeSubmission(p8, submitInput.parse({ intentId: intent8.intentId, targetInstalmentId: l8.instalments[0].id, claimedMinor: 1_500_000, transferDate: "2026-11-10" }), "seed-credit-source");
    await approveSubmission(superAdmin, { submissionId: s8.submission.id, expectedVersion: 1, spillOver: false }, "seed-credit-approve");
    await applyCredit(superAdmin, { enrolmentId: e8.id, instalmentId: l8.instalments[1].id, amountMinor: 500_000, reason: "Synthetic credit application" }, "seed-credit-apply");
    for (let index = 9; index < 19; index++) {
      const e = enrolled[index];
      const broken = index === 10;
      if (broken) process.env.T2T_FAKE_NOW = "2026-11-12T04:30:00Z";
      const [row] = await db().select().from(enrolments).where(eq(enrolments.id, e.id));
      const ledger = await loadLedger(db(), e.id);
      await recordCallAttempt(superAdmin, { enrolmentId: e.id, expectedVersion: row.version, clientAttemptId: `seed-call-${index}`, outcome: index < 11 ? "PROMISED_TO_PAY" : "NO_ANSWER", manualOverrideReason: "Synthetic operator seed during development", notes: "Synthetic call; no phone was dialled", ...(index < 11 ? { amountMinor: 500_000, promisedDate: broken ? "2026-11-13" : addDays(businessDate(), 2), targetInstalmentIds: [ledger.instalments[0].id] } : {}) }, `seed-call-${index}`);
      process.env.T2T_FAKE_NOW = "2026-11-15T04:30:00Z";
      await withTx(tx => recomputePromises(tx, e.id));
    }
    await mutateTrash(superAdmin, { kind: "intake", id: batches[2].id, version: batches[2].version, action: "trash", reason: "Synthetic recoverable intake" }, "seed-trash-intake");
    // Check every fixture ledger using the authoritative projection before declaring success.
    const ledgers = await loadLedgers(db(), enrolled.map(e => e.id));
    assert.equal(ledgers.size, 61, "Every enrolment must have a valid ledger");
    assert.equal(ledgers.get(enrolled[0].id)!.summary.outstandingMinor, 0, "Paid account");
    assert.equal(ledgers.get(enrolled[1].id)!.instalments[0].remainingMinor, 600_000, "Partial payment");
    assert.equal(ledgers.get(enrolled[2].id)!.summary.pendingClaimedMinor, 1_000_000, "Pending claim is separate");
    assert.equal(ledgers.get(enrolled[4].id)!.summary.creditMinor, 500_000, "Overpayment credit");
    assert.equal(ledgers.get(enrolled[5].id)!.summary.outstandingMinor, 0, "Free card eliminates obligations");
    assert.equal(ledgers.get(enrolled[5].id)!.summary.collectedMinor, 0, "Free card is not cash");
    assert.equal(ledgers.get(enrolled[6].id)!.summary.netObligationMinor, 3_000_000, "Half sponsorship");
    assert.equal(ledgers.get(enrolled[7].id)!.summary.outstandingMinor, 2_000_000, "Withdrawal retains October/November arrears");
    assert.equal(ledgers.get(enrolled[8].id)!.summary.creditMinor, 0, "Existing credit was applied");
    const [checks] = await db().execute<Record<string, number>>(sql`select
      (select count(*)::int from students) people,
      (select count(*)::int from instalments) instalments,
      (select count(*)::int from staff_accounts where status = 'ACTIVE' and role = 'SUPER_ADMIN') supers,
      (select count(*)::int from staff_scopes) scopes,
      (select count(*)::int from payment_promises where state = 'OPEN') open_promises,
      (select count(*)::int from payment_promises where state = 'BROKEN') broken_promises,
      (select count(*)::int from call_attempts where outcome = 'NO_ANSWER') no_answers,
      (select count(*)::int from admissions where state = 'UNDER_REVIEW') under_review,
      (select count(*)::int from admissions where state = 'ACCEPTED') accepted,
      (select count(*)::int from intakes where trashed_at is not null) trashed,
      (select count(*)::int from receipt_assets where validation = 'CLEAN' and preview_key is not null and is_historical_placeholder = false) validated_receipts,
      (select count(*)::int from payment_submissions where supersedes_submission_id is not null) replacements`);
    assert.deepEqual(checks, { people: 60, instalments: 366, supers: 1, scopes: 1, open_promises: 1, broken_promises: 1, no_answers: 8, under_review: 1, accepted: 61, trashed: 1, validated_receipts: 7, replacements: 1 }, "Seed workflow postconditions");
    console.log("Seed verified: 4 programmes, 9 intakes (1 in Trash), 60 students, 61 enrolments, 6 instalments each, 2 staff; all fixture ledgers valid.");
    console.log("Staff: superadmin@t2t.example.test / admin@t2t.example.test. Password: T2T_SEED_PASSWORD or the development default above.");
    console.log("Synthetic student entry pairs (these identifiers are fabricated, not real student records):");
    for (const index of [0, 1, 2, 4, 5, 9]) {
      const e = enrolled[index];
      const [p] = await db().select().from(programmes).where(eq(programmes.id, e.intake.programmeId));
      console.log(`${e.nic} | ${p.name} | ${e.intake.label}`);
    }
    console.log(`Fixture as-of ${businessDate(now())}; dates age naturally when the app runs with the real clock.`);
  } finally {
    if (originalClock === undefined) delete process.env.T2T_FAKE_NOW;
    else process.env.T2T_FAKE_NOW = originalClock;
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : "Seed failed"); process.exitCode = 1; }).finally(closeDb);
