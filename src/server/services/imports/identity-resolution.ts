import "server-only";
import { z } from "zod";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import {
  feePlanVersions, idempotencyRecords, identityResolutions, intakes, programmes, students,
} from "@/db/schema";
import { hmacHex, nicLookup } from "@/lib/crypto";
import { isValidNicFormat, normalizeNic } from "@/lib/nic";
import { isBizDate, now, type BizDate } from "@/lib/time";
import { requireCap, type StaffPrincipal } from "@/server/auth/policy";
import { freshPrincipal } from "@/server/auth/fresh";
import { audit } from "@/server/audit";
import { fail } from "@/server/http";
import { createImportedStudentEnrolment } from "./students-import";

/**
 * Identity resolution queue: rows staged by the student importer for people whose identifier
 * was missing/invalid. Only a Super Admin may resolve them (NIC corrections are a super-only
 * ability). Resolving ACTUALLY creates the corrected student + enrolment (+ optional opening
 * schedule) from the staged payload and marks the row resolved in the SAME transaction.
 * Original evidence (source/reason/payload) is never overwritten; no identifiers are invented.
 */

export const RESOLVE_SCOPE = "identity.resolve";

/** Strict UUID shape; lenient hex/dash patterns would admit 36-dash junk into Postgres casts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------ sanitization */

/** NIC-shaped digit runs typed into free text must never reach audit/queue surfaces. */
function scrubIdentifierText(s: string): string {
  return s.replace(/\b\d{9}[VX]\b/gi, "[redacted]").replace(/\b\d{12}\b/g, "[redacted]");
}

interface StagedPayload {
  source?: string;
  fullName?: string;
  nicMasked?: string | null;
  ref?: string | null;
  phone?: string | null;
  email?: string | null;
  intakeCode?: string;
  programmeCode?: string;
  schedule?: { sequence: number; periodLabel: string; amountMinor: number; dueDate: string }[];
  rows?: number[];
  [k: string]: unknown;
}

function readPayload(row: typeof identityResolutions.$inferSelect): StagedPayload {
  return (row.payload ?? {}) as StagedPayload;
}

/** Stale-guard digest over the sanitized preview fields a resolver confirms. */
function rowHash(row: typeof identityResolutions.$inferSelect, p: StagedPayload): string {
  return hmacHex(JSON.stringify({
    id: row.id, createdAt: row.createdAt, source: row.source, reason: row.reason,
    fullName: p.fullName ?? null, nicMasked: p.nicMasked ?? null, ref: p.ref ?? null,
    phone: p.phone ?? null, email: p.email ?? null,
    intakeCode: p.intakeCode ?? null, programmeCode: p.programmeCode ?? null,
    schedule: p.schedule ?? null, rows: p.rows ?? null, resolved: row.resolvedAt ?? null,
  }), "identity.preview");
}

function toSanitized(row: typeof identityResolutions.$inferSelect, p: StagedPayload) {
  return {
    id: row.id,
    source: row.source,
    reason: row.reason,
    programmeId: row.programmeId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolution: row.resolution,
    fullName: p.fullName ?? null,
    nicMasked: p.nicMasked ?? null,
    ref: p.ref ?? null,
    phone: p.phone ?? null,
    email: p.email ?? null,
    intakeCode: p.intakeCode ?? null,
    programmeCode: p.programmeCode ?? null,
    fileRows: p.rows ?? null,
    schedule: (p.schedule ?? []).map((s) => ({ sequence: s.sequence, periodLabel: s.periodLabel, amountMinor: s.amountMinor, dueDate: s.dueDate })),
  };
}

/* ----------------------------------------------------------------- queries */

const LIST_LIMIT = 200;

/** Super Admin only (capability "nic.correct" is super-only). Sanitized fields only — never the raw payload. */
export async function listIdentities(p0: StaffPrincipal, status: "open" | "resolved" | "all" = "open") {
  const p = await freshPrincipal(db(), p0);
  requireCap(p, "nic.correct");
  const rows = await db()
    .select({ r: identityResolutions, programmeCode: programmes.code, programmeName: programmes.name })
    .from(identityResolutions)
    .leftJoin(programmes, eq(programmes.id, identityResolutions.programmeId))
    .where(status === "open" ? isNull(identityResolutions.resolvedAt) : status === "resolved" ? isNotNull(identityResolutions.resolvedAt) : sql`true`)
    .orderBy(desc(identityResolutions.createdAt))
    .limit(LIST_LIMIT);
  return rows.map(({ r, programmeCode, programmeName }) => {
    const p2 = readPayload(r);
    return { ...toSanitized(r, p2), programmeCode: p2.programmeCode ?? programmeCode, programmeName };
  });
}

