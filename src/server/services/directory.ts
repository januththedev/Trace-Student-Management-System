import "server-only";
import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { and, asc, desc, eq, exists, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withTx, isUniqueViolation, type DbOrTx, type Tx } from "@/db/client";
import { admissions, chargeAdjustments, enrolments, feePlanItems, feePlanVersions, intakes, programmes, staffAccounts, staffScopes, students, paymentSubmissions, paymentEvents, paymentAllocations } from "@/db/schema";
import { encryptNic, nicLookup } from "@/lib/crypto";
import { isValidNicFormat, maskNic, normalizeNic } from "@/lib/nic";
import { isBizDate, now } from "@/lib/time";
import { audit } from "@/server/audit";
import { intakeScopeWhere, programmeInScope, requireCap, requireSuper, type Capability, type StaffPrincipal } from "@/server/auth/policy";
import { fail } from "@/server/http";
import { once } from "@/server/idempotency";
import { loadLedgers } from "./ledger";
import { lockMediaPath } from "./trash/purge";

/** Re-read the account and grants inside the mutation transaction. Lock prevents concurrent revocation. */
export async function freshDirectoryPrincipal(tx: Tx, p: StaffPrincipal): Promise<StaffPrincipal> {
  const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, p.id)).for("share");
  if (!a || a.status !== "ACTIVE" || a.trashedAt || a.authVersion !== p.authVersion) throw fail.unauth();
  const scopes = await tx.select({ programmeId: staffScopes.programmeId, intakeId: staffScopes.intakeId }).from(staffScopes).where(eq(staffScopes.staffId, p.id));
  return { ...p, role: a.role, capabilities: new Set(a.capabilities as Capability[]), scopes };
}

