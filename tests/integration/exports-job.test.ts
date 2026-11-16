import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, exportJobs, staffAccounts, staffScopes } from "@/db/schema";
import { objectStore } from "@/server/storage";
import { createExportJob, downloadExportJob, runExportJobs, cleanupExpiredExports } from "@/server/services/reports/export-jobs";
import { GET as cron } from "@/app/api/cron/exports/route";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";

const keys = new Set<string>();
async function cleanObjects() {
  for (const key of keys) await objectStore().delete(key);
  keys.clear();
}
beforeEach(async () => { await cleanObjects(); await resetDb(); pinNow("2026-06-15T06:30:00Z"); });
afterAll(async () => { await cleanObjects(); unpinNow(); await closeDb(); });

async function fixture() {
  const programme = await makeProgramme();
  const intake = await makeIntake(programme.id);
  const student = await makeStudent({ fullName: "Export Visible Student" });
  await makeEnrolment(student.id, intake.id, [{ amountMinor: 100_000, dueDate: "2026-06-01" }]);
  const a = await makeStaff("ADMIN", { capabilities: ["exports.download"], scopes: [{ programmeId: programme.id }] });
  return { p: principalOf(a, [{ programmeId: programme.id }]), programme, student };
}
async function queue(p: Parameters<typeof createExportJob>[0], key = "export-job-first") {
  const job = await createExportJob(p, { report: "students" }, key);
  keys.add(`exports/${job.id}.csv`);
  return job;
}