export interface IdentityPreview {
  id: string;
  createdAt: Date;
  source: string;
  reason: string;
  programmeCode: string | null;
  programmeName: string | null;
  fullName: string | null;
  nicMasked: string | null;
  ref: string | null;
  phone: string | null;
  email: string | null;
  intakeCode: string | null;
  fileRows: number[] | null;
  schedule: { sequence: number; periodLabel: string; amountMinor: number; dueDate: string }[];
  resolvedAt: Date | null;
  resolution: string | null;
  /** Pass back on resolve; rejected with STALE if the row changed since this preview. */
  expectedHash: string;
}

export async function previewIdentity(p0: StaffPrincipal, id: string): Promise<IdentityPreview> {
  const p = await freshPrincipal(db(), p0);
  requireCap(p, "nic.correct");
  if (!UUID_RE.test(id)) throw fail.notFound();
  const [row] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, id));
  if (!row) throw fail.notFound();
  const payload = readPayload(row);
  let programmeName: string | null = null;
  if (row.programmeId) {
    const [pr] = await db().select({ code: programmes.code, name: programmes.name }).from(programmes).where(eq(programmes.id, row.programmeId));
    programmeName = pr ? `${pr.code} ${pr.name}` : null;
  }
  const base = toSanitized(row, payload);
  return {
    ...base,
    programmeCode: base.programmeCode,
    programmeName,
    schedule: base.schedule,
    expectedHash: rowHash(row, payload),
  };
}

/* ----------------------------------------------------------------- resolve */

const scheduleItemSchema = z.object({
  sequence: z.coerce.number().int().min(1).max(999),
  periodLabel: z.string().trim().min(1).max(120).optional(),
  amount: z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, "Amount must be a decimal LKR value with at most 2 decimal places."),
  dueDate: z.string().trim().refine(isBizDate, "Due date must be a valid YYYY-MM-DD date."),
});

export const resolveIdentitySchema = z.object({
  nic: z.string().trim().min(6).max(20),
  reason: z.string().trim().min(8).max(500),
  ref: z.string().trim().max(60).optional(),
  schedule: z.array(scheduleItemSchema).max(120).optional(),
});

/** Full mutation contract the service enforces itself — callers must not bypass it. */
const resolveIdentityInputSchema = resolveIdentitySchema.extend({
  expectedHash: z.string().min(16).max(200),
  idempotencyKey: z.string().min(8).max(200),
});

export type ResolveIdentityInput = z.infer<typeof resolveIdentitySchema>;

export interface ResolveIdentityResult {
  resolutionId: string;
  studentId: string;
  studentRef: string;
  enrolmentId: string;
  instalmentsCreated: number;
  replayed: boolean;
}

/**
 * Super Admin resolves a staged row by supplying an explicitly valid corrected NIC, a reason,
 * an optional reference (for legacy payloads without one) and optional opening instalments.
 * The row lock serializes concurrent resolvers; the whole import + mark commits atomically.
 * Raw input is Zod-parsed here (not only at the API boundary) and malformed ids are neutral 404s.
 */
