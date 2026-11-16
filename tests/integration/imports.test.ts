import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, enrolments, identityResolutions, students } from "@/db/schema";
import { db } from "@/db/client";
import {
  closeDb, fakeNic, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent,
  pinNow, principalOf, resetDb, unpinNow,
} from "./helpers";
import { STUDENT_IMPORT_HEADERS, importStudents } from "@/server/services/imports/students-import";
import { exportReportCsv } from "@/server/services/reports/exports";
import { toCsv } from "@/lib/csv";

beforeEach(async () => {
  await resetDb();
  pinNow("2026-06-15T12:00:00+05:30");
});

afterAll(async () => {
  unpinNow();
  await closeDb();
});

type Row = Partial<Record<(typeof STUDENT_IMPORT_HEADERS)[number], string | number>>;

function csv(rows: Row[]): string {
  return toCsv([...STUDENT_IMPORT_HEADERS], rows.map((r) => STUDENT_IMPORT_HEADERS.map((h) => r[h] ?? "")));
}

function row(over: Row): Row {
  return {
    full_name: "Import Student",
    nic: fakeNic(),
    programme_code: "PA",
    intake_code: "IA",
    instalment_sequence: 1,
    period_label: "Term 1",
    amount: "1000.00",
    due_date: "2026-06-01",
    ...over,
  };
}

async function fixture() {
  const programme = await makeProgramme({ code: "PA", name: "Programme A" });
  const intake = await makeIntake(programme.id, { code: "IA", label: "Intake A" });
  const admin = await makeStaff("ADMIN", { capabilities: ["imports.run"], scopes: [{ programmeId: programme.id }] });
  return { programme, intake, admin, p: principalOf(admin, [{ programmeId: programme.id }]) };
}

describe("student import validation (dry run)", () => {
  it("rejects duplicate NICs in the same file", async () => {
    const { p } = await fixture();
    const nic = fakeNic();
    const r = await importStudents(p, csv([
      row({ student_ref: "IMP-1", nic }),
      row({ student_ref: "IMP-2", nic }),
    ]), { batchKey: "batch-duplicate-nic", dryRun: true });

    expect(r.committed).toBe(false);
    expect(r.studentsCreated).toBe(0);
    expect(r.errors.some((e) => e.code === "DUPLICATE_NIC_IN_FILE" && e.severity === "error")).toBe(true);
    expect(await db().select().from(students)).toHaveLength(0);
  });

  it("reports invalid amounts and dates without writing", async () => {
    const { p } = await fixture();
    const r = await importStudents(p, csv([
      row({ student_ref: "IMP-3", amount: "not-a-number", due_date: "2026-13-40" }),
    ]), { batchKey: "batch-invalid-values", dryRun: true });

    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain("INVALID_AMOUNT");
    expect(codes).toContain("INVALID_DATE");
    expect(r.committed).toBe(false);
    expect(await db().select().from(students)).toHaveLength(0);
  });

  it("rejects intakes outside the principal's scope", async () => {
    const { p } = await fixture();
    const otherProgramme = await makeProgramme({ code: "PB", name: "Programme B" });
    await makeIntake(otherProgramme.id, { code: "IB", label: "Intake B" });

    const r = await importStudents(p, csv([
      row({ student_ref: "IMP-4", programme_code: "PB", intake_code: "IB" }),
    ]), { batchKey: "batch-out-of-scope", dryRun: true });

    expect(r.errors.some((e) => e.code === "INTAKE_NOT_FOUND")).toBe(true);
    expect(r.committed).toBe(false);
  });

  it("routes invalid NICs to identity resolutions on commit", async () => {
    const { p } = await fixture();
    const r = await importStudents(p, csv([
      row({ student_ref: "IMP-5", nic: "123", full_name: "No Identity" }),
    ]), { batchKey: "batch-identity-route", dryRun: false });

    expect(r.committed).toBe(true);
    expect(r.studentsCreated).toBe(0);
    expect(r.identityResolutionsCreated).toBe(1);
    const resolutions = await db().select().from(identityResolutions);
    expect(resolutions).toHaveLength(1);
    expect(await db().select().from(students)).toHaveLength(0);
  });
});

