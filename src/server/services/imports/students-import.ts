import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, withTx, type DbOrTx } from "@/db/client";
import {
  enrolments, feePlanItems, feePlanVersions, idempotencyRecords, identityResolutions,
  instalments, intakes, programmes, students,
} from "@/db/schema";
import { encryptNic, hmacHex, nicLookup } from "@/lib/crypto";
import { parseMajorToMinor } from "@/lib/money";
import { isValidNicFormat, maskNic, normalizeNic } from "@/lib/nic";
import { parseCsv, toCsv } from "@/lib/csv";
import { isBizDate, type BizDate } from "@/lib/time";
import { inScope, intakeScopeWhere, requireCap, type StaffPrincipal } from "@/server/auth/policy";
import { audit } from "@/server/audit";
import { fail } from "@/server/http";
import { freshPrincipal } from "@/server/auth/fresh";

/* --------------------------------------------------------------- constants */

export const STUDENT_IMPORT_HEADERS = [
  "student_ref",
  "full_name",
  "nic",
  "phone",
  "email",
  "programme_code",
  "intake_code",
  "instalment_sequence",
  "period_label",
  "amount",
  "due_date",
] as const;

const REQUIRED_HEADERS = [
  "full_name", "nic", "intake_code", "instalment_sequence", "amount", "due_date",
] as const;

const IMPORT_SCOPE = "imports.students";

/* ------------------------------------------------------------------ types */

export interface ImportRowError {
  /** Data row number in the submitted file (header excluded). */
  row: number;
  field?: string;
  code: string;
  message: string;
  /**
   * `error` blocks the whole commit; `identity` routes the row to identity_resolutions
   * (the rest of the file can still be committed).
   */
  severity: "error" | "identity";
}

export interface StudentImportResult {
  batchKey: string;
  dryRun: boolean;
  committed: boolean;
  replayed: boolean;
  totalRows: number;
  studentRows: number;
  studentsCreated: number;
  enrolmentsCreated: number;
  instalmentsCreated: number;
  identityResolutionsCreated: number;
  errors: ImportRowError[];
  warnings: string[];
}

export interface StudentImportOptions {
  /** Idempotency key for the import batch (8–200 chars). */
  batchKey: string;
  /** When true no writes occur. */
  dryRun: boolean;
  requestId?: string;
}

/* --------------------------------------------------------------- template */

/** CSV template: one row per instalment; repeat student_ref/nic for a multi-instalment schedule. */
export function studentsImportTemplate(): string {
  const preamble = [
    "T2T student + enrolment + opening schedule import template",
    "One row per instalment. Repeat student_ref/nic/full_name for each instalment of the same student.",
    "student_ref may be blank; the system generates a unique internal reference.",
    "nic must be a valid Sri Lankan NIC. Rows without a valid NIC are routed to identity resolutions.",
    "amount is decimal LKR (e.g. 4000.50). due_date is YYYY-MM-DD. Leave sequence/amount/due_date blank for no schedule.",
    "programme_code is optional when intake_code is unique in your scope.",
  ];
  return toCsv([...STUDENT_IMPORT_HEADERS], [], { preamble });
}

/* ---------------------------------------------------------------- parsing */

interface Cell { value: string; field: string }

interface RowInput {
  row: number;
  studentRef: string;
  fullName: string;
  nicRaw: string;
  nic: string;
  phone: string | null;
  email: string | null;
  programmeCode: string;
  intakeCode: string;
}

interface ParsedRow extends RowInput {
  sequence: number | null;
  periodLabel: string | null;
  amountMinor: number | null;
  dueDate: BizDate | null;
  hasSchedule: boolean;
}

interface Group {
  key: string;
  studentRef: string;
  fullName: string;
  nic: string;
  phone: string | null;
  email: string | null;
  programmeCode: string;
  intakeCode: string;
  intakeId: string | null;
  programmeId: string | null;
  rows: number[];
  schedule: { sequence: number; periodLabel: string; amountMinor: number; dueDate: BizDate }[];
  invalidNic: boolean;
}

interface IntakeInfo {
  intakeId: string;
  intakeCode: string;
  programmeId: string;
  programmeCode: string;
  usable: boolean;
}

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

