import "server-only";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { staffAccounts, staffScopes } from "@/db/schema";
import { fail } from "@/server/http";
import { CAPABILITIES, type Capability, type StaffPrincipal } from "./policy";

/**
 * Reload the principal from authoritative storage INSIDE the caller's transaction (row locked
 * FOR SHARE so a concurrent deactivation/role change serializes with this mutation).
 * Deactivated, trashed or auth-version-stale accounts are rejected; scopes and capabilities are
 * re-read, so a grant removed mid-request takes effect immediately.
 */
export async function freshPrincipal(tx: DbOrTx, p: StaffPrincipal): Promise<StaffPrincipal> {
  const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, p.id)).for("share");
  if (!a || a.status !== "ACTIVE" || a.trashedAt || a.authVersion !== p.authVersion) throw fail.unauth();
  const scopes = await tx.select({ programmeId: staffScopes.programmeId, intakeId: staffScopes.intakeId }).from(staffScopes).where(eq(staffScopes.staffId, p.id));
  return {
    ...p, name: a.name, email: a.email, role: a.role, authVersion: a.authVersion, scopes,
    capabilities: new Set(a.capabilities.filter((c): c is Capability => (CAPABILITIES as readonly string[]).includes(c))),
  };
}
