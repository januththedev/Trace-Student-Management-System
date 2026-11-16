import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withTx, type Tx } from "@/db/client";
import { governanceLock, intakes, programmes, staffAccounts, staffInvitations, staffScopes } from "@/db/schema";
import { hashPassword, hashToken } from "@/lib/crypto";
import { now } from "@/lib/time";
import { audit } from "@/server/audit";
import { CAPABILITIES, type StaffPrincipal } from "@/server/auth/policy";
import { revokeAllStaffSessions } from "@/server/auth/staff";
import { fail } from "@/server/http";
import { assertSuperAdminInvariant, freshSuper, lockGovernance, MAX_ACTIVE_SUPER_ADMINS } from "./invariant";
import { once, operationKey } from "./idempotency";

export const passwordSchema = z.string().min(12).max(256);
const role = z.enum(["SUPER_ADMIN", "ADMIN"]);
export const scopeSchema = z.object({ programmeId: z.uuid(), intakeId: z.uuid().nullable().default(null) });
export const inviteSchema = z.object({
  email: z.email().max(254).transform(v => v.trim().toLowerCase()), name: z.string().trim().min(1).max(150), role,
  capabilities: z.array(z.enum(CAPABILITIES)).max(20).default([]), scopes: z.array(scopeSchema).max(200).default([]),
});
export const editStaffSchema = z.object({
  id: z.uuid(), version: z.number().int().positive(), role,
  capabilities: z.array(z.enum(CAPABILITIES)).max(20), scopes: z.array(scopeSchema).max(200),
  reason: z.string().trim().min(1).max(1000),
});
export const statusSchema = z.object({ id: z.uuid(), version: z.number().int().positive(), action: z.enum(["deactivate", "reactivate"]), reason: z.string().trim().min(1).max(1000) });
export const acceptSchema = z.object({ token: z.string().min(32).max(200), password: passwordSchema });

export function publicStaff(a: typeof staffAccounts.$inferSelect) {
  return { id: a.id, name: a.name, email: a.email, role: a.role, status: a.status, capabilities: a.capabilities, version: a.version, trashedAt: a.trashedAt };
}

export async function validateScopes(tx: Tx, scopes: z.output<typeof scopeSchema>[]) {
  const seen = new Set<string>();
  for (const s of scopes) {
    const k = `${s.programmeId}:${s.intakeId ?? "*"}`;
    if (seen.has(k)) throw fail.validation("Duplicate scope assignment.");
    seen.add(k);
    const [p] = await tx.select({ id: programmes.id }).from(programmes).where(and(eq(programmes.id, s.programmeId), isNull(programmes.trashedAt))).for("share");
    if (!p) throw fail.notFound();
    if (s.intakeId) {
      const [i] = await tx.select({ id: intakes.id }).from(intakes).where(and(eq(intakes.id, s.intakeId), eq(intakes.programmeId, s.programmeId), isNull(intakes.trashedAt))).for("share");
      if (!i) throw fail.notFound();
    }
  }
}

export async function bootstrapSuperAdmin(input: { email: string; name: string; password: string }) {
  const v = inviteSchema.pick({ email: true, name: true }).extend({ password: passwordSchema }).parse(input);
  const passwordHash = await hashPassword(v.password);
  return withTx(async tx => {
    const lock = await lockGovernance(tx);
    if (lock.bootstrappedAt || lock.activeSuperAdmins > 0) throw fail.conflict("Bootstrap has already been completed or an active Super Admin exists.");
    const [a] = await tx.insert(staffAccounts).values({ email: v.email, name: v.name, passwordHash, role: "SUPER_ADMIN" }).returning();
    await tx.update(governanceLock).set({ bootstrappedAt: now(), updatedAt: now() }).where(eq(governanceLock.id, 1));
    await assertSuperAdminInvariant(tx);
    await audit(tx, { actorType: "SYSTEM", action: "staff.bootstrap", entityType: "staff", entityId: a.id, after: publicStaff(a) });
    return publicStaff(a);
  });
}