function normaliseRows(csvText: string): string[][] {
  const all = parseCsv(csvText);
  return all.filter((r) => {
    if (!r.length) return false;
    const nonEmpty = r.filter((c) => c.trim() !== "");
    if (!nonEmpty.length) return false;
    // Preamble comment rows produced by our templates are single-cell rows starting with '#'.
    if (r.length === 1 && r[0].trimStart().startsWith("#")) return false;
    return true;
  });
}

function rowCells(row: string[], index: Record<string, number>): Cell[] {
  return Object.entries(index).map(([field, i]) => ({ field, value: row[i] ?? "" }));
}

/* ------------------------------------------------------------- validation */

/** Students with at least one enrolment visible to the principal (Super Admin: all). */
async function visibleStudents(tx: DbOrTx, p: StaffPrincipal, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  if (p.role === "SUPER_ADMIN") return new Set(ids);
  const rows = await tx.select({ studentId: enrolments.studentId, programmeId: intakes.programmeId, intakeId: intakes.id })
    .from(enrolments).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).where(inArray(enrolments.studentId, ids));
  return new Set(rows.filter((r) => inScope(p, r.programmeId, r.intakeId)).map((r) => r.studentId));
}

async function loadIntakes(tx: DbOrTx): Promise<IntakeInfo[]> {
  const rows = await tx
    .select({
      intakeId: intakes.id,
      intakeCode: intakes.code,
      intakeTrashedAt: intakes.trashedAt,
      programmeId: programmes.id,
      programmeCode: programmes.code,
      programmeTrashedAt: programmes.trashedAt,
    })
    .from(intakes)
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId));
  return rows.map((r) => ({
    intakeId: r.intakeId, intakeCode: r.intakeCode, programmeId: r.programmeId,
    programmeCode: r.programmeCode, usable: !r.intakeTrashedAt && !r.programmeTrashedAt,
  }));
}

function matchIntake(intakesList: IntakeInfo[], programmeCode: string, intakeCode: string, p: StaffPrincipal): IntakeInfo | null {
  const code = intakeCode.trim().toLowerCase();
  if (!code) return null;
  const matches = intakesList.filter((i) =>
    i.intakeCode.trim().toLowerCase() === code &&
    (!programmeCode.trim() || i.programmeCode.trim().toLowerCase() === programmeCode.trim().toLowerCase()) &&
    inScope(p, i.programmeId, i.intakeId),
  );
  return matches.length === 1 ? matches[0] : null;
}

interface Validated {
  groups: Group[];
  errors: ImportRowError[];
  warnings: string[];
  totalRows: number;
  identityGroups: { group: Group; payload: Record<string, unknown> }[];
}