describe("student import commit", () => {
  it("creates students, enrolments and schedules and replays idempotently", async () => {
    const { p } = await fixture();
    const n1 = fakeNic(), n2 = fakeNic();
    const file = csv([
      row({ student_ref: "IMP-10", nic: n1, full_name: "First Student", instalment_sequence: 1, amount: "1000.00", due_date: "2026-06-01" }),
      row({ student_ref: "IMP-10", nic: n1, full_name: "First Student", instalment_sequence: 2, amount: "1500.00", due_date: "2026-07-01" }),
      row({ student_ref: "IMP-11", nic: n2, full_name: "Second Student", instalment_sequence: 1, amount: "2000.00", due_date: "2026-06-15" }),
    ]);

    const first = await importStudents(p, file, { batchKey: "batch-happy-path", dryRun: false });
    expect(first.committed).toBe(true);
    expect(first.replayed).toBe(false);
    expect(first.studentsCreated).toBe(2);
    expect(first.enrolmentsCreated).toBe(2);
    expect(first.instalmentsCreated).toBe(3);

    // Standard-import terms keep both the legacy batch-key reference and the new label.
    const enrolmentRows = await db().select().from(enrolments);
    for (const e of enrolmentRows) {
      expect(e.termsSnapshot).toMatchObject({ source: "students-import", batchKey: "batch-happy-path", label: "batch-happy-path" });
    }

    const replay = await importStudents(p, file, { batchKey: "batch-happy-path", dryRun: false });
    expect(replay.replayed).toBe(true);
    expect(replay.studentsCreated).toBe(2);
    expect(await db().select().from(students)).toHaveLength(2);

    const changed = csv([row({ student_ref: "IMP-12", nic: fakeNic() })]);
    await expect(importStudents(p, changed, { batchKey: "batch-happy-path", dryRun: false }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("CSV exports", () => {
  it("masks NICs, neutralises formula cells and audits the download", async () => {
    const superRow = await makeStaff("SUPER_ADMIN");
    const p = principalOf(superRow);
    const programme = await makeProgramme({ code: "PX", name: "Programme X" });
    const intake = await makeIntake(programme.id, { code: "IX", label: "Intake X" });
    const student = await makeStudent({ fullName: "=SUM(A1:A2)" });
    await makeEnrolment(student.id, intake.id, [{ amountMinor: 50_000, dueDate: "2026-01-01" }]);

    const out = await exportReportCsv(db(), p, { report: "outstanding", asOf: "2026-06-15" });
    expect(out.fullIdentifiers).toBe(false);
    expect(out.csv).toContain(`'=SUM(A1:A2)`);
    expect(out.csv).toContain(student.nicMasked);
    expect(out.csv).not.toContain(student.nic);
    expect(out.csv).toContain("Identifiers: NIC masked (default)");

    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.action, "export.download"), eq(auditEvents.entityId, "outstanding")));
    expect(audits).toHaveLength(1);
  });

  it("requires Super Admin for full identifiers", async () => {
    const programme = await makeProgramme({ code: "PY", name: "Programme Y" });
    await makeIntake(programme.id, { code: "IY", label: "Intake Y" });
    const adminRow = await makeStaff("ADMIN", { capabilities: ["exports.download"], scopes: [{ programmeId: programme.id }] });
    const admin = principalOf(adminRow, [{ programmeId: programme.id }]);

    await expect(exportReportCsv(db(), admin, { report: "students", fullIdentifiers: true }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("includes the full NIC for an authorised Super Admin and audits it", async () => {
    const superRow = await makeStaff("SUPER_ADMIN");
    const p = principalOf(superRow);
    const programme = await makeProgramme({ code: "PZ", name: "Programme Z" });
    const intake = await makeIntake(programme.id, { code: "IZ", label: "Intake Z" });
    const student = await makeStudent();
    await makeEnrolment(student.id, intake.id, [{ amountMinor: 10_000, dueDate: "2026-01-01" }]);

    const out = await exportReportCsv(db(), p, { report: "students", fullIdentifiers: true });
    expect(out.fullIdentifiers).toBe(true);
    expect(out.csv).toContain(student.nic);

    const audits = await db().select().from(auditEvents).where(eq(auditEvents.action, "export.full_identifiers"));
    expect(audits).toHaveLength(1);
  });
});