describe("private background exports", () => {
  it("queues idempotently, generates scoped CSV once, and delivers an audited private stream", async () => {
    const { p, student } = await fixture();
    const otherIntake = await makeIntake((await makeProgramme()).id);
    const hidden = await makeStudent({ fullName: "Export Hidden Student" });
    await makeEnrolment(hidden.id, otherIntake.id, []);
    const job = await queue(p);
    expect((await queue(p)).id).toBe(job.id);
    await expect(createExportJob(p, { report: "credits" }, "export-job-first")).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    expect((await downloadExportJob(p, job.id)).status).toBe(202);
    const runs = await Promise.all([runExportJobs(), runExportJobs()]);
    expect(runs.reduce((n, r) => n + r.processed, 0)).toBe(1);
    expect(runs.reduce((n, r) => n + r.failed, 0)).toBe(0);
    const response = await downloadExportJob(p, job.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("text/csv");
    const text = await response.text();
    expect(text).toContain(student.ref);
    expect(text).not.toContain(hidden.ref);
    expect(text).not.toContain(student.nic);
    const [stored] = await db().select().from(exportJobs).where(eq(exportJobs.id, job.id));
    expect(stored.expiresAt?.toISOString()).toBe("2026-06-15T06:45:00.000Z");
    const audit = await db().select().from(auditEvents).where(eq(auditEvents.entityId, job.id));
    expect(audit.map(a => a.action)).toEqual(expect.arrayContaining(["export.queued", "export.generated", "export.delivered"]));
  });

  it("rechecks CURRENT capability after CSV generation even when passed a stale principal", async () => {
    const { p } = await fixture();
    const job = await queue(p);
    expect((await runExportJobs()).processed).toBe(1);
    await db().update(staffAccounts).set({ capabilities: [] }).where(eq(staffAccounts.id, p.id));
    await expect(downloadExportJob(p, job.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rechecks permission before generation and does not create an object after revocation", async () => {
    const { p } = await fixture();
    const job = await queue(p);
    await db().update(staffAccounts).set({ capabilities: [] }).where(eq(staffAccounts.id, p.id));
    expect(await runExportJobs()).toMatchObject({ processed: 0, failed: 1 });
    expect(await objectStore().exists(`exports/${job.id}.csv`)).toBe(false);
    const [stored] = await db().select().from(exportJobs).where(eq(exportJobs.id, job.id));
    expect(stored.status).toBe("FAILED");
  });

  it("rejects existing files after scope removal and rejects other owners", async () => {
    const { p } = await fixture();
    const job = await queue(p);
    await runExportJobs();
    const other = principalOf(await makeStaff("SUPER_ADMIN"));
    await expect(downloadExportJob(other, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().delete(staffScopes).where(eq(staffScopes.staffId, p.id));
    await expect(downloadExportJob(p, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("denies stale sessions and deactivated requesters", async () => {
    const { p } = await fixture();
    const job = await queue(p);
    await runExportJobs();
    await db().update(staffAccounts).set({ authVersion: p.authVersion + 1 }).where(eq(staffAccounts.id, p.id));
    await expect(downloadExportJob(p, job.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await db().update(staffAccounts).set({ status: "DEACTIVATED" }).where(eq(staffAccounts.id, p.id));
    await expect(createExportJob(p, { report: "students" }, "revoked-session")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("expires at the exact 15-minute boundary and cleans private bytes without deleting history", async () => {
    const { p } = await fixture();
    const job = await queue(p);
    await runExportJobs();
    pinNow("2026-06-15T06:44:59.999Z");
    expect((await downloadExportJob(p, job.id)).status).toBe(200);
    pinNow("2026-06-15T06:45:00Z");
    await expect(downloadExportJob(p, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await cleanupExpiredExports()).toBe(1);
    expect(await cleanupExpiredExports()).toBe(0);
    expect(await objectStore().exists(`exports/${job.id}.csv`)).toBe(false);
    expect((await db().select().from(exportJobs).where(eq(exportJobs.id, job.id)))[0]).toMatchObject({ status: "SUCCEEDED", objectKey: null });
  });

  it("cleans objects left by crashed workers and expires abandoned queued jobs", async () => {
    const { p } = await fixture();
    const job = await queue(p);
    await objectStore().put(`exports/${job.id}.csv`, Buffer.from("incomplete"), "text/csv");
    pinNow("2026-06-16T06:30:00Z");
    expect(await cleanupExpiredExports()).toBe(1);
    expect(await objectStore().exists(`exports/${job.id}.csv`)).toBe(false);
    expect((await db().select().from(exportJobs).where(eq(exportJobs.id, job.id)))[0].status).toBe("FAILED");
  });

  it("requires export capability and restricts full identifiers to Super Admin", async () => {
    const { p } = await fixture();
    await expect(createExportJob(p, { report: "students", fullIdentifiers: true }, "full-identifiers")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const noCap = principalOf(await makeStaff("ADMIN"));
    await expect(queue(noCap)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createExportJob(p, { report: "students", asOf: "2026-02-30" }, "invalid-date")).rejects.toThrow();
    await expect(createExportJob(p, { report: "students", from: "2026-06-20", to: "2026-06-01" }, "invalid-range")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rechecks the Super Admin role before delivering a full-identifier export", async () => {
    const { student } = await fixture();
    const superRow = await makeStaff("SUPER_ADMIN");
    await makeStaff("SUPER_ADMIN");
    const p = principalOf(superRow);
    const job = await createExportJob(p, { report: "students", fullIdentifiers: true }, "super-identifiers");
    keys.add(`exports/${job.id}.csv`);
    expect((await runExportJobs()).processed).toBe(1);
    expect(await (await downloadExportJob(p, job.id)).text()).toContain(student.nic);
    await db().update(staffAccounts).set({ role: "ADMIN", capabilities: ["exports.download"] }).where(eq(staffAccounts.id, p.id));
    await expect(downloadExportJob(p, job.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("authenticates cron with CRON_SECRET before doing any work", async () => {
    const old = process.env.CRON_SECRET;
    try {
      process.env.CRON_SECRET = "test-export-cron-secret";
      const url = "http://localhost/api/cron/exports";
      expect((await cron(new NextRequest(url), { params: Promise.resolve({}) })).status).toBe(401);
      expect((await cron(new NextRequest(url, { headers: { authorization: "test-export-cron-secret" } }), { params: Promise.resolve({}) })).status).toBe(401);
      expect((await cron(new NextRequest(url, { headers: { authorization: "Bearer incorrect" } }), { params: Promise.resolve({}) })).status).toBe(401);
      const response = await cron(new NextRequest(url, { headers: { authorization: "Bearer test-export-cron-secret" } }), { params: Promise.resolve({}) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ processed: 0, failed: 0, cleaned: 0 });
    } finally {
      if (old === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
    }
  });
});