async function validate(tx: DbOrTx, p: StaffPrincipal, csvText: string): Promise<Validated> {
  const rows = normaliseRows(csvText);
  const errors: ImportRowError[] = [];
  const warnings: string[] = [];
  if (!rows.length) throw fail.validation("The import file is empty.");
  const header = rows[0].map(normaliseHeader);
  const index: Record<string, number> = {};
  header.forEach((h, i) => { if (h) index[h] = i; });

  for (const h of REQUIRED_HEADERS) {
    if (!(h in index)) throw fail.validation(`Missing required column "${h}". Download the template and keep its headers.`);
  }
  const unknown = header.filter((h) => h && !(STUDENT_IMPORT_HEADERS as readonly string[]).includes(h));
  if (unknown.length) warnings.push(`Ignoring unrecognised columns: ${unknown.join(", ")}.`);

  const intakesList = await loadIntakes(tx);
  const dataRows = rows.slice(1).map((row, i) => ({ cells: rowCells(row, index), row: i + 1 }));

  const parsed: ParsedRow[] = dataRows.map(({ cells, row: rowNo }) => {
    const get = (f: string) => cells.find((c) => c.field === f)?.value ?? "";
    const nic = normalizeNic(get("nic"));
    return {
      row: rowNo,
      studentRef: get("student_ref").trim(),
      fullName: get("full_name").trim(),
      nicRaw: get("nic").trim(),
      nic,
      phone: get("phone").trim() || null,
      email: get("email").trim() || null,
      programmeCode: get("programme_code").trim(),
      intakeCode: get("intake_code").trim(),
      sequence: get("instalment_sequence").trim() ? Number(get("instalment_sequence").trim()) : null,
      periodLabel: get("period_label").trim() || null,
      amountMinor: get("amount").trim() ? parseMajorToMinor(get("amount")) : null,
      dueDate: get("due_date").trim() ? (isBizDate(get("due_date").trim()) ? get("due_date").trim() : null) : null,
      hasSchedule: Boolean(get("instalment_sequence").trim() || get("amount").trim() || get("due_date").trim()),
    };
  });

  // Group repeated rows belonging to the same person + intake.
  const groups = new Map<string, Group>();
  for (const r of parsed) {
    const groupKey = r.studentRef ? `ref:${r.studentRef.toLowerCase()}` : `nic:${r.nic || `row:${r.row}`}`;
    let g = groups.get(groupKey);
    if (!g) {
      g = {
        key: groupKey, studentRef: r.studentRef, fullName: r.fullName, nic: r.nic,
        phone: r.phone, email: r.email, programmeCode: r.programmeCode, intakeCode: r.intakeCode,
        intakeId: null, programmeId: null, rows: [], schedule: [], invalidNic: false,
      };
      groups.set(groupKey, g);
    }
    g.rows.push(r.row);
    if (!g.fullName && r.fullName) g.fullName = r.fullName;
    if (!g.phone && r.phone) g.phone = r.phone;
    if (!g.email && r.email) g.email = r.email;
  }

  // Validate each group exactly once.
  const nicOwners = new Map<string, Group>();
  for (const g of groups.values()) {
    const firstRow = g.rows[0];

    if (!g.fullName) {
      errors.push({ row: firstRow, field: "full_name", code: "FULL_NAME_REQUIRED", message: "Full name is required.", severity: "error" });
    }
    if (!g.nic || !isValidNicFormat(g.nic)) {
      g.invalidNic = true;
      errors.push({
        row: firstRow, field: "nic", code: "IDENTITY_UNRESOLVED",
        message: "A valid NIC is required. This row will be sent to identity resolutions and will not create a student.",
        severity: "identity",
      });
    } else {
      const owner = nicOwners.get(g.nic);
      if (owner && owner.key !== g.key) {
        errors.push({
          row: firstRow, field: "nic", code: "DUPLICATE_NIC_IN_FILE",
          message: "This NIC is used by another student in the same file. Never merge NICs silently.",
          severity: "error",
        });
      } else {
        nicOwners.set(g.nic, g);
      }
    }

    const intake = matchIntake(intakesList, g.programmeCode, g.intakeCode, p);
    if (!intake) {
      // One generic error: hidden and missing intakes are indistinguishable (no existence leak).
      errors.push({
        row: firstRow, field: "intake_code", code: "INTAKE_NOT_FOUND",
        message: "Intake not found or not in your scope.",
        severity: "error",
      });
    } else {
      g.intakeId = intake.intakeId;
      g.programmeId = intake.programmeId;
      if (!g.programmeCode) g.programmeCode = intake.programmeCode;
    }

    // Schedule is optional, but if any schedule cell is present all three are required.
    const groupRows = parsed.filter((r) => g.rows.includes(r.row));
    const sequences = new Set<number>();
    for (const r of groupRows) {
      if (!r.hasSchedule) continue;
      if (r.sequence === null || !Number.isInteger(r.sequence) || r.sequence < 1) {
        errors.push({ row: r.row, field: "instalment_sequence", code: "INVALID_SEQUENCE", message: "Instalment sequence must be a positive integer.", severity: "error" });
        continue;
      }
      if (r.amountMinor === null) {
        errors.push({ row: r.row, field: "amount", code: "INVALID_AMOUNT", message: "Amount must be a positive decimal LKR value with at most 2 decimal places.", severity: "error" });
      }
      if (r.dueDate === null) {
        errors.push({ row: r.row, field: "due_date", code: "INVALID_DATE", message: "Due date must be a valid YYYY-MM-DD business date.", severity: "error" });
      }
      const duplicate = sequences.has(r.sequence);
      if (duplicate) {
        errors.push({ row: r.row, field: "instalment_sequence", code: "DUPLICATE_SEQUENCE", message: "Duplicate instalment sequence for this student.", severity: "error" });
        continue;
      }
      sequences.add(r.sequence);
      if (r.amountMinor !== null && r.dueDate !== null) {
        g.schedule.push({ sequence: r.sequence, periodLabel: r.periodLabel ?? `Instalment ${r.sequence}`, amountMinor: r.amountMinor, dueDate: r.dueDate });
      }
    }
    g.schedule.sort((a, b) => a.sequence - b.sequence);
  }

  // Existing NICs and references in the database (never merge identities).
  const nics = [...groups.values()].filter((g) => g.nic && isValidNicFormat(g.nic)).map((g) => nicLookup(g.nic));
  if (nics.length) {
    const existing = await tx.select({ id: students.id, lookup: students.nicLookup }).from(students).where(inArray(students.nicLookup, nics));
    const visible = await visibleStudents(tx, p, existing.map((r) => r.id));
    const taken = new Map(existing.map((r) => [r.lookup, visible.has(r.id)]));
    for (const g of groups.values()) {
      const hit = g.nic && isValidNicFormat(g.nic) ? taken.get(nicLookup(g.nic)) : undefined;
      if (hit !== undefined) {
        errors.push(hit
          ? { row: g.rows[0], field: "nic", code: "NIC_ALREADY_REGISTERED", message: "This NIC already belongs to a student. Use the existing student record; imports never merge NICs.", severity: "error" }
          : { row: g.rows[0], field: "nic", code: "POSSIBLE_DUPLICATE", message: "Possible duplicate — refer this row to a Super Admin.", severity: "error" });
      }
    }
  }
  const refs = [...groups.values()].map((g) => g.studentRef).filter(Boolean);
  if (refs.length) {
    const existing = await tx.select({ id: students.id, ref: students.ref }).from(students).where(inArray(students.ref, refs));
    const visible = await visibleStudents(tx, p, existing.map((r) => r.id));
    const taken = new Map(existing.map((r) => [r.ref, visible.has(r.id)]));
    for (const g of groups.values()) {
      const hit = g.studentRef ? taken.get(g.studentRef) : undefined;
      if (hit !== undefined) {
        errors.push(hit
          ? { row: g.rows[0], field: "student_ref", code: "STUDENT_REF_EXISTS", message: "This student reference already exists. Imports never overwrite existing students.", severity: "error" }
          : { row: g.rows[0], field: "student_ref", code: "POSSIBLE_DUPLICATE", message: "Possible duplicate — refer this row to a Super Admin.", severity: "error" });
      }
    }
  }

  const identityGroups = [...groups.values()]
    .filter((g) => g.invalidNic)
    .map((g) => ({
      group: g,
      payload: {
        source: `students-import:${g.rows[0]}`,
        fullName: g.fullName,
        nicMasked: g.nic ? maskNic(g.nic) : null,
        ref: g.studentRef || null,
        phone: g.phone,
        email: g.email,
        intakeCode: g.intakeCode,
        programmeCode: g.programmeCode,
        schedule: g.schedule,
        rows: g.rows,
      },
    }));

  return { groups: [...groups.values()], errors, warnings, totalRows: dataRows.length, identityGroups };
}

