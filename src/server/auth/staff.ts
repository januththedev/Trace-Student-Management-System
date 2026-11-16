import "server-only";
import { cookies, headers } from "next/headers";
import { and, eq, isNull, gt } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { staffAccounts, staffScopes, staffSessions } from "@/db/schema";
import { hashToken, newToken, safeEqual } from "@/lib/crypto";
import { now } from "@/lib/time";
import { fail } from "@/server/http";
import { CAPABILITIES, type Capability, type StaffPrincipal } from "./policy";

export const STAFF_COOKIE = "t2t_staff";
const IDLE_MS = 8 * 60 * 60 * 1000;      // 8h idle
const ABS_MS = 7 * 24 * 60 * 60 * 1000;  // 7d absolute

export async function createStaffSession(tx: DbOrTx, staffId: string, authVersion: number) {
  const token = newToken();
  const t = now();
  const [s] = await tx.insert(staffSessions).values({
    staffId, tokenHash: hashToken(token, "staff-session"), authVersion, csrfSecret: newToken(24),
    idleExpiresAt: new Date(t.getTime() + IDLE_MS), absoluteExpiresAt: new Date(t.getTime() + ABS_MS),
  }).returning();
  return { token, session: s };
}

export async function setStaffCookie(token: string) {
  (await cookies()).set(STAFF_COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: ABS_MS / 1000,
  });
}

export async function clearStaffCookie() {
  (await cookies()).delete(STAFF_COOKIE);
}

/**
 * Resolve the staff principal from the cookie, checking authoritative storage on every
 * request: session not revoked/expired, account ACTIVE and not trashed, auth_version current.
 * Role/scope changes therefore apply on the very next request.
 */
export async function loadStaffPrincipal(token: string | undefined): Promise<StaffPrincipal | null> {
  if (!token) return null;
  const t = now();
  const [row] = await db()
    .select({ s: staffSessions, a: staffAccounts })
    .from(staffSessions)
    .innerJoin(staffAccounts, eq(staffAccounts.id, staffSessions.staffId))
    .where(and(eq(staffSessions.tokenHash, hashToken(token, "staff-session")), isNull(staffSessions.revokedAt), gt(staffSessions.idleExpiresAt, t), gt(staffSessions.absoluteExpiresAt, t)));
  if (!row) return null;
  const { s, a } = row;
  if (a.status !== "ACTIVE" || a.trashedAt || s.authVersion !== a.authVersion) return null;
  const scopes = await db().select({ programmeId: staffScopes.programmeId, intakeId: staffScopes.intakeId }).from(staffScopes).where(eq(staffScopes.staffId, a.id));
  // Sliding idle expiry, at most once a minute.
  if (t.getTime() - s.lastSeenAt.getTime() > 60_000) {
    await db().update(staffSessions).set({ lastSeenAt: t, idleExpiresAt: new Date(Math.min(t.getTime() + IDLE_MS, s.absoluteExpiresAt.getTime())) }).where(eq(staffSessions.id, s.id));
  }
  return {
    kind: "staff", id: a.id, name: a.name, email: a.email, role: a.role,
    capabilities: new Set(a.capabilities.filter((c): c is Capability => (CAPABILITIES as readonly string[]).includes(c))),
    scopes, authVersion: a.authVersion, sessionId: s.id, csrfSecret: s.csrfSecret,
  };
}

/** For server components/pages: principal or null. */
export async function currentStaff(): Promise<StaffPrincipal | null> {
  return loadStaffPrincipal((await cookies()).get(STAFF_COOKIE)?.value);
}

/** For route handlers. Mutating methods must carry the session CSRF token in `x-csrf-token`. */
export async function requireStaff(req?: Request): Promise<StaffPrincipal> {
  const p = await currentStaff();
  if (!p) throw fail.unauth();
  if (req && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const h = req.headers.get("x-csrf-token") ?? "";
    if (!safeEqual(h, p.csrfSecret)) throw fail.forbidden();
    await assertSameOrigin(req);
  }
  return p;
}

export async function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients; CSRF token still required
  const host = (await headers()).get("host");
  try {
    if (new URL(origin).host !== host) throw fail.forbidden();
  } catch {
    throw fail.forbidden();
  }
}

/** Revoke every session of a staff member (deactivation/Trash/role change). */
export async function revokeAllStaffSessions(tx: DbOrTx, staffId: string) {
  await tx.update(staffSessions).set({ revokedAt: now() }).where(and(eq(staffSessions.staffId, staffId), isNull(staffSessions.revokedAt)));
}