export async function inviteStaff(actor: StaffPrincipal, input: z.input<typeof inviteSchema>, key: string) {
  const v = inviteSchema.parse(input);
  operationKey.parse(key);
  // Deterministic high-entropy HMAC permits response replay without persisting a bearer token.
  const token = hashToken(`${actor.id}:${key}:${JSON.stringify(v)}`, "staff-invitation-issue");
  const result = await withTx(async tx => {
    const lock = await lockGovernance(tx);
    await freshSuper(tx, actor);
    return once(tx, `invite:${actor.id}`, key, v, async () => {
      if (v.role === "SUPER_ADMIN" && lock.activeSuperAdmins >= MAX_ACTIVE_SUPER_ADMINS) throw fail.conflict("All three Super Admin places are occupied. No invitation was created.");
      await validateScopes(tx, v.scopes);
      const [exists] = await tx.select({ id: staffAccounts.id }).from(staffAccounts).where(sql`lower(${staffAccounts.email}) = ${v.email}`);
      if (exists) throw fail.conflict("A staff account already uses this email.");
      const [inv] = await tx.insert(staffInvitations).values({ ...v, tokenHash: hashToken(token, "staff-invitation"), invitedBy: actor.id, expiresAt: new Date(now().getTime() + 7 * 86400000) }).returning();
      await audit(tx, { actorType: "STAFF", actorId: actor.id, action: "staff.invite", entityType: "invitation", entityId: inv.id, after: { email: v.email, role: v.role, expiresAt: inv.expiresAt } });
      await assertSuperAdminInvariant(tx);
      return { id: inv.id, expiresAt: inv.expiresAt.toISOString() };
    });
  });
  return { ...result, token };
}

export async function invitationDetails(token: string) {
  z.string().min(32).max(200).parse(token);
  const [i] = await db().select({ name: staffInvitations.name, role: staffInvitations.role, expiresAt: staffInvitations.expiresAt, acceptedAt: staffInvitations.acceptedAt, revokedAt: staffInvitations.revokedAt }).from(staffInvitations).where(eq(staffInvitations.tokenHash, hashToken(token, "staff-invitation")));
  if (!i || i.acceptedAt || i.revokedAt || i.expiresAt <= now()) throw fail.notFound();
  return { name: i.name, role: i.role, expiresAt: i.expiresAt };
}

export async function acceptInvitation(input: z.input<typeof acceptSchema>, key: string) {
  const v = acceptSchema.parse(input);
  operationKey.parse(key);
  const passwordHash = await hashPassword(v.password);
  return withTx(async tx => {
    const lock = await lockGovernance(tx);
    const tokenHash = hashToken(v.token, "staff-invitation");
    // A used/revoked invitation cannot create a session, even with the original request key.
    const [i] = await tx.select().from(staffInvitations).where(eq(staffInvitations.tokenHash, tokenHash)).for("update");
    if (!i || i.revokedAt || i.expiresAt <= now()) throw fail.conflict("This invitation is invalid or expired. Ask for a new invitation.");
    return once(tx, `accept:${i.id}`, key, { passwordDigest: hashToken(v.password, "invitation-password") }, async () => {
      if (i.acceptedAt) throw fail.conflict("This invitation has already been used.");
      const [inviter] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, i.invitedBy));
      if (!inviter || inviter.role !== "SUPER_ADMIN" || inviter.status !== "ACTIVE" || inviter.trashedAt) throw fail.conflict("This invitation is no longer authorized. Ask for a new invitation.");
      if (i.role === "SUPER_ADMIN" && lock.activeSuperAdmins >= MAX_ACTIVE_SUPER_ADMINS) throw fail.conflict("All three Super Admin places are occupied. This invitation has not been accepted; ask an administrator to free a place.");
      await validateScopes(tx, i.scopes);
      const [exists] = await tx.select({ id: staffAccounts.id }).from(staffAccounts).where(sql`lower(${staffAccounts.email}) = ${i.email.toLowerCase()}`);
      if (exists) throw fail.conflict("A staff account already uses this email.");
      const [a] = await tx.insert(staffAccounts).values({ email: i.email, name: i.name, role: i.role, capabilities: i.capabilities, passwordHash }).returning();
      if (i.scopes.length) await tx.insert(staffScopes).values(i.scopes.map(s => ({ ...s, staffId: a.id, createdBy: i.invitedBy })));
      await tx.update(staffInvitations).set({ acceptedAt: now(), acceptedStaffId: a.id }).where(eq(staffInvitations.id, i.id));
      await assertSuperAdminInvariant(tx);
      await audit(tx, { actorType: "SYSTEM", action: "staff.invitation.accept", entityType: "staff", entityId: a.id, after: publicStaff(a) });
      return publicStaff(a);
    });
  });
}

