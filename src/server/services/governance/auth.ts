import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx } from "@/db/client";
import { rateLimitBuckets, staffAccounts, staffSessions } from "@/db/schema";
import { hashToken, verifyPassword } from "@/lib/crypto";
import { now } from "@/lib/time";
import { audit } from "@/server/audit";
import { createStaffSession } from "@/server/auth/staff";
import type { StaffPrincipal } from "@/server/auth/policy";
import { AppError, fail } from "@/server/http";
import { hit } from "@/server/ratelimit";
import { once, operationKey } from "./idempotency";

export const loginSchema = z.object({ email: z.email().max(254).transform(v => v.trim().toLowerCase()), password: z.string().min(1).max(256) });
const WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ATTEMPTS = 10;
export const LOGIN_IP_ATTEMPTS = 20;
const LOGIN_IP_WINDOW_SEC = 15 * 60;

/** Separate transaction commits failures too. Never reset the bucket on bad credentials. */
async function consumeLoginAttempt(email: string) {
  return withTx(async tx => {
    const t = now();
    const key = `staff-login:${hashToken(email, "login-rate")}`;
    const [bucket] = await tx.insert(rateLimitBuckets).values({ key, count: 1, windowStart: t }).onConflictDoUpdate({ target: rateLimitBuckets.key, set: {
      count: sql`case when ${rateLimitBuckets.windowStart} <= ${new Date(t.getTime() - WINDOW_MS).toISOString()}::timestamptz then 1 else ${rateLimitBuckets.count} + 1 end`,
      windowStart: sql`case when ${rateLimitBuckets.windowStart} <= ${new Date(t.getTime() - WINDOW_MS).toISOString()}::timestamptz then ${t.toISOString()}::timestamptz else ${rateLimitBuckets.windowStart} end`,
    } }).returning();
    return bucket.count <= LOGIN_ATTEMPTS;
  });
}

export async function loginStaff(input: z.input<typeof loginSchema>, key: string, ip?: string) {
  const v = loginSchema.parse(input);
  operationKey.parse(key);
  if (ip) {
    const byIp = await hit("staff-login-ip", ip, LOGIN_IP_ATTEMPTS, LOGIN_IP_WINDOW_SEC);
    if (!byIp.allowed) throw fail.throttled();
  }
  const result = await withTx(async tx => {
    const [a] = await tx.select().from(staffAccounts).where(sql`lower(${staffAccounts.email}) = ${v.email}`).for("update");
    const valid = await verifyPassword(v.password, a?.passwordHash ?? null);
    if (!a || !valid || a.status !== "ACTIVE" || a.trashedAt) {
      await audit(tx, { actorType: "SYSTEM", action: "staff.login.failed", entityType: "authentication" });
      return null;
    }
    const token = hashToken(`${a.id}:${key}`, "staff-login-issue");
    const r = await once(tx, `login:${a.id}`, key, { credentials: hashToken(v.password, "login-credentials") }, async () => {
      const { session } = await createStaffSession(tx, a.id, a.authVersion);
      await tx.update(staffSessions).set({ tokenHash: hashToken(token, "staff-session") }).where(eq(staffSessions.id, session.id));
      await tx.update(staffAccounts).set({ lastLoginAt: now() }).where(eq(staffAccounts.id, a.id));
      await audit(tx, { actorType: "STAFF", actorId: a.id, action: "staff.login", entityType: "staff", entityId: a.id });
      return { sessionId: session.id };
    });
    const [s] = await tx.select().from(staffSessions).where(eq(staffSessions.id, r.sessionId));
    if (!s || s.revokedAt || s.authVersion !== a.authVersion || s.idleExpiresAt <= now() || s.absoluteExpiresAt <= now()) return null;
    return { token };
  });
  if (!result) {
    if (!await consumeLoginAttempt(v.email)) throw fail.throttled();
    throw new AppError("UNAUTHENTICATED", "Email or password is incorrect.");
  }
  return result;
}

export async function logoutStaff(actor: StaffPrincipal, key: string) {
  return withTx(async tx => {
    const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, actor.id)).for("update");
    if (!a || a.status !== "ACTIVE" || a.trashedAt || a.authVersion !== actor.authVersion) throw fail.unauth();
    return once(tx, `logout:${actor.id}:${actor.sessionId}`, key, {}, async () => {
      await tx.update(staffSessions).set({ revokedAt: now() }).where(and(eq(staffSessions.id, actor.sessionId), eq(staffSessions.staffId, actor.id), isNull(staffSessions.revokedAt)));
      await audit(tx, { actorType: "STAFF", actorId: actor.id, action: "staff.logout", entityType: "staff", entityId: actor.id });
      return { ok: true };
    });
  });
}
