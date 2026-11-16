import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import { idempotencyRecords, staffAccounts, staffScopes } from "@/db/schema";
import { type Capability, type StaffPrincipal } from "@/server/auth/policy";
import { fail } from "@/server/http";
import { isBizDate } from "@/lib/time";

export const daySchema = z.string().refine(isBizDate, "Use a valid YYYY-MM-DD date.");
export const versionSchema = z.number().int().positive();
export const reasonSchema = z.string().trim().min(1).max(2000);

/** Reload authority inside the caller's transaction; stale sessions cannot retain access. */
export async function freshPrincipal(tx: DbOrTx, p: StaffPrincipal): Promise<StaffPrincipal> {
  const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, p.id)).for("share");
  if (!a || a.status !== "ACTIVE" || a.trashedAt || a.authVersion !== p.authVersion) throw fail.unauth();
  const scopes = await tx.select({ programmeId: staffScopes.programmeId, intakeId: staffScopes.intakeId }).from(staffScopes).where(eq(staffScopes.staffId, p.id));
  return { ...p, role: a.role, capabilities: new Set(a.capabilities as Capability[]), scopes };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Advisory lock serializes retries, including concurrent saves against different enrolments. */
export async function replay<T>(tx: DbOrTx, scope: string, key: string, payload: unknown, action: () => Promise<T>): Promise<T> {
  z.string().min(8).max(200).parse(key);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${scope}:${key}`}, 0))`);
  const requestHash = createHash("sha256").update(canonical(payload)).digest("hex");
  const [old] = await tx.select().from(idempotencyRecords).where(and(eq(idempotencyRecords.scope, scope), eq(idempotencyRecords.key, key)));
  if (old) {
    if (old.requestHash !== requestHash) throw fail.conflict("This idempotency key was used with different data.");
    return old.response as T;
  }
  const result = await action();
  await tx.insert(idempotencyRecords).values({ scope, key, requestHash, response: JSON.parse(JSON.stringify(result)), status: 200 });
  return result;
}