/* ----------------------------------------------------------------- commit */

function importRef(): string {
  return `T2T-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/** Data needed to create one student + enrolment + opening schedule (shared with identity resolution). */
export interface ImportGroupData {
  ref: string | null;
  fullName: string;
  nic: string;
  phone: string | null;
  email: string | null;
  intakeId: string;
  schedule: { sequence: number; periodLabel: string; amountMinor: number; dueDate: BizDate }[];
}

export interface ImportCreateMeta {
  /** Human-readable origin for termsSnapshot/fee-plan notes; must not contain raw identifiers. */
  source: string;
  /** Short label for fee-plan version notes (e.g. import batch key or resolution id). */
  label: string;
  /** Original import batch key; kept for standard imports so consumers can trace terms back to the batch. */
  batchKey?: string;
  versionNo: number;
}

export interface CreatedImport {
  student: typeof students.$inferSelect;
  enrolment: typeof enrolments.$inferSelect;
  feePlanVersion: typeof feePlanVersions.$inferSelect;
  instalmentsCreated: number;
}

/**
 * Shared internal helper: create the student, its opening fee-plan version/items, the enrolment
 * and its opening instalments inside the CALLER's transaction. Used by `importStudents` and by
 * identity resolution so reprocessing commits in the same transaction — never a nested withTx.
 */
export async function createImportedStudentEnrolment(tx: DbOrTx, g: ImportGroupData, meta: ImportCreateMeta): Promise<CreatedImport> {
  const ref = g.ref || importRef();
  const [student] = await tx.insert(students).values({
    ref,
    nicEnc: encryptNic(g.nic),
    nicLookup: nicLookup(g.nic),
    nicMasked: maskNic(g.nic),
    fullName: g.fullName,
    phone: g.phone,
    email: g.email,
  }).returning();

  const [version] = await tx.insert(feePlanVersions).values({
    intakeId: g.intakeId, versionNo: meta.versionNo, isCurrent: false, notes: `Opening schedule ${meta.source} ${meta.label}`,
  }).returning();

  const items = g.schedule.length
    ? await tx.insert(feePlanItems).values(g.schedule.map((s) => ({
      versionId: version.id, sequence: s.sequence, periodLabel: s.periodLabel, amountMinor: s.amountMinor, dueDate: s.dueDate,
    }))).returning()
    : [];
  const itemBySeq = new Map(items.map((i) => [i.sequence, i.id]));

  const [enrolment] = await tx.insert(enrolments).values({
    studentId: student.id, intakeId: g.intakeId, feePlanVersionId: version.id, status: "ACTIVE",
    // batchKey preserved alongside label: consumers tracing standard imports back to the
    // submitting batch keep their source-reference contract.
    termsSnapshot: meta.batchKey ? { source: meta.source, label: meta.label, batchKey: meta.batchKey } : { source: meta.source, label: meta.label },
  }).returning();

  if (g.schedule.length) {
    await tx.insert(instalments).values(g.schedule.map((s) => ({
      enrolmentId: enrolment.id,
      feePlanItemId: itemBySeq.get(s.sequence) ?? null,
      sequence: s.sequence,
      component: "TUITION",
      periodLabel: s.periodLabel,
      originalChargeMinor: s.amountMinor,
      dueDate: s.dueDate,
    })));
  }

  return { student, enrolment, feePlanVersion: version, instalmentsCreated: g.schedule.length };
}

async function nextVersionNos(tx: DbOrTx, intakeIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!intakeIds.length) return map;
  const rows = await tx
    .select({ intakeId: feePlanVersions.intakeId, maxVersion: sql<string>`coalesce(max(${feePlanVersions.versionNo}), 0)` })
    .from(feePlanVersions)
    .where(inArray(feePlanVersions.intakeId, intakeIds))
    .groupBy(feePlanVersions.intakeId);
  for (const r of rows) map.set(r.intakeId, Number(r.maxVersion));
  return map;
}

interface StoredResult extends StudentImportResult {
  requestHash: string;
}

/**
 * Validate and (unless `dryRun`) commit a student/enrolment/opening-schedule CSV.
 *
 * - Dry-run performs every validation with no writes.
 * - Commit is transactional, all-or-nothing for blocking errors, and idempotent by
 *   `batchKey` (replaying the same key + content returns the original result).
 * - Rows without a valid NIC are recorded in `identity_resolutions`, never guessed.
 */
export async function importStudents(
  p0: StaffPrincipal,
  csvText: string,
  opts: StudentImportOptions,
): Promise<StudentImportResult> {
  const p = await freshPrincipal(db(), p0);
  requireCap(p, "imports.run");
  if (!opts.batchKey || opts.batchKey.length < 8 || opts.batchKey.length > 200) {
    throw fail.validation("batchKey must be 8–200 characters.");
  }
  const requestHash = hmacHex(csvText.trim(), IMPORT_SCOPE);

  if (opts.dryRun) {
    const tx = db();
    const v = await validate(tx, p, csvText);
    return {
      batchKey: opts.batchKey,
      dryRun: true,
      committed: false,
      replayed: false,
      totalRows: v.totalRows,
      studentRows: v.groups.length,
      studentsCreated: 0,
      enrolmentsCreated: 0,
      instalmentsCreated: 0,
      identityResolutionsCreated: v.identityGroups.length,
      errors: v.errors,
      warnings: v.warnings,
    };
  }

  return withTx(async (tx) => {
    const [existing] = await tx
      .select()
      .from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.scope, IMPORT_SCOPE), eq(idempotencyRecords.key, opts.batchKey)));

    if (existing) {
      const stored = existing.response as StoredResult | null;
      if (!stored || stored.requestHash !== requestHash) {
        throw fail.conflict("This import batch key was already used for different file content.");
      }
      const { requestHash: _hash, ...result } = stored;
      void _hash;
      return { ...result, replayed: true };
    }

    const v = await validate(tx, p, csvText);
    const blocking = v.errors.filter((e) => e.severity === "error");
    if (blocking.length) {
      return {
        batchKey: opts.batchKey, dryRun: false, committed: false, replayed: false,
        totalRows: v.totalRows, studentRows: v.groups.length, studentsCreated: 0,
        enrolmentsCreated: 0, instalmentsCreated: 0, identityResolutionsCreated: 0,
        errors: v.errors, warnings: v.warnings,
      };
    }

    const importable = v.groups.filter((g) => !g.invalidNic && g.intakeId && g.fullName);
    const versionNos = await nextVersionNos(tx, [...new Set(importable.map((g) => g.intakeId!))]);
    let studentsCreated = 0, enrolmentsCreated = 0, instalmentsCreated = 0;

    for (const g of importable) {
      const created = await createImportedStudentEnrolment(tx, {
        ref: g.studentRef || null, fullName: g.fullName, nic: g.nic, phone: g.phone, email: g.email,
        intakeId: g.intakeId!, schedule: g.schedule,
      }, { source: "students-import", label: opts.batchKey, batchKey: opts.batchKey, versionNo: (versionNos.get(g.intakeId!) ?? 0) + 1 });
      versionNos.set(g.intakeId!, (versionNos.get(g.intakeId!) ?? 0) + 1);
      studentsCreated += 1;
      enrolmentsCreated += 1;
      instalmentsCreated += created.instalmentsCreated;
    }

    for (const i of v.identityGroups) {
      await tx.insert(identityResolutions).values({
        source: "students_import",
        reason: "Invalid or missing NIC in import",
        payload: { ...i.payload, batchKey: opts.batchKey },
        programmeId: i.group.programmeId,
      });
    }

    await audit(tx, {
      actorType: "STAFF",
      actorId: p.id,
      action: "imports.students.commit",
      entityType: "import_batch",
      entityId: opts.batchKey,
      after: {
        totalRows: v.totalRows, studentsCreated, enrolmentsCreated, instalmentsCreated,
        identityResolutions: v.identityGroups.length, warnings: v.warnings,
      },
      requestId: opts.requestId ?? null,
    });

    const result: StudentImportResult = {
      batchKey: opts.batchKey,
      dryRun: false,
      committed: true,
      replayed: false,
      totalRows: v.totalRows,
      studentRows: v.groups.length,
      studentsCreated,
      enrolmentsCreated,
      instalmentsCreated,
      identityResolutionsCreated: v.identityGroups.length,
      errors: v.errors,
      warnings: v.warnings,
    };

    await tx.insert(idempotencyRecords).values({
      scope: IMPORT_SCOPE,
      key: opts.batchKey,
      requestHash,
      response: { ...result, requestHash },
      status: 200,
    });

    return result;
  });
}

/** Internal helper exposed for tests/reconciliation: the exact query predicate for this service. */
export async function importableIntakeIds(tx: DbOrTx, p: StaffPrincipal): Promise<string[]> {
  const rows = await tx.select({ id: intakes.id }).from(intakes)
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(intakeScopeWhere(p, intakes.id, intakes.programmeId));
  return rows.map((r) => r.id);
}
