import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/client";
import { auditEvents, jobRuns, receiptAssets, staffAccounts } from "@/db/schema";
import { getStorageUsage, refreshStorageUsage, refreshStorageUsageForStaff } from "@/server/services/storage-usage";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";

const original = {
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
  STORAGE_BUDGET_BYTES: process.env.STORAGE_BUDGET_BYTES,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION,
  S3_BUCKET: process.env.S3_BUCKET,
};

beforeEach(async () => {
  process.env.STORAGE_DRIVER = "s3";
  process.env.S3_ENDPOINT = "https://synthetic-storage.example.test";
  process.env.S3_REGION = "auto";
  process.env.S3_BUCKET = "synthetic-app-storage";
  delete process.env.STORAGE_BUDGET_BYTES;
  pinNow("2026-11-16T04:00:00Z");
  await resetDb();
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  unpinNow();
});
afterAll(closeDb);

async function superAdmin() { return principalOf(await makeStaff("SUPER_ADMIN")); }

describe("Super Admin storage capacity", () => {
  it("never presents unchecked storage as zero used or all capacity free", async () => {
    const usage = await getStorageUsage(await superAdmin());
    expect(usage).toMatchObject({ status: "not_checked", budgetBytes: 10_000_000_000, usedBytes: null, remainingBytes: null, measuredAt: null, objectCount: null });
  });

  it("denies ordinary Admin and freshly demoted or deactivated Super Admin access", async () => {
    const admin = principalOf(await makeStaff("ADMIN"));
    await expect(getStorageUsage(admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(refreshStorageUsageForStaff(admin, "storage-admin-001", undefined, { inventory: async () => ({ totalBytes: 1, objectCount: 1 }) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const p = await superAdmin();
    await db().update(staffAccounts).set({ role: "ADMIN" }).where(eq(staffAccounts.id, p.id));
    await expect(getStorageUsage(p)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(staffAccounts).set({ role: "SUPER_ADMIN", status: "DEACTIVATED" }).where(eq(staffAccounts.id, p.id));
    await expect(getStorageUsage(p)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await db().select().from(jobRuns)).toHaveLength(0);
  });

  it("uses the whole object inventory, persists a checked snapshot and avoids repeated listings", async () => {
    const p = await superAdmin();
    const inventory = vi.fn(async () => ({ totalBytes: 2_500_000_000, objectCount: 4512 }));
    expect((await refreshStorageUsage({ inventory })).state).toBe("refreshed");
    expect((await refreshStorageUsage({ inventory })).state).toBe("cached");
    const usage = await getStorageUsage(p);
    expect(usage).toMatchObject({ status: "ready", usedBytes: 2_500_000_000, remainingBytes: 7_500_000_000, objectCount: 4512, percentageUsed: 25, stale: false, lastCheckFailed: false, measuredAt: "2026-11-16T04:00:00.000Z" });
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(usage)).not.toContain("synthetic-app-storage");
    expect(JSON.stringify(usage)).not.toContain("example.test");
    expect((await db().select().from(jobRuns))).toHaveLength(1);
  });

  it("uses the current configured budget and shows zero remaining rather than negative capacity", async () => {
    process.env.STORAGE_BUDGET_BYTES = "1000000000";
    await refreshStorageUsage({ inventory: async () => ({ totalBytes: 1_500_000_000, objectCount: 20 }) });
    expect(await getStorageUsage(await superAdmin())).toMatchObject({ budgetBytes: 1_000_000_000, usedBytes: 1_500_000_000, remainingBytes: 0, percentageUsed: 150 });
    process.env.STORAGE_BUDGET_BYTES = "2000000000";
    expect(await getStorageUsage(await superAdmin())).toMatchObject({ remainingBytes: 500_000_000, percentageUsed: 75 });
  });

  it("invalidates measurements when the configured bucket changes", async () => {
    const p = await superAdmin();
    await refreshStorageUsage({ inventory: async () => ({ totalBytes: 100, objectCount: 1 }) });
    process.env.S3_BUCKET = "another-app-bucket";
    expect(await getStorageUsage(p)).toMatchObject({ status: "not_checked", usedBytes: null, remainingBytes: null });
    await refreshStorageUsage({ inventory: async () => ({ totalBytes: 200, objectCount: 2 }) });
    expect(await getStorageUsage(p)).toMatchObject({ usedBytes: 200, objectCount: 2 });
    expect(await db().select().from(jobRuns)).toHaveLength(2);
  });

  it("keeps prior verified figures but marks them stale after a failed check without persisting provider secrets", async () => {
    await refreshStorageUsage({ inventory: async () => ({ totalBytes: 400, objectCount: 3 }) });
    pinNow("2026-11-16T04:11:00Z");
    const result = await refreshStorageUsage({ inventory: async () => { throw new Error("secret-access-key=do-not-record private-bucket-host.example.test"); } });
    expect(result).toMatchObject({ state: "failed", usage: { status: "ready", usedBytes: 400, stale: true, lastCheckFailed: true, measuredAt: "2026-11-16T04:00:00.000Z" } });
    const history = JSON.stringify(await db().select().from(jobRuns));
    expect(history).not.toContain("do-not-record");
    expect(history).not.toContain("private-bucket-host");
    expect(history).toContain("Storage usage could not be checked");
    pinNow("2026-11-16T04:12:00Z");
    expect(await refreshStorageUsage({ inventory: async () => ({ totalBytes: 350, objectCount: 3 }) })).toMatchObject({ state: "refreshed", usage: { usedBytes: 350, stale: false, lastCheckFailed: false } });
  });

  it("shows unavailable without made-up remaining space when the first check fails or reports invalid totals", async () => {
    await refreshStorageUsage({ inventory: async () => ({ totalBytes: -1, objectCount: 3 }) });
    expect(await getStorageUsage(await superAdmin())).toMatchObject({ status: "unavailable", usedBytes: null, remainingBytes: null, lastCheckFailed: true });
    expect((await db().select().from(jobRuns))[0].status).toBe("FAILED");
  });

  it("marks a snapshot stale when daily monitoring has not refreshed it in 36 hours", async () => {
    const p = await superAdmin();
    await refreshStorageUsage({ inventory: async () => ({ totalBytes: 4, objectCount: 1 }) });
    pinNow("2026-11-17T16:01:00Z");
    expect(await getStorageUsage(p)).toMatchObject({ status: "ready", usedBytes: 4, stale: true, lastCheckFailed: false });
  });

  it("counts only reclaimed archival bytes after the recovery copy was actually removed", async () => {
    const p = await superAdmin();
    const programme = await makeProgramme();
    const intake = await makeIntake(programme.id);
    const student = await makeStudent();
    const { enrolment } = await makeEnrolment(student.id, intake.id, []);
    const [asset] = await db().insert(receiptAssets).values({
      enrolmentId: enrolment.id, objectKey: "receipts/synthetic/archive.gz",
      archiveOriginalKey: "receipts/synthetic/original.png", archiveEncoding: "gzip",
      archiveSizeBytes: 400, sizeBytes: 1000, sha256: "a".repeat(64), mime: "image/png",
      validation: "CLEAN", scan: "NOT_CONFIGURED", archivedAt: new Date("2026-10-15T00:00:00Z"),
    }).returning();
    expect(await getStorageUsage(p)).toMatchObject({ savedBytes: 0, archivedOriginals: 0 });
    await db().update(receiptAssets).set({ archiveOriginalDeletedAt: new Date("2026-10-16T00:00:00Z") }).where(eq(receiptAssets.id, asset.id));
    expect(await getStorageUsage(p)).toMatchObject({ savedBytes: 600, archivedOriginals: 1, usedBytes: null, remainingBytes: null });
    await refreshStorageUsage({ inventory: async () => ({ totalBytes: 550, objectCount: 2 }) });
    expect(await getStorageUsage(p)).toMatchObject({ savedBytes: 600, archivedOriginals: 1, usedBytes: 550, remainingBytes: 9_999_999_450 });
  });

  it("replays a manual refresh without another listing or audit and rechecks authorization before replay", async () => {
    const p = await superAdmin();
    const inventory = vi.fn(async () => ({ totalBytes: 800, objectCount: 9 }));
    const first = await refreshStorageUsageForStaff(p, "storage-manual-001", "request-1", { inventory, force: true });
    pinNow("2026-11-17T04:00:00Z");
    expect(await refreshStorageUsageForStaff(p, "storage-manual-001", "request-2", { inventory, force: true })).toEqual(first);
    expect(inventory).toHaveBeenCalledTimes(1);
    const records = await db().select().from(auditEvents).where(and(eq(auditEvents.action, "storage.inventory.checked"), eq(auditEvents.actorId, p.id)));
    expect(records).toHaveLength(1);
    await db().update(staffAccounts).set({ role: "ADMIN" }).where(eq(staffAccounts.id, p.id));
    await expect(refreshStorageUsageForStaff(p, "storage-manual-001", undefined, { inventory })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows only one concurrent object listing and exposes a busy state to the other caller", async () => {
    let announceStarted!: () => void;
    let releaseInventory!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseInventory = resolve; });
    const inventory = vi.fn(async () => { announceStarted(); await release; return { totalBytes: 40, objectCount: 2 }; });
    const first = refreshStorageUsage({ inventory, force: true });
    await started;
    try {
      const second = await refreshStorageUsage({ inventory, force: true });
      expect(second.state).toBe("busy");
      expect(inventory).toHaveBeenCalledTimes(1);
    } finally { releaseInventory(); }
    expect((await first).state).toBe("refreshed");
  });
});
