import { beforeEach, afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { and, eq, isNull, sql } from "drizzle-orm";
import { closeDb, makeProgramme, makeStaff, pinNow, principalOf, resetDb, unpinNow } from "./helpers";
import { db, withTx } from "@/db/client";
import { auditEvents, governanceLock, staffAccounts, staffInvitations, staffSessions } from "@/db/schema";
import { hashPassword } from "@/lib/crypto";
import { createStaffSession, loadStaffPrincipal } from "@/server/auth/staff";
import { acceptInvitation, bootstrapSuperAdmin, changeStaffStatus, editStaff, invitationDetails, inviteStaff } from "@/server/services/governance";
import { LOGIN_ATTEMPTS, loginStaff, logoutStaff } from "@/server/services/governance/auth";
import { assertPublicOrigin } from "@/server/services/governance/public-origin";
import { mutateTrash } from "@/server/services/trash";

const key = () => randomUUID();
const password = "a-test-password-1234";
const edit = (a: typeof staffAccounts.$inferSelect) => ({ id: a.id, version: a.version, role: "SUPER_ADMIN" as const, capabilities: [], scopes: [], reason: "Governance integration test" });
async function countSuper() {
  const [r] = await db().select({ n: sql<number>`count(*)::int` }).from(staffAccounts).where(and(eq(staffAccounts.role, "SUPER_ADMIN"), eq(staffAccounts.status, "ACTIVE"), isNull(staffAccounts.trashedAt)));
  return r.n;
}

beforeEach(async () => { await resetDb(); pinNow("2026-11-15T12:00:00Z"); });
afterEach(unpinNow);
afterAll(closeDb);

describe("staff governance against Postgres", () => {
  it("allows the actual browser Host with an internal Next URL and refuses cross-site login", () => {
    expect(() => assertPublicOrigin(new Request("http://localhost:3102/api/staff/auth/login", { headers: { host: "127.0.0.1:3102", origin: "http://127.0.0.1:3102" } }))).not.toThrow();
    expect(() => assertPublicOrigin(new Request("http://localhost:3102/api/staff/auth/login", { headers: { host: "127.0.0.1:3102", origin: "https://attacker.example" } }))).toThrow();
    expect(() => assertPublicOrigin(new Request("http://localhost:3102/api/staff/auth/login", { headers: { "sec-fetch-site": "cross-site" } }))).toThrow();
  });
  it("bootstraps exactly once under concurrency and refuses a rerun after deactivation", async () => {
    const outcomes = await Promise.allSettled([1, 2].map(n => bootstrapSuperAdmin({ email: `root${n}@example.test`, name: "Root", password })));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await countSuper()).toBe(1);
    await db().update(staffAccounts).set({ status: "DEACTIVATED" });
    await expect(bootstrapSuperAdmin({ email: "again@example.test", name: "Root", password })).rejects.toMatchObject({ code: "CONFLICT" });
    const [lock] = await db().select().from(governanceLock);
    expect(lock.bootstrappedAt).not.toBeNull();
  });

  it("runs the exact operator CLI with a password supplied only through the environment", async () => {
    const result = spawnSync(process.platform === "win32" ? "node.exe" : "node", ["--import", "tsx", "scripts/bootstrap-super-admin.ts", "--email", "operator@example.test", "--name", "Operator"], {
      // Windows process startup can exceed 20s while several agents build concurrently.
      cwd: process.cwd(), windowsHide: true, encoding: "utf8", env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, T2T_BOOTSTRAP_PASSWORD: password }, timeout: 60000,
    });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
    expect(result.stdout).toContain("Bootstrapped Super Admin");
    expect(await countSuper()).toBe(1);
  }, 90000);

  it("serializes concurrent promotions, reactivations and restores at three", async () => {
    const root = principalOf(await makeStaff("SUPER_ADMIN"));
    const admins = await Promise.all([makeStaff("ADMIN"), makeStaff("ADMIN")]);
    const dormant = await Promise.all([makeStaff("SUPER_ADMIN"), makeStaff("SUPER_ADMIN")]);
    for (const a of dormant) await db().update(staffAccounts).set({ status: "DEACTIVATED" }).where(eq(staffAccounts.id, a.id));
    const trashed = await makeStaff("SUPER_ADMIN");
    await db().update(staffAccounts).set({ status: "DEACTIVATED", trashedAt: new Date("2026-11-14"), purgeAfter: new Date("2026-12-14"), purgeStatus: "PENDING" }).where(eq(staffAccounts.id, trashed.id));
    const result = await Promise.allSettled([
      ...admins.map(a => editStaff(root, edit(a), key())),
      ...dormant.map(a => changeStaffStatus(root, { id: a.id, version: 1, action: "reactivate", reason: "Activate" }, key())),
      mutateTrash(root, { kind: "staff", id: trashed.id, version: 1, action: "restore", reason: "Restore" }, key()),
    ]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(await countSuper()).toBe(3);
  });

  it("concurrent self-removals and demotions cannot leave zero active Super Admins", async () => {
    const accounts = await Promise.all([makeStaff("SUPER_ADMIN"), makeStaff("SUPER_ADMIN"), makeStaff("SUPER_ADMIN")]);
    const results = await Promise.allSettled(accounts.map((a, n) => n === 0
      ? editStaff(principalOf(a), { ...edit(a), role: "ADMIN" }, key())
      : n === 1 ? changeStaffStatus(principalOf(a), { id: a.id, version: 1, action: "deactivate", reason: "Own account" }, key())
      : mutateTrash(principalOf(a), { kind: "staff", id: a.id, version: 1, action: "trash", reason: "Own account" }, key())));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(await countSuper()).toBe(1);
  });

  it("rechecks invitation capacity atomically and never changes the requested role", async () => {
    const actor = principalOf(await makeStaff("SUPER_ADMIN"));
    const invites = await Promise.all([1, 2, 3, 4].map(n => inviteStaff(actor, { email: `invite${n}@example.test`, name: `Invite ${n}`, role: "SUPER_ADMIN" }, key())));
    const results = await Promise.allSettled(invites.map(i => acceptInvitation({ token: i.token, password }, key())));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(await countSuper()).toBe(3);
    expect(await db().select().from(staffAccounts).where(eq(staffAccounts.role, "ADMIN"))).toHaveLength(0);
    await expect(inviteStaff(actor, { email: "full@example.test", name: "Full", role: "SUPER_ADMIN" }, key())).rejects.toMatchObject({ code: "CONFLICT" });
    const stored = await db().select().from(staffInvitations);
    expect(stored.every(i => !invites.some(v => v.token === i.tokenHash))).toBe(true);
  });

  it("invites are single-use, expire after seven days and replay issuance without storing raw tokens", async () => {
    const actor = principalOf(await makeStaff("SUPER_ADMIN"));
    const k = key();
    const input = { email: "new@example.test", name: "New", role: "ADMIN" as const };
    const i = await inviteStaff(actor, input, k);
    expect(await inviteStaff(actor, input, k)).toEqual(i);
    const acceptanceKey = key();
    const accepted = await acceptInvitation({ token: i.token, password }, acceptanceKey);
    expect(await acceptInvitation({ token: i.token, password }, acceptanceKey)).toEqual(accepted);
    await expect(acceptInvitation({ token: i.token, password }, key())).rejects.toMatchObject({ code: "CONFLICT" });
    const next = await inviteStaff(actor, { ...input, email: "expire@example.test" }, key());
    pinNow(next.expiresAt);
    await expect(acceptInvitation({ token: next.token, password }, key())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(invitationDetails(next.token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(await db().query.idempotencyRecords.findMany())).not.toContain(i.token);
  });

  it("deactivation invalidates an open session and reactivation never revives it", async () => {
    const root = principalOf(await makeStaff("SUPER_ADMIN"));
    const admin = await makeStaff("ADMIN");
    const s = await withTx(tx => createStaffSession(tx, admin.id, admin.authVersion));
    expect(await loadStaffPrincipal(s.token)).not.toBeNull();
    await changeStaffStatus(root, { id: admin.id, version: 1, action: "deactivate", reason: "Leave" }, key());
    expect(await loadStaffPrincipal(s.token)).toBeNull();
    await changeStaffStatus(root, { id: admin.id, version: 2, action: "reactivate", reason: "Return" }, key());
    expect(await loadStaffPrincipal(s.token)).toBeNull();
    const [session] = await db().select().from(staffSessions).where(eq(staffSessions.id, s.session.id));
    expect(session.revokedAt).not.toBeNull();
  });

  it("role/scope/capability changes take effect on the next request; stale actors are refused", async () => {
    const root = principalOf(await makeStaff("SUPER_ADMIN"));
    const a = await makeStaff("ADMIN");
    const p = await makeProgramme();
    const s = await withTx(tx => createStaffSession(tx, a.id, a.authVersion));
    await editStaff(root, { ...edit(a), role: "ADMIN", scopes: [{ programmeId: p.id, intakeId: null }], capabilities: ["fees.adjust"] }, key());
    expect(await loadStaffPrincipal(s.token)).toBeNull();
    const fresh = await withTx(tx => createStaffSession(tx, a.id, 2));
    const principal = await loadStaffPrincipal(fresh.token);
    expect(principal?.scopes).toEqual([{ programmeId: p.id, intakeId: null }]);
    expect(principal?.capabilities.has("fees.adjust")).toBe(true);
    await expect(inviteStaff(principalOf(a), { email: "bad@example.test", name: "Bad", role: "ADMIN" }, key())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("checks versions and idempotency, and does not trust a forged Super Admin principal", async () => {
    const root = principalOf(await makeStaff("SUPER_ADMIN"));
    const a = await makeStaff("ADMIN");
    const k = key();
    const v = { ...edit(a), role: "ADMIN" as const };
    const first = await editStaff(root, v, k);
    expect(await editStaff(root, v, k)).toEqual(first);
    await expect(editStaff(root, { ...v, reason: "Different" }, k)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(editStaff(root, v, key())).rejects.toMatchObject({ code: "STALE" });
    const current = await db().query.staffAccounts.findFirst({ where: eq(staffAccounts.id, a.id) });
    await expect(inviteStaff({ ...principalOf(current!), role: "SUPER_ADMIN" }, { email: "forged@example.test", name: "Forged", role: "ADMIN" }, key())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("logs in, replays without extra sessions, and revokes the current session on logout", async () => {
    const a = await makeStaff("SUPER_ADMIN");
    await db().update(staffAccounts).set({ passwordHash: await hashPassword(password) }).where(eq(staffAccounts.id, a.id));
    const k = key();
    const s = await loginStaff({ email: a.email.toUpperCase(), password }, k);
    expect(await loginStaff({ email: a.email, password }, k)).toEqual(s);
    expect(await db().select().from(staffSessions)).toHaveLength(1);
    const principal = await loadStaffPrincipal(s.token);
    expect(principal?.id).toBe(a.id);
    await logoutStaff(principal!, key());
    expect(await loadStaffPrincipal(s.token)).toBeNull();
    expect((await db().select().from(auditEvents)).some(e => e.action === "staff.logout")).toBe(true);
  });

  it("persists failed-login rate limits and uses one generic credential error", async () => {
    const input = { email: "unknown@example.test", password: "wrong" };
    for (let n = 0; n < LOGIN_ATTEMPTS; n++) await expect(loginStaff(input, key())).rejects.toMatchObject({ code: "UNAUTHENTICATED", message: "Email or password is incorrect." });
    await expect(loginStaff(input, key())).rejects.toMatchObject({ code: "THROTTLED" });
    pinNow("2026-11-15T12:16:00Z");
    await expect(loginStaff(input, key())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