export async function editStaff(actor: StaffPrincipal, input: z.input<typeof editStaffSchema>, key: string) {
  const v = editStaffSchema.parse(input);
  return withTx(async tx => {
    await lockGovernance(tx);
    await freshSuper(tx, actor);
    return once(tx, `staff-edit:${actor.id}`, key, v, async () => {
      const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, v.id)).for("update");
      if (!a || a.trashedAt) throw fail.notFound();
      if (a.version !== v.version) throw fail.stale("This account changed. Refresh and try again.");
      await validateScopes(tx, v.scopes);
      const [updated] = await tx.update(staffAccounts).set({ role: v.role, capabilities: v.capabilities, version: a.version + 1, authVersion: a.authVersion + 1, updatedAt: now() }).where(eq(staffAccounts.id, a.id)).returning();
      await tx.delete(staffScopes).where(eq(staffScopes.staffId, a.id));
      if (v.scopes.length) await tx.insert(staffScopes).values(v.scopes.map(s => ({ ...s, staffId: a.id, createdBy: actor.id })));
      await revokeAllStaffSessions(tx, a.id);
      await invalidateInvitations(tx, a);
      await assertSuperAdminInvariant(tx);
      await audit(tx, { actorType: "STAFF", actorId: actor.id, action: "staff.edit", entityType: "staff", entityId: a.id, before: publicStaff(a), after: { ...publicStaff(updated), scopes: v.scopes }, reason: v.reason });
      return publicStaff(updated);
    });
  });
}

/** Revoke outstanding invitations issued by or addressed to an account losing access. */
export async function invalidateInvitations(tx: Tx, a: typeof staffAccounts.$inferSelect) {
  await tx.update(staffInvitations).set({ revokedAt: now() }).where(and(isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt), sql`(${staffInvitations.invitedBy} = ${a.id}::uuid or lower(${staffInvitations.email}) = ${a.email.toLowerCase()})`));
}

export async function changeStaffStatus(actor: StaffPrincipal, input: z.input<typeof statusSchema>, key: string) {
  const v = statusSchema.parse(input);
  return withTx(async tx => {
    await lockGovernance(tx);
    await freshSuper(tx, actor);
    return once(tx, `staff-status:${actor.id}`, key, v, async () => {
      const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, v.id)).for("update");
      if (!a || a.trashedAt) throw fail.notFound();
      if (a.version !== v.version) throw fail.stale("This account changed. Refresh and try again.");
      const status = v.action === "deactivate" ? "DEACTIVATED" : "ACTIVE";
      if (a.status === status) throw fail.conflict(`This account is already ${status.toLowerCase()}.`);
      const [updated] = await tx.update(staffAccounts).set({ status, version: a.version + 1, authVersion: a.authVersion + 1, updatedAt: now() }).where(eq(staffAccounts.id, a.id)).returning();
      await revokeAllStaffSessions(tx, a.id);
      await invalidateInvitations(tx, a);
      await assertSuperAdminInvariant(tx);
      await audit(tx, { actorType: "STAFF", actorId: actor.id, action: `staff.${v.action}`, entityType: "staff", entityId: a.id, before: publicStaff(a), after: publicStaff(updated), reason: v.reason });
      return publicStaff(updated);
    });
  });
}

export async function listTeam(actor: StaffPrincipal) {
  return withTx(async tx => {
    await freshSuper(tx, actor);
    const accounts = await tx.select().from(staffAccounts).where(isNull(staffAccounts.trashedAt)).orderBy(staffAccounts.name);
    const scopes = await tx.select().from(staffScopes);
    const courses = await tx.select({ id: programmes.id, name: programmes.name }).from(programmes).where(isNull(programmes.trashedAt)).orderBy(programmes.name);
    const batches = await tx.select({ id: intakes.id, programmeId: intakes.programmeId, label: intakes.label }).from(intakes).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(and(isNull(intakes.trashedAt), isNull(programmes.trashedAt))).orderBy(intakes.label);
    return { staff: accounts.map(a => ({ ...publicStaff(a), scopes: scopes.filter(s => s.staffId === a.id).map(s => ({ programmeId: s.programmeId, intakeId: s.intakeId })) })), programmes: courses, intakes: batches };
  });
}