const studentFields = { id: students.id, ref: students.ref, fullName: students.fullName, phone: students.phone, email: students.email, nicMasked: students.nicMasked, status: students.status, version: students.version, doNotCall: students.doNotCall, wrongNumber: students.wrongNumber };
function studentScope(tx: DbOrTx, p: StaffPrincipal) {
  return p.role === "SUPER_ADMIN" ? sql`true` : exists(tx.select({ id: enrolments.id }).from(enrolments).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).where(and(eq(enrolments.studentId, students.id), intakeScopeWhere(p, intakes.id, intakes.programmeId))));
}
export const studentSearchInput = z.object({ q: z.string().trim().max(200).default(""), nic: z.string().trim().max(20).optional(), cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export async function searchStudents(tx: DbOrTx, p: StaffPrincipal, raw: z.input<typeof studentSearchInput> = {}) {
  const input = studentSearchInput.parse(raw);
  const conditions = [studentScope(tx, p)];
  if (input.nic) {
    const nic = normalizeNic(input.nic);
    if (!isValidNicFormat(nic)) throw fail.validation("Enter a complete NIC for exact matching.");
    conditions.push(eq(students.nicLookup, nicLookup(nic)));
  } else if (input.q) {
    // NIC lookup is exclusively an explicit POST field; it never enters URLs or partial search.
    if (isValidNicFormat(normalizeNic(input.q))) throw fail.validation("Use the private exact NIC search field.");
    const term = `%${input.q.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(or(ilike(students.fullName, term), ilike(students.ref, term), ilike(students.phone, term))!);
  }
  const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(students).where(and(...conditions));
  const rows = await tx.select(studentFields).from(students).where(and(...conditions, input.cursor ? gt(students.id, input.cursor) : undefined)).orderBy(asc(students.id)).limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const visible = page.length ? await tx.select({ id: enrolments.id, studentId: enrolments.studentId, status: enrolments.status, programmeName: programmes.name, intakeLabel: intakes.label }).from(enrolments).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(and(inArray(enrolments.studentId, page.map(r => r.id)), intakeScopeWhere(p, intakes.id, intakes.programmeId))).orderBy(asc(enrolments.id)) : [];
  return { count, rows: page.map(s => ({ ...s, enrolments: visible.filter(e => e.studentId === s.id) })), nextCursor: rows.length > input.limit ? page.at(-1)!.id : null };
}
export async function studentDetail(tx: DbOrTx, p: StaffPrincipal, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw fail.notFound();
  const [student] = await tx.select(studentFields).from(students).where(and(eq(students.id, id), studentScope(tx, p)));
  if (!student) throw fail.notFound();
  const visible = await tx.select({ id: enrolments.id, status: enrolments.status, programmeName: programmes.name, intakeLabel: intakes.label }).from(enrolments).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(and(eq(enrolments.studentId, id), intakeScopeWhere(p, intakes.id, intakes.programmeId))).orderBy(asc(enrolments.id));
  const ledgers = await loadLedgers(tx, visible.map(e => e.id));
  return { student, enrolments: visible.map(e => ({ ...e, summary: ledgers.get(e.id)!.summary })) };
}
export const contactInput = z.object({ studentId: z.string().uuid(), expectedVersion: z.number().int().positive(), fullName: z.string().trim().min(2).max(200), phone: z.string().trim().max(30).nullable(), email: z.string().trim().email().max(200).nullable(), doNotCall: z.boolean(), wrongNumber: z.boolean(), nic: z.string().trim().max(20).optional(), reason: z.string().trim().min(3).max(500) });
export async function editStudent(p: StaffPrincipal, raw: z.input<typeof contactInput>, key: string, requestId?: string) {
  const v = contactInput.parse(raw);
  try { return await withTx(async tx => {
    const actor = await freshDirectoryPrincipal(tx, p);
    await studentDetail(tx, actor, v.studentId);
    if (v.nic !== undefined) requireSuper(actor);
    return (await once(tx, `directory.contact:${p.id}`, key, v, async () => {
      const [before] = await tx.select(studentFields).from(students).where(eq(students.id, v.studentId)).for("update");
      if (before.version !== v.expectedVersion) throw fail.stale("This profile changed. Refresh before saving.");
      let identity = {};
      if (v.nic !== undefined) {
        const nic = normalizeNic(v.nic);
        if (!isValidNicFormat(nic)) throw fail.validation("Enter a valid complete NIC.");
        identity = { nicEnc: encryptNic(nic), nicLookup: nicLookup(nic), nicMasked: maskNic(nic) };
      }
      const [after] = await tx.update(students).set({ fullName: v.fullName, phone: v.phone, email: v.email, doNotCall: v.doNotCall, wrongNumber: v.wrongNumber, ...(v.phone !== before.phone ? { phoneVerifiedAt: null, phoneVerifiedBy: null } : {}), ...(v.email !== before.email ? { emailVerifiedAt: null, emailVerifiedBy: null } : {}), ...identity, version: before.version + 1, updatedAt: now() }).where(eq(students.id, v.studentId)).returning(studentFields);
      await audit(tx, { actorType: "STAFF", actorId: actor.id, action: v.nic !== undefined ? "student.nic.correct" : "student.contact.edit", entityType: "student", entityId: v.studentId, before, after, reason: v.reason, requestId });
      return after;
    })).result;
  }); } catch (e) { if (isUniqueViolation(e)) throw fail.conflict("The identifier is already assigned. Review the existing person before correcting it."); throw e; }
}

const recordFields = { code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/), bannerPath: z.string().max(200).nullable().default(null), status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]), isPublic: z.boolean() };
export const programmeInput = z.object({ ...recordFields, name: z.string().trim().min(2).max(200), description: z.string().trim().max(2000).default(""), id: z.string().uuid().optional(), expectedVersion: z.number().int().positive().optional() });
export const intakeInput = z.object({ ...recordFields, programmeId: z.string().uuid(), label: z.string().trim().min(1).max(100), startDate: z.string().refine(isBizDate), endDate: z.string().refine(isBizDate).nullable(), id: z.string().uuid().optional(), expectedVersion: z.number().int().positive().optional() }).refine(v => !v.endDate || v.endDate >= v.startDate, { message: "End date must be on or after start date", path: ["endDate"] });
export async function bannerChoices(): Promise<string[]> {
  try { return (await readdir(path.join(process.cwd(), "public/banners"))).filter(f => /^[A-Za-z0-9_-]+\.(webp|png|jpe?g)$/i.test(f)).map(f => `/banners/${f}`).sort(); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
async function validateBanner(tx: Tx, banner: string | null) {
  if (!banner) return;
  if (!/^\/banners\/[A-Za-z0-9_-]+\.(webp|png|jpe?g)$/i.test(banner)) throw fail.validation("Choose a banner from the available files.");
  await lockMediaPath(tx, banner);
  try {
    const root = await realpath(path.join(process.cwd(), "public/banners"));
    const target = await realpath(path.join(process.cwd(), "public", banner.slice(1)));
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !(await stat(target)).isFile()) throw fail.validation("Invalid banner file.");
  } catch { throw fail.validation("The selected banner is unavailable."); }
}
export async function listProgrammes(tx: DbOrTx, p: StaffPrincipal) {
  const ids = p.scopes.map(s => s.programmeId);
  return tx.select().from(programmes).where(p.role === "SUPER_ADMIN" ? undefined : ids.length ? inArray(programmes.id, ids) : sql`false`).orderBy(asc(programmes.name));
}
export async function programmeDetail(tx: DbOrTx, p: StaffPrincipal, id: string) {
  if (!z.string().uuid().safeParse(id).success || !programmeInScope(p, id)) throw fail.notFound();
  const [programme] = await tx.select().from(programmes).where(eq(programmes.id, id));
  if (!programme) throw fail.notFound();
  const intakeRows = await tx.select().from(intakes).where(and(eq(intakes.programmeId, id), intakeScopeWhere(p, intakes.id, intakes.programmeId))).orderBy(asc(intakes.startDate));
  const versions = intakeRows.length ? await tx.select().from(feePlanVersions).where(inArray(feePlanVersions.intakeId, intakeRows.map(i => i.id))).orderBy(desc(feePlanVersions.versionNo)) : [];
  const items = versions.length ? await tx.select().from(feePlanItems).where(inArray(feePlanItems.versionId, versions.map(v => v.id))).orderBy(asc(feePlanItems.sequence)) : [];
  return { programme, intakes: intakeRows.map(i => ({ ...i, versions: versions.filter(v => v.intakeId === i.id).map(v => ({ ...v, items: items.filter(it => it.versionId === v.id) })) })) };
}
export async function saveProgramme(p: StaffPrincipal, raw: z.input<typeof programmeInput>, key: string, requestId?: string) {
  const v = programmeInput.parse(raw);
  try { return await withTx(async tx => {
    const actor = await freshDirectoryPrincipal(tx, p);
    if (v.id && !programmeInScope(actor, v.id)) throw fail.notFound();
    requireCap(actor, v.id ? "programme.manage" : "programme.create");
    return (await once(tx, `directory.programme:${p.id}`, key, v, async () => {
      const { id, expectedVersion, ...data } = v;
      await validateBanner(tx, data.bannerPath);
      const [before] = id ? await tx.select().from(programmes).where(eq(programmes.id, id)).for("update") : [];
      if (id && !before) throw fail.notFound();
      if (before?.trashedAt) throw fail.conflict("Restore this programme before editing.");
      if (before && before.version !== expectedVersion) throw fail.stale("This programme changed. Refresh before saving.");
      const [saved] = before ? await tx.update(programmes).set({ ...data, version: before.version + 1, updatedAt: now() }).where(eq(programmes.id, before.id)).returning() : await tx.insert(programmes).values(data).returning();
      if (!before && actor.role === "ADMIN") await tx.insert(staffScopes).values({ staffId: actor.id, programmeId: saved.id, createdBy: actor.id });
      await audit(tx, { actorType: "STAFF", actorId: actor.id, action: before ? "programme.edit" : "programme.create", entityType: "programme", entityId: saved.id, programmeId: saved.id, before, after: saved, requestId });
      return saved;
    })).result;
  }); } catch (e) { if (isUniqueViolation(e)) throw fail.conflict("Programme code is already used."); throw e; }
}
export async function saveIntake(p: StaffPrincipal, raw: z.input<typeof intakeInput>, key: string, requestId?: string) {
  const v = intakeInput.parse(raw);
  try { return await withTx(async tx => {
    const actor = await freshDirectoryPrincipal(tx, p);
    if (!programmeInScope(actor, v.programmeId)) throw fail.notFound();
    requireCap(actor, v.id ? "programme.manage" : "programme.create");
    // An intake-scoped creator may only add a sibling when explicitly delegated creation.
    return (await once(tx, `directory.intake:${p.id}`, key, v, async () => {
      const [parent] = await tx.select().from(programmes).where(eq(programmes.id, v.programmeId)).for("share");
      if (!parent) throw fail.notFound();
      if (parent.trashedAt) throw fail.conflict("Restore the programme before editing intakes.");
      const { id, expectedVersion, ...data } = v;
      const [before] = id ? await tx.select().from(intakes).where(and(eq(intakes.id, id), eq(intakes.programmeId, parent.id), intakeScopeWhere(actor, intakes.id, intakes.programmeId))).for("update") : [];
      if (id && !before) throw fail.notFound();
      if (before?.trashedAt) throw fail.conflict("Restore this intake before editing.");
      if (before && before.version !== expectedVersion) throw fail.stale("This intake changed. Refresh before saving.");
      await validateBanner(tx, data.bannerPath);
      const [saved] = before ? await tx.update(intakes).set({ ...data, version: before.version + 1, updatedAt: now() }).where(eq(intakes.id, before.id)).returning() : await tx.insert(intakes).values(data).returning();
      if (!before && actor.role === "ADMIN" && !actor.scopes.some(s => s.programmeId === parent.id && s.intakeId === null)) await tx.insert(staffScopes).values({ staffId: actor.id, programmeId: parent.id, intakeId: saved.id, createdBy: actor.id });
      await audit(tx, { actorType: "STAFF", actorId: actor.id, action: before ? "intake.edit" : "intake.create", entityType: "intake", entityId: saved.id, programmeId: parent.id, intakeId: saved.id, before, after: saved, requestId });
      return saved;
    })).result;
  }); } catch (e) { if (isUniqueViolation(e)) throw fail.conflict("An intake with that code or label already exists in this programme."); throw e; }
}
export async function admissionDirectory(tx: DbOrTx, p: StaffPrincipal, state?: string) {
  const stateInput = z.enum(["DRAFT", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "WAITLISTED", "WITHDRAWN"]).optional().parse(state || undefined);
  const choices = await tx.select({ id: intakes.id, label: intakes.label, programmeName: programmes.name }).from(intakes).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(and(intakeScopeWhere(p, intakes.id, intakes.programmeId), isNull(intakes.trashedAt), isNull(programmes.trashedAt), eq(intakes.status, "ACTIVE"), eq(programmes.status, "ACTIVE"))).orderBy(asc(programmes.name), asc(intakes.label));
  const rows = await tx.select({ id: admissions.id, applicantName: admissions.applicantName, nicMasked: admissions.nicMasked, phone: admissions.phone, email: admissions.email, state: admissions.state, version: admissions.version, enrolmentId: admissions.enrolmentId, intakeLabel: intakes.label, programmeName: programmes.name, notes: admissions.notes, sponsorshipRequested: admissions.sponsorshipRequested, decisionReason: admissions.decisionReason }).from(admissions).innerJoin(intakes, eq(intakes.id, admissions.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(and(intakeScopeWhere(p, intakes.id, intakes.programmeId), stateInput ? eq(admissions.state, stateInput) : undefined)).orderBy(desc(admissions.createdAt)).limit(200);
  return { rows, choices };
}
export async function enrolmentSubmissions(tx: DbOrTx, p: StaffPrincipal, id: string) {
  const { enrolmentInScope } = await import("@/server/auth/policy");
  await enrolmentInScope(tx, p, id);
  return tx.select({ id: paymentSubmissions.id, claimedMinor: paymentSubmissions.claimedMinor, status: paymentSubmissions.status, transferDate: paymentSubmissions.transferDate, version: paymentSubmissions.version, supersedesSubmissionId: paymentSubmissions.supersedesSubmissionId }).from(paymentSubmissions).where(eq(paymentSubmissions.enrolmentId, id)).orderBy(desc(paymentSubmissions.submittedAt));
}
/** History remains readable after withdrawal/Trash; every row is bound to the authorized enrolment. */
export async function enrolmentHistory(tx: DbOrTx, p: StaffPrincipal, id: string) {
  const { enrolmentInScope } = await import("@/server/auth/policy");
  await enrolmentInScope(tx, p, id);
  const events = await tx.select().from(paymentEvents).where(eq(paymentEvents.enrolmentId, id)).orderBy(desc(paymentEvents.createdAt), desc(paymentEvents.id));
  const adjustments = await tx.select().from(chargeAdjustments).where(eq(chargeAdjustments.enrolmentId, id)).orderBy(desc(chargeAdjustments.createdAt), desc(chargeAdjustments.id));
  const allocations = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.enrolmentId, id)).orderBy(desc(paymentAllocations.createdAt), desc(paymentAllocations.id));
  return { events, adjustments, allocations };
}
export { db };
