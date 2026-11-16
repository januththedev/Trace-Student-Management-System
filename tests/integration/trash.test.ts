import { beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";
import { db, withTx } from "@/db/client";
import { auditEvents, enrolments, instalments, intakes, jobRuns, paymentEvents, programmes, staffAccounts, staffInvitations, staffScopes, studentSessions } from "@/db/schema";
import { hashToken } from "@/lib/crypto";
import { assertOperational, enrolmentInScope } from "@/server/auth/policy";
import { createStaffSession, loadStaffPrincipal } from "@/server/auth/staff";
import { acceptInvitation, inviteStaff } from "@/server/services/governance";
import { listTrash, mutateTrash, RETENTION_MS } from "@/server/services/trash";
import { runPurgeJob } from "@/server/services/trash/purge";
import { GET as purgeGet, POST as purgePost } from "@/app/api/cron/purge/route";

const key = () => randomUUID();
let assetDirectory: string;
let assetPrefix: string;
beforeEach(async () => {
  await resetDb(); pinNow("2026-11-15T12:00:00Z");
  assetPrefix = `/.retention-test-${randomUUID()}`;
  assetDirectory = path.join(process.cwd(), "public", assetPrefix.slice(1));
  await mkdir(assetDirectory, { recursive: true });
});
afterEach(async () => { unpinNow(); await rm(assetDirectory, { recursive: true, force: true }); });
afterAll(closeDb);

async function fixture() {
  const actor = principalOf(await makeStaff("SUPER_ADMIN"));
  const bannerPath = `${assetPrefix}/banner.webp`;
  await writeFile(path.join(assetDirectory, "banner.webp"), "synthetic banner");
  const p = await makeProgramme({ bannerPath, description: "Disposable description" });
  const i = await makeIntake(p.id);
  return { actor, p, i, bannerPath };
}

describe("30-day retention against Postgres", () => {
  it("supports authenticated scheduler GET and operator POST, failing closed without the cron secret", async () => {
    const previous = process.env.CRON_SECRET;
    const context = { params: Promise.resolve({}) };
    try {
      delete process.env.CRON_SECRET;
      expect((await purgeGet(new NextRequest("http://localhost/api/cron/purge"), context)).status).toBe(401);
      process.env.CRON_SECRET = "integration-cron-secret";
      expect((await purgePost(new NextRequest("http://localhost/api/cron/purge", { method: "POST", headers: { authorization: "Bearer incorrect" } }), context)).status).toBe(401);
      const { actor, p } = await fixture();
      await mutateTrash(actor, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Scheduler test" }, key());
      pinNow("2026-12-15T12:00:00Z");
      const response = await purgeGet(new NextRequest("http://localhost/api/cron/purge", { headers: { authorization: "Bearer integration-cron-secret" } }), context);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toMatchObject({ processed: 1, failed: 0 });
      const replay = await purgePost(new NextRequest("http://localhost/api/cron/purge", { method: "POST", headers: { authorization: "Bearer integration-cron-secret" } }), context);
      expect(await replay.json()).toMatchObject({ processed: 0, failed: 0 });
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
    }
  });
  it("restores strictly before the deadline and refuses at/after it even if cleanup is late", async () => {
    const { actor, p } = await fixture();
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Pause" }, key());
    const [trashed] = await db().select().from(programmes).where(eq(programmes.id, p.id));
    expect(trashed.purgeAfter!.getTime() - trashed.trashedAt!.getTime()).toBe(RETENTION_MS);
    pinNow(new Date(trashed.purgeAfter!.getTime() - 1).toISOString());
    expect((await listTrash(actor)).records[0].canRestore).toBe(true);
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 2, action: "restore", reason: "Return" }, key());
    const [restored] = await db().select().from(programmes).where(eq(programmes.id, p.id));
    expect(restored.bannerPath).toBe(p.bannerPath);
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 3, action: "trash", reason: "Pause again" }, key());
    const [again] = await db().select().from(programmes).where(eq(programmes.id, p.id));
    pinNow(again.purgeAfter!.toISOString());
    expect((await listTrash(actor)).records[0].canRestore).toBe(false);
    await expect(mutateTrash(actor, { kind: "programme", id: p.id, version: 4, action: "restore", reason: "Too late" }, key())).rejects.toMatchObject({ code: "CONFLICT" });
    pinNow(new Date(again.purgeAfter!.getTime() + 1).toISOString());
    await expect(mutateTrash(actor, { kind: "programme", id: p.id, version: 4, action: "restore", reason: "Still late" }, key())).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("parent Trash suspends enrolments, revokes student sessions, and preserves independent child Trash", async () => {
    const { actor, p, i } = await fixture();
    const child = await makeIntake(p.id);
    const s = await makeStudent();
    const { enrolment: e } = await makeEnrolment(s.id, i.id, [{ amountMinor: 10000, dueDate: "2026-11-01" }]);
    await db().insert(studentSessions).values({ tokenHash: hashToken("test-student", "student-session"), studentId: s.id, enrolmentId: e.id, csrfSecret: "test", idleExpiresAt: new Date("2026-11-16"), absoluteExpiresAt: new Date("2026-11-16") });
    await mutateTrash(actor, { kind: "intake", id: child.id, version: 1, action: "trash", reason: "Independent pause" }, key());
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Parent pause" }, key());
    const [untouched] = await db().select().from(intakes).where(eq(intakes.id, i.id));
    expect(untouched.trashedAt).toBeNull();
    const [session] = await db().select().from(studentSessions);
    expect(session.revokedAt).not.toBeNull();
    function operationalError() { return withTx(async tx => assertOperational(await enrolmentInScope(tx, actor, e.id))); }
    await expect(operationalError()).rejects.toMatchObject({ code: "CONFLICT" });
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 2, action: "restore", reason: "Parent returns" }, key());
    await expect(operationalError()).resolves.toBeUndefined();
    const [independent] = await db().select().from(intakes).where(eq(intakes.id, child.id));
    expect(independent.trashedAt).not.toBeNull();
    const [stillRevoked] = await db().select().from(studentSessions);
    expect(stillRevoked.revokedAt).not.toBeNull();
  });

  it("staff restore rechecks the cap and explicit restore-as-Admin is audited without reviving access", async () => {
    const { actor } = await fixture();
    const a = await makeStaff("SUPER_ADMIN");
    const session = await withTx(tx => createStaffSession(tx, a.id, 1));
    const invitation = await inviteStaff(principalOf(a), { email: "pending@example.test", name: "Pending", role: "ADMIN" }, key());
    await mutateTrash(actor, { kind: "staff", id: a.id, version: 1, action: "trash", reason: "Staff leave" }, key());
    expect(await loadStaffPrincipal(session.token)).toBeNull();
    await makeStaff("SUPER_ADMIN"); await makeStaff("SUPER_ADMIN");
    await expect(mutateTrash(actor, { kind: "staff", id: a.id, version: 2, action: "restore", reason: "Return" }, key())).rejects.toMatchObject({ code: "CONFLICT" });
    await mutateTrash(actor, { kind: "staff", id: a.id, version: 2, action: "restore-as-admin", reason: "Explicitly confirmed Admin role" }, key());
    const [restored] = await db().select().from(staffAccounts).where(eq(staffAccounts.id, a.id));
    expect(restored.role).toBe("ADMIN"); expect(restored.status).toBe("ACTIVE");
    expect(await loadStaffPrincipal(session.token)).toBeNull();
    await expect(acceptInvitation({ token: invitation.token, password: "a-test-password-1234" }, key())).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db().select().from(auditEvents)).some(e => e.action === "staff.restore-as-admin")).toBe(true);
  });

  it("purges only disposable fields and keeps enrolments, instalments, payments and audits", async () => {
    const { actor, p, i, bannerPath } = await fixture();
    const s = await makeStudent();
    const e = await makeEnrolment(s.id, i.id, [{ amountMinor: 10000, dueDate: "2026-11-01" }]);
    await db().insert(paymentEvents).values({ enrolmentId: e.enrolment.id, kind: "RECEIPT", amountMinor: 10000, effectiveDate: "2026-11-15" });
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Retire" }, key());
    pinNow("2026-12-15T12:00:00Z");
    expect(await runPurgeJob()).toMatchObject({ processed: 1, failed: 0 });
    const [purged] = await db().select().from(programmes).where(eq(programmes.id, p.id));
    expect(purged).toMatchObject({ id: p.id, name: `Purged programme ${p.code}`, description: "", bannerPath: null, purgeStatus: "PURGED" });
    expect(await db().select().from(enrolments)).toHaveLength(1);
    expect(await db().select().from(instalments)).toHaveLength(1);
    expect(await db().select().from(paymentEvents)).toHaveLength(1);
    expect((await db().select().from(auditEvents)).length).toBeGreaterThanOrEqual(2);
    await expect(readFile(path.join(process.cwd(), "public", bannerPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runPurgeJob()).toMatchObject({ processed: 0, failed: 0 });
    expect((await db().select().from(jobRuns)).every(j => j.status === "SUCCEEDED")).toBe(true);
  });

  it("does not delete banners referenced by active or historical records, including on retries", async () => {
    const { actor, p, bannerPath } = await fixture();
    const historical = await makeProgramme({ bannerPath, status: "ARCHIVED" });
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Retire first" }, key());
    pinNow("2026-12-16T12:00:00Z");
    expect(await runPurgeJob()).toMatchObject({ processed: 1, failed: 0 });
    expect(await runPurgeJob()).toMatchObject({ processed: 0, failed: 0 });
    expect(await readFile(path.join(assetDirectory, "banner.webp"), "utf8")).toBe("synthetic banner");
    const [h] = await db().select().from(programmes).where(eq(programmes.id, historical.id));
    expect(h.bannerPath).toBe(bannerPath);
    // An intake reference also protects a path after the final programme reference is cleared.
    await makeIntake(h.id, { bannerPath });
    await mutateTrash(actor, { kind: "programme", id: h.id, version: 1, action: "trash", reason: "Retire second" }, key());
    pinNow("2027-01-16T12:00:00Z");
    expect(await runPurgeJob()).toMatchObject({ processed: 1, failed: 0 });
    expect(await readFile(path.join(assetDirectory, "banner.webp"), "utf8")).toBe("synthetic banner");
  });

  it("restore-versus-purge race cannot delete a restored banner", async () => {
    const { actor, p } = await fixture();
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Pause" }, key());
    pinNow("2026-12-15T11:59:59.999Z");
    const results = await Promise.allSettled([
      mutateTrash(actor, { kind: "programme", id: p.id, version: 2, action: "restore", reason: "Just in time" }, key()),
      runPurgeJob(),
    ]);
    expect(results.every(r => r.status === "fulfilled")).toBe(true);
    pinNow("2026-12-15T12:00:01Z");
    expect(await runPurgeJob()).toMatchObject({ processed: 0, failed: 0 });
    expect(await readFile(path.join(assetDirectory, "banner.webp"), "utf8")).toBe("synthetic banner");
    const [r] = await db().select().from(programmes).where(eq(programmes.id, p.id));
    expect(r.trashedAt).toBeNull();
  });

  it("claims due records with SKIP LOCKED while a competing transaction owns the row", async () => {
    const { actor, p } = await fixture();
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Pause" }, key());
    pinNow("2026-12-16T12:00:00Z");
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(r => { locked = r; });
    const gate = new Promise<void>(r => { release = r; });
    const holding = withTx(async tx => { await tx.select().from(programmes).where(eq(programmes.id, p.id)).for("update"); locked(); await gate; });
    await ready;
    try { expect(await runPurgeJob()).toMatchObject({ processed: 0, failed: 0 }); }
    finally { release(); await holding; }
    expect(await runPurgeJob()).toMatchObject({ processed: 1, failed: 0 });
  });

  it("records cleanup failures visibly and retries without deleting a referenced asset", async () => {
    const { actor, p, bannerPath } = await fixture();
    const bad = `${assetPrefix}/not-a-file`;
    await mkdir(path.join(assetDirectory, "not-a-file"));
    await db().update(programmes).set({ bannerPath: bad }).where(eq(programmes.id, p.id));
    await mutateTrash(actor, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Retire" }, key());
    pinNow("2026-12-16T12:00:00Z");
    expect(await runPurgeJob()).toMatchObject({ processed: 0, failed: 1 });
    const [failed] = await db().select().from(programmes).where(eq(programmes.id, p.id));
    expect(failed).toMatchObject({ bannerPath: bad, purgeStatus: "FAILED" });
    expect((await listTrash(actor)).jobs[0].status).toBe("FAILED");
    const holder = await makeProgramme({ bannerPath });
    await db().update(programmes).set({ bannerPath }).where(eq(programmes.id, p.id));
    expect(await runPurgeJob()).toMatchObject({ processed: 1, failed: 0 });
    expect(await readFile(path.join(assetDirectory, "banner.webp"), "utf8")).toBe("synthetic banner");
    expect((await db().select().from(programmes).where(eq(programmes.id, holder.id)))[0].bannerPath).toBe(bannerPath);
  });

  it("purges staff credentials/capabilities/scopes while keeping the staff tombstone and invitations", async () => {
    const { actor, p } = await fixture();
    const a = await makeStaff("ADMIN", { capabilities: ["fees.adjust"], scopes: [{ programmeId: p.id }] });
    await db().update(staffAccounts).set({ passwordHash: "disposable-password-hash" }).where(eq(staffAccounts.id, a.id));
    await mutateTrash(actor, { kind: "staff", id: a.id, version: 1, action: "trash", reason: "Account closed" }, key());
    pinNow("2026-12-15T12:00:00Z");
    expect(await runPurgeJob()).toMatchObject({ processed: 1, failed: 0 });
    const [purged] = await db().select().from(staffAccounts).where(eq(staffAccounts.id, a.id));
    expect(purged).toMatchObject({ email: `purged-${a.id}@invalid`, passwordHash: null, capabilities: [], purgeStatus: "PURGED" });
    expect(await db().select().from(staffScopes).where(eq(staffScopes.staffId, a.id))).toHaveLength(0);
    expect(await db().select().from(staffInvitations)).toHaveLength(0);
    expect((await db().select().from(auditEvents)).some(e => e.entityId === a.id && e.action === "staff.purge")).toBe(true);
  });

  it("rejects Admin Trash access and stale versions; there is no public purge operation", async () => {
    const { actor, p } = await fixture();
    const admin = principalOf(await makeStaff("ADMIN"));
    await expect(listTrash(admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mutateTrash(admin, { kind: "programme", id: p.id, version: 1, action: "trash", reason: "Forbidden" }, key())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mutateTrash(actor, { kind: "programme", id: p.id, version: 2, action: "trash", reason: "Stale" }, key())).rejects.toMatchObject({ code: "STALE" });
  });
});