export async function resolveIdentity(
  p0: StaffPrincipal,
  id: string,
  input: unknown,
): Promise<ResolveIdentityResult> {
  if (!UUID_RE.test(id)) throw fail.notFound();
  const parsed = resolveIdentityInputSchema.safeParse(input);
  if (!parsed.success) {
    throw fail.validation("Some fields are invalid.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const input2 = parsed.data;
  const nic = normalizeNic(input2.nic);
  if (!isValidNicFormat(nic)) throw fail.validation("The corrected NIC is not a valid Sri Lankan NIC. Nothing was imported.");
  const reason = scrubIdentifierText(input2.reason.trim());
  const ref = input2.ref?.trim() || null;
  const requestHash = hmacHex(JSON.stringify({ id, nic, reason, ref, schedule: input2.schedule ?? null }), RESOLVE_SCOPE);

  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    requireCap(p, "nic.correct");

    const [existing] = await tx.select().from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.scope, RESOLVE_SCOPE), eq(idempotencyRecords.key, input2.idempotencyKey)));
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw fail.conflict("This idempotency key was already used for a different resolution request.");
      }
      const stored = existing.response as ResolveIdentityResult | null;
      if (!stored) throw fail.conflict("This idempotency key was already used.");
      return { ...stored, replayed: true };
    }

    // Row lock: concurrent resolvers serialize here; the loser sees the row already resolved.
    const [row] = await tx.select().from(identityResolutions).where(eq(identityResolutions.id, id)).for("update");
    if (!row) throw fail.notFound();
    if (row.resolvedAt) {
      throw fail.conflict("This resolution was already completed by another action.");
    }
    const payload = readPayload(row);
    if (rowHash(row, payload) !== input2.expectedHash) {
      throw fail.stale("This preview is stale — the queue row changed. Reload it and confirm again.");
    }

    // Match the staged intake again against live, in-scope intakes (Super Admin: all), scoped to
    // the programme recorded on the row / in the payload. The same intake code is valid in more
    // than one programme, so an unscoped code match must never pick an arbitrary first row.
    const stagedIntakeCode = (payload.intakeCode ?? "").trim();
    if (!stagedIntakeCode) throw fail.validation("The staged row has no intake reference; it cannot be imported.");
    const stagedProgrammeCode = (payload.programmeCode ?? "").trim();
    const candidates = await tx
      .select({
        intakeId: intakes.id,
        intakeCode: intakes.code,
        intakeStatus: intakes.status,
        programmeId: programmes.id,
        programmeCode: programmes.code,
      })
      .from(intakes)
      .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
      .where(and(
        sql`lower(${intakes.code}) = lower(${stagedIntakeCode})`,
        isNull(intakes.trashedAt),
        isNull(programmes.trashedAt),
        row.programmeId ? eq(programmes.id, row.programmeId) : undefined,
        stagedProgrammeCode ? sql`lower(${programmes.code}) = lower(${stagedProgrammeCode})` : undefined,
      ));
    if (candidates.length !== 1) {
      throw fail.validation(candidates.length === 0
        ? "The intake referenced by this row no longer matches a live intake. Restore it or resolve manually."
        : "The staged intake reference is ambiguous — the same intake code matches more than one live programme. Restore the correct programme or resolve manually.");
    }
    const intake = candidates[0];

    // Lock and re-read the matched intake so a trash/status/code/programme change committed
    // while this resolver waited cannot leave us using the pre-lock candidate snapshot.
    const [lockedIntake] = await tx.select({
      id: intakes.id,
      code: intakes.code,
      status: intakes.status,
      programmeId: intakes.programmeId,
      trashedAt: intakes.trashedAt,
    }).from(intakes).where(eq(intakes.id, intake.intakeId)).for("update");
    if (!lockedIntake) {
      throw fail.validation("The intake referenced by this row no longer matches a live intake. Restore it or resolve manually.");
    }

    // Take a shared parent lock too; programme trash/code edits must be revalidated after any
    // wait, and the staged row's recorded programme identity must still identify this parent.
    const [lockedProgramme] = await tx.select({
      id: programmes.id,
      code: programmes.code,
      trashedAt: programmes.trashedAt,
    }).from(programmes).where(eq(programmes.id, lockedIntake.programmeId)).for("update");
    const intakeStillMatches = lockedIntake.id === intake.intakeId
      && lockedIntake.code.toLowerCase() === stagedIntakeCode.toLowerCase()
      && lockedIntake.programmeId === intake.programmeId
      && lockedIntake.trashedAt === null
      && lockedIntake.status === intake.intakeStatus;
    const programmeStillMatches = !!lockedProgramme
      && lockedProgramme.id === intake.programmeId
      && (!row.programmeId || lockedProgramme.id === row.programmeId)
      && (!stagedProgrammeCode || lockedProgramme.code.toLowerCase() === stagedProgrammeCode.toLowerCase())
      && lockedProgramme.code.toLowerCase() === intake.programmeCode.toLowerCase()
      && lockedProgramme.trashedAt === null;
    if (!intakeStillMatches || !programmeStillMatches) {
      throw fail.validation("The intake or programme changed after matching this row. Restore it or refresh the staged reference before resolving.");
    }

    // Explicit conflicts: never silently merge with an existing person/reference.
    const lookup = nicLookup(nic);
    const [nicHit] = await tx.select({ id: students.id }).from(students).where(eq(students.nicLookup, lookup));
    if (nicHit) {
      throw fail.conflict("The corrected identifier already belongs to an existing student. Records are never merged automatically — decide manually which record to keep.");
    }
    const effectiveRef = ref || payload.ref || null;
    if (effectiveRef) {
      const [refHit] = await tx.select({ id: students.id }).from(students).where(eq(students.ref, effectiveRef));
      if (refHit) {
        throw fail.conflict("The reference already belongs to an existing student. Choose a different reference; records are never merged automatically.");
      }
    }

    // Schedule: resolver-supplied instalments, or the schedule staged with the row.
    const stagedSchedule = Array.isArray(payload.schedule) ? (payload.schedule as StagedPayload["schedule"]) ?? [] : [];
    let schedule: { sequence: number; periodLabel: string; amountMinor: number; dueDate: BizDate }[];
    if (input2.schedule) {
      schedule = input2.schedule.map((s) => ({
        sequence: s.sequence,
        periodLabel: s.periodLabel ?? `Instalment ${s.sequence}`,
        amountMinor: parseAmount(s.amount),
        dueDate: s.dueDate as BizDate,
      }));
    } else {
      schedule = (stagedSchedule ?? []).map((s) => {
        if (!s || !Number.isInteger(s.sequence) || s.sequence < 1 || !Number.isInteger(s.amountMinor) || s.amountMinor < 0 || !isBizDate(s.dueDate)) {
          throw fail.validation("The staged schedule is incomplete or invalid. Supply the instalments manually.");
        }
        return { sequence: s.sequence, periodLabel: s.periodLabel, amountMinor: s.amountMinor, dueDate: s.dueDate as BizDate };
      });
    }
    const seqs = new Set<number>();
    for (const s of schedule) {
      if (seqs.has(s.sequence)) throw fail.validation("Duplicate instalment sequence in the supplied schedule.");
      seqs.add(s.sequence);
      if (s.amountMinor < 0) throw fail.validation("Instalment amounts cannot be negative.");
    }
    schedule.sort((a, b) => a.sequence - b.sequence);

    const [versionRow] = await tx
      .select({ maxVersion: sql<string>`coalesce(max(${feePlanVersions.versionNo}), 0)` })
      .from(feePlanVersions)
      .where(eq(feePlanVersions.intakeId, intake.intakeId));

    const created = await createImportedStudentEnrolment(tx, {
      ref: effectiveRef,
      fullName: payload.fullName ?? "",
      nic,
      phone: payload.phone ?? null,
      email: payload.email ?? null,
      intakeId: intake.intakeId,
      schedule,
    }, { source: "identity-resolution", label: row.id, versionNo: Number(versionRow?.maxVersion ?? 0) + 1 });

    const resolution = JSON.stringify({
      outcome: "IMPORTED",
      reason,
      studentId: created.student.id,
      studentRef: created.student.ref,
      enrolmentId: created.enrolment.id,
      instalments: created.instalmentsCreated,
    });

    await tx.update(identityResolutions).set({
      resolvedAt: now(), resolvedBy: p.id, resolution,
    }).where(eq(identityResolutions.id, id));

    await audit(tx, {
      actorType: "STAFF",
      actorId: p.id,
      action: "identity.resolve.correct",
      entityType: "identity_resolution",
      entityId: id,
      programmeId: intake.programmeId,
      intakeId: intake.intakeId,
      reason,
      after: {
        outcome: "IMPORTED", studentId: created.student.id, studentRef: created.student.ref,
        enrolmentId: created.enrolment.id, instalmentsCreated: created.instalmentsCreated,
      },
    });

    const result: ResolveIdentityResult = {
      resolutionId: id,
      studentId: created.student.id,
      studentRef: created.student.ref,
      enrolmentId: created.enrolment.id,
      instalmentsCreated: created.instalmentsCreated,
      replayed: false,
    };

    await tx.insert(idempotencyRecords).values({
      scope: RESOLVE_SCOPE, key: input2.idempotencyKey, requestHash, response: result, status: 200,
    });

    return result;
  });
}

function parseAmount(s: string): number {
  const [major, minor = ""] = s.split(".");
  return Number(major) * 100 + Number(minor.padEnd(2, "0"));
}

/** Count of unresolved rows, for badges (sanitized; Super Admin only). */
export async function openIdentityCount(p0: StaffPrincipal): Promise<number> {
  const p = await freshPrincipal(db(), p0);
  requireCap(p, "nic.correct");
  const [r] = await db().select({ n: sql<string>`count(*)` }).from(identityResolutions).where(isNull(identityResolutions.resolvedAt));
  return Number(r?.n ?? 0);
}
