import "server-only";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { enrolments, intakes, programmes } from "@/db/schema";
import { fail } from "@/server/http";

/** Exactly two staff roles. Students use a separate session type. */
export type StaffRole = "SUPER_ADMIN" | "ADMIN";

/** Delegable capabilities for ADMIN. SUPER_ADMIN implicitly holds all of them. Deny by default. */
export const CAPABILITIES = [
  "programme.manage",        // edit existing programmes/intakes within scope (not create)
  "programme.create",        // create new programmes/intakes; creator scope assigned transactionally
  "fees.adjust",             // fee-plan versions, charge adjustments, credit application
  "exemptions.manage",       // free card / sponsorship awards, arrears waivers
  "withdrawals.manage",      // withdrawal and reactivation
  "exports.download",        // CSV exports (masked NIC)
  "admissions.decide",       // accept/reject/waitlist applicants
  "imports.run",             // bulk CSV import (Super Admin by default)
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Super-Admin-only abilities: never delegable. */
export type SuperOnly =
  | "staff.manage" | "trash.manage" | "platform.settings" | "audit.global" | "nic.correct"
  | "exports.full_identifiers" | "review.correction";

export interface ScopeGrant { programmeId: string; intakeId: string | null }

export interface StaffPrincipal {
  kind: "staff";
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  capabilities: ReadonlySet<Capability>;
  scopes: readonly ScopeGrant[];
  authVersion: number;
  sessionId: string;
  csrfSecret: string;
}

export const isSuper = (p: StaffPrincipal) => p.role === "SUPER_ADMIN";

export function can(p: StaffPrincipal, cap: Capability | SuperOnly): boolean {
  if (isSuper(p)) return true;
  return (CAPABILITIES as readonly string[]).includes(cap) && p.capabilities.has(cap as Capability);
}

export function requireCap(p: StaffPrincipal, cap: Capability | SuperOnly): void {
  if (!can(p, cap)) throw fail.forbidden();
}

export function requireSuper(p: StaffPrincipal): void {
  if (!isSuper(p)) throw fail.forbidden();
}

/**
 * SQL predicate restricting rows to the principal's scope, given the intake id column
 * (and its programme id column). Super Admin: no restriction (includes unassigned records).
 * Admin with no scopes: matches nothing.
 */
export function intakeScopeWhere(p: StaffPrincipal, intakeIdCol: SQL | typeof intakes.id | typeof enrolments.intakeId, programmeIdCol: SQL | typeof intakes.programmeId): SQL {
  if (isSuper(p)) return sql`true`;
  if (p.scopes.length === 0) return sql`false`;
  const whole = p.scopes.filter((s) => s.intakeId === null).map((s) => s.programmeId);
  const specific = p.scopes.filter((s) => s.intakeId !== null).map((s) => s.intakeId as string);
  const parts: SQL[] = [];
  if (whole.length) parts.push(sql`${programmeIdCol} in (${sql.join(whole.map((x) => sql`${x}::uuid`), sql`, `)})`);
  if (specific.length) parts.push(sql`${intakeIdCol} in (${sql.join(specific.map((x) => sql`${x}::uuid`), sql`, `)})`);
  return sql`(${sql.join(parts, sql` or `)})`;
}

export function inScope(p: StaffPrincipal, programmeId: string, intakeId: string): boolean {
  if (isSuper(p)) return true;
  return p.scopes.some((s) => s.programmeId === programmeId && (s.intakeId === null || s.intakeId === intakeId));
}

export function programmeInScope(p: StaffPrincipal, programmeId: string): boolean {
  return isSuper(p) || p.scopes.some((s) => s.programmeId === programmeId);
}

export interface EnrolmentContext {
  enrolmentId: string; studentId: string; intakeId: string; programmeId: string;
  enrolmentStatus: string; intakeTrashed: boolean; programmeTrashed: boolean;
}

/** Load an enrolment and assert scope. Out-of-scope = NOT_FOUND (no existence leak). */
export async function enrolmentInScope(tx: DbOrTx, p: StaffPrincipal, enrolmentId: string): Promise<EnrolmentContext> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(enrolmentId)) throw fail.notFound();
  const [row] = await tx
    .select({
      enrolmentId: enrolments.id, studentId: enrolments.studentId, intakeId: enrolments.intakeId,
      programmeId: intakes.programmeId, enrolmentStatus: enrolments.status,
      intakeTrashedAt: intakes.trashedAt, programmeTrashedAt: programmes.trashedAt,
    })
    .from(enrolments)
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(eq(enrolments.id, enrolmentId));
  if (!row || !inScope(p, row.programmeId, row.intakeId)) throw fail.notFound();
  return {
    enrolmentId: row.enrolmentId, studentId: row.studentId, intakeId: row.intakeId, programmeId: row.programmeId,
    enrolmentStatus: row.enrolmentStatus, intakeTrashed: !!row.intakeTrashedAt, programmeTrashed: !!row.programmeTrashedAt,
  };
}

/** Operational mutations are suspended for trashed programmes/intakes (spec §12). */
export function assertOperational(ctx: EnrolmentContext): void {
  if (ctx.intakeTrashed || ctx.programmeTrashed) throw fail.conflict("This programme or intake is in Trash. Restore it before making changes.");
}

/** Intake ids visible to the principal (null = all). */
export async function visibleIntakeIds(tx: DbOrTx, p: StaffPrincipal): Promise<string[] | null> {
  if (isSuper(p)) return null;
  if (!p.scopes.length) return [];
  const whole = p.scopes.filter((s) => s.intakeId === null).map((s) => s.programmeId);
  const specific = p.scopes.filter((s) => s.intakeId !== null).map((s) => s.intakeId as string);
  const rows = await tx.select({ id: intakes.id }).from(intakes).where(
    or(whole.length ? inArray(intakes.programmeId, whole) : sql`false`, specific.length ? inArray(intakes.id, specific) : sql`false`),
  );
  return rows.map((r) => r.id);
}

/** Predicate: intake + programme are live (not trashed). */
export const liveIntakeWhere = () => and(isNull(intakes.trashedAt), isNull(programmes.trashedAt));
