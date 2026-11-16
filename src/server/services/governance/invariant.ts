import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { governanceLock, staffAccounts } from "@/db/schema";
import type { StaffPrincipal } from "@/server/auth/policy";
import { fail } from "@/server/http";

export const MAX_ACTIVE_SUPER_ADMINS = 3;

/** Acquire this BEFORE staff/invitation row locks. All lifecycle writers share it. */
export async function lockGovernance(tx: Tx) {
  await tx.insert(governanceLock).values({ id: 1 }).onConflictDoNothing();
  const [row] = await tx.select().from(governanceLock).where(eq(governanceLock.id, 1)).for("update");
  if (!row) throw new Error("Governance singleton missing");
  return { ...row, activeSuperAdmins: await countActiveSuperAdmins(tx) };
}

async function countActiveSuperAdmins(tx: Tx) {
  const [r] = await tx.select({ count: sql<number>`count(*)::int` }).from(staffAccounts)
    .where(and(eq(staffAccounts.role, "SUPER_ADMIN"), eq(staffAccounts.status, "ACTIVE"), isNull(staffAccounts.trashedAt)));
  return r.count;
}

/** Reentrant locking makes this safe even when a new caller omits the admission lock. */
export async function assertSuperAdminInvariant(tx: Tx) {
  const { activeSuperAdmins: count } = await lockGovernance(tx);
  if (count < 1) throw fail.conflict("At least one active Super Admin must remain, including for your own account.");
  if (count > MAX_ACTIVE_SUPER_ADMINS) throw fail.conflict("All three Super Admin places are occupied. Choose Admin explicitly or free a place first.");
}

/** Recheck authoritative account state inside the transaction, including stale principals. */
export async function freshSuper(tx: Tx, principal: StaffPrincipal) {
  const [actor] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, principal.id));
  if (!actor || actor.status !== "ACTIVE" || actor.trashedAt || actor.authVersion !== principal.authVersion) throw fail.unauth();
  if (actor.role !== "SUPER_ADMIN") throw fail.forbidden();
  return actor;
}
