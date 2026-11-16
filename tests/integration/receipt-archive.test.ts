import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, test } from "vitest";
import { db } from "@/db/client";
import { auditEvents, jobRuns, paymentSubmissions, receiptAssets } from "@/db/schema";
import { runReceiptArchive, RECEIPT_ARCHIVE_AGE_MS, RECEIPT_ARCHIVE_CLEANUP_GRACE_MS } from "@/server/services/receipt-archive";
import type { ObjectStore } from "@/server/storage";
import { compressReceipt, decodeReceiptArchive, readReceiptAssetBytes } from "@/server/storage/receipt-archive";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStudent, pinNow, resetDb } from "./helpers";

const FIXED_NOW = new Date("2026-11-16T12:00:00Z");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const repeated = () => Buffer.from("Synthetic retained evidence. ".repeat(3000));
let store: MemoryStore;

/** Only the external object-storage boundary is substituted; DB/compression/locks are real. */
class MemoryStore implements ObjectStore {
  readonly driver = "local" as const;
  readonly productionReady = false;
  readonly objects = new Map<string, Buffer>();
  readonly contentTypes = new Map<string, string>();
  onPut?: (key: string) => Promise<void>;
  onGet?: (key: string) => Promise<Buffer | null | undefined>;
  onDelete?: (key: string) => Promise<void>;
  async put(key: string, bytes: Buffer, contentType = "application/octet-stream") { this.objects.set(key, Buffer.from(bytes)); this.contentTypes.set(key, contentType); await this.onPut?.(key); }
  async get(key: string) { const intercepted = await this.onGet?.(key); return intercepted === undefined ? this.objects.get(key) ?? null : intercepted; }
  async delete(key: string) { await this.onDelete?.(key); this.objects.delete(key); this.contentTypes.delete(key); }
  async exists(key: string) { return this.objects.has(key); }
  async inventory() { return { objectCount: this.objects.size, totalBytes: [...this.objects.values()].reduce((total, bytes) => total + bytes.byteLength, 0) }; }
}

beforeEach(async () => { await resetDb(); pinNow(FIXED_NOW.toISOString()); store = new MemoryStore(); });
afterAll(async () => { delete process.env.T2T_FAKE_NOW; await closeDb(); });

async function fixture(bytes = repeated(), options: { status?: "APPROVED" | "REJECTED" | "PENDING_REVIEW"; decidedAt?: Date | null } = {}) {
  const programme = await makeProgramme();
  const intake = await makeIntake(programme.id);
  const student = await makeStudent();
  const { enrolment, instalments } = await makeEnrolment(student.id, intake.id, [{ amountMinor: 10_000, dueDate: "2026-01-01" }]);
  const objectKey = `receipts/${randomUUID()}.pdf`;
  await store.put(objectKey, bytes, "application/pdf");
  const [asset] = await db().insert(receiptAssets).values({ enrolmentId: enrolment.id, objectKey, sha256: sha(bytes), sizeBytes: bytes.length, mime: "application/pdf", validation: "CLEAN" }).returning();
  const [submission] = await db().insert(paymentSubmissions).values({ enrolmentId: enrolment.id, targetInstalmentId: instalments[0].id, assetId: asset.id, claimedMinor: 10_000, transferDate: "2026-01-01", idempotencyKey: randomUUID(), status: options.status ?? "APPROVED", decidedAt: options.decidedAt === undefined ? new Date(FIXED_NOW.getTime() - RECEIPT_ARCHIVE_AGE_MS) : options.decidedAt }).returning();
  return { asset, submission, bytes };
}

async function refreshed(assetId: string) {
  return (await db().select().from(receiptAssets).where(eq(receiptAssets.id, assetId)))[0];
}

test("archives approval/rejection at exactly 30 days, preserving exact bytes, hashes and decisions; never pending or younger", async () => {
  const approved = await fixture();
  const rejected = await fixture(repeated(), { status: "REJECTED" });
  const young = await fixture(repeated(), { decidedAt: new Date(FIXED_NOW.getTime() - RECEIPT_ARCHIVE_AGE_MS + 1) });
  const pending = await fixture(repeated(), { status: "PENDING_REVIEW" });
  const undecided = await fixture(repeated(), { decidedAt: null });
  const result = await runReceiptArchive({ store });
  expect(result).toMatchObject({ archived: 2, failed: 0, cleaned: 0 });
  for (const f of [approved, rejected]) {
    const asset = await refreshed(f.asset.id);
    expect(asset).toMatchObject({ archiveEncoding: "gzip", archiveOriginalKey: f.asset.objectKey, sha256: f.asset.sha256, sizeBytes: f.bytes.length, mime: f.asset.mime, archiveOriginalDeletedAt: null });
    expect(asset.archiveSizeBytes).toBeLessThan(f.bytes.length);
    expect(await readReceiptAssetBytes(asset, store)).toEqual(f.bytes);
    expect(store.objects.has(f.asset.objectKey)).toBe(true);
    expect((await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.id, f.submission.id)))[0]).toEqual(f.submission);
  }
  for (const f of [young, pending, undecided]) expect((await refreshed(f.asset.id)).archiveCheckedAt).toBeNull();
  const replay = await runReceiptArchive({ store });
  expect(replay.archived).toBe(0);
  expect((await db().select().from(auditEvents).where(eq(auditEvents.action, "receipt.archive")))).toHaveLength(2);
});

test("does not replace an incompressible original or retry unchanged no-savings content", async () => {
  const f = await fixture(randomBytes(4096));
  const first = await runReceiptArchive({ store });
  expect(first).toMatchObject({ archived: 0, noSavings: 1, failed: 0 });
  const asset = await refreshed(f.asset.id);
  expect(asset.objectKey).toBe(f.asset.objectKey);
  expect(asset.archiveEncoding).toBeNull();
  expect(asset.archiveCheckedAt).toEqual(FIXED_NOW);
  expect(store.objects.size).toBe(1);
  expect((await runReceiptArchive({ store })).noSavings).toBe(0);
});

test("oldest shared pending references and unsafe scans do not starve a bounded eligible batch", async () => {
  const shared = await fixture();
  await db().insert(paymentSubmissions).values({ enrolmentId: shared.submission.enrolmentId, targetInstalmentId: shared.submission.targetInstalmentId, assetId: shared.asset.id, claimedMinor: 10_000, transferDate: "2026-01-01", idempotencyKey: randomUUID(), status: "PENDING_REVIEW" });
  const unsafe = await fixture();
  await db().update(receiptAssets).set({ scan: "ERROR" }).where(eq(receiptAssets.id, unsafe.asset.id));
  await db().update(receiptAssets).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(receiptAssets.id, shared.asset.id));
  const eligible = await fixture();
  await fixture();
  const result = await runReceiptArchive({ store, limit: 1 });
  expect(result).toMatchObject({ archived: 1, skipped: 0, failed: 0, hasMore: true });
  expect((await refreshed(shared.asset.id)).archiveEncoding).toBeNull();
  expect((await refreshed(unsafe.asset.id)).archiveCheckedAt).toBeNull();
  expect((await refreshed(eligible.asset.id)).archiveEncoding).toBe("gzip");
  expect(store.objects.size).toBe(5);
});

test("delete failure retains retry state; cleanup only after 24h and exact verified gzip survives", async () => {
  const f = await fixture();
  await runReceiptArchive({ store });
  pinNow(new Date(FIXED_NOW.getTime() + RECEIPT_ARCHIVE_CLEANUP_GRACE_MS - 1).toISOString());
  expect((await runReceiptArchive({ store })).cleaned).toBe(0);
  pinNow(new Date(FIXED_NOW.getTime() + RECEIPT_ARCHIVE_CLEANUP_GRACE_MS).toISOString());
  store.onDelete = async key => { if (key === f.asset.objectKey) throw new Error("Synthetic unavailable provider"); };
  expect((await runReceiptArchive({ store })).failed).toBe(1);
  expect((await refreshed(f.asset.id)).archiveOriginalDeletedAt).toBeNull();
  expect(store.objects.has(f.asset.objectKey)).toBe(true);
  store.onDelete = undefined;
  const cleanup = await runReceiptArchive({ store });
  expect(cleanup).toMatchObject({ cleaned: 1, reclaimedBytes: f.bytes.length, failed: 0 });
  const asset = await refreshed(f.asset.id);
  expect(asset.archiveOriginalDeletedAt).not.toBeNull();
  expect(store.objects.has(f.asset.objectKey)).toBe(false);
  expect(await readReceiptAssetBytes(asset, store)).toEqual(f.bytes);
  expect((await runReceiptArchive({ store })).cleaned).toBe(0);
  expect(await db().select().from(auditEvents).where(eq(auditEvents.action, "receipt.archive.original_cleanup"))).toHaveLength(1);
});

test("rechecks decisions after storage I/O and cleans only its unique losing stage", async () => {
  const f = await fixture();
  store.onPut = async key => {
    if (key.endsWith(".gz")) await db().update(paymentSubmissions).set({ status: "PENDING_REVIEW", decidedAt: null, version: 2 }).where(eq(paymentSubmissions.id, f.submission.id));
  };
  const result = await runReceiptArchive({ store });
  expect(result).toMatchObject({ archived: 0, skipped: 1, failed: 0 });
  expect((await refreshed(f.asset.id)).objectKey).toBe(f.asset.objectKey);
  expect([...store.objects.keys()]).toEqual([f.asset.objectKey]);
});

test("two concurrent workers publish one archive and never delete the winning stage", async () => {
  const f = await fixture();
  let puts = 0;
  let release!: () => void;
  const bothStaged = new Promise<void>(resolve => { release = resolve; });
  store.onPut = async key => {
    if (!key.endsWith(".gz")) return;
    if (++puts === 2) release();
    await bothStaged;
  };
  const results = await Promise.all([runReceiptArchive({ store }), runReceiptArchive({ store })]);
  expect(results.reduce((n, r) => n + r.archived, 0)).toBe(1);
  expect(results.reduce((n, r) => n + r.failed, 0)).toBe(0);
  const asset = await refreshed(f.asset.id);
  expect([...store.objects.keys()].filter(key => key.endsWith(".gz"))).toEqual([asset.objectKey]);
  expect(await readReceiptAssetBytes(asset, store)).toEqual(f.bytes);
  expect(await db().select().from(auditEvents).where(eq(auditEvents.action, "receipt.archive"))).toHaveLength(1);
});

test("failed writes/readbacks never lose original evidence and can retry", async () => {
  const f = await fixture();
  store.onPut = async key => { if (key.endsWith(".gz")) throw new Error("Synthetic failed storage write"); };
  expect((await runReceiptArchive({ store })).failed).toBe(1);
  expect((await refreshed(f.asset.id)).archiveEncoding).toBeNull();
  expect([...store.objects.keys()]).toEqual([f.asset.objectKey]);
  store.onPut = undefined;
  store.onGet = async key => key.endsWith(".gz") ? Buffer.from("corrupt gzip") : undefined;
  expect((await runReceiptArchive({ store })).failed).toBe(1);
  expect((await refreshed(f.asset.id)).archiveEncoding).toBeNull();
  expect(store.objects.has(f.asset.objectKey)).toBe(true);
  store.onGet = undefined;
  expect((await runReceiptArchive({ store })).archived).toBe(1);
});

test("missing or corrupt archived copy prevents original deletion; bounded decode rejects expansion and hash substitution", async () => {
  const f = await fixture();
  await runReceiptArchive({ store });
  const asset = await refreshed(f.asset.id);
  const validArchive = store.objects.get(asset.objectKey)!;
  store.objects.delete(asset.objectKey);
  expect(await readReceiptAssetBytes(asset, store)).toEqual(f.bytes);
  pinNow(new Date(FIXED_NOW.getTime() + RECEIPT_ARCHIVE_CLEANUP_GRACE_MS).toISOString());
  expect((await runReceiptArchive({ store })).failed).toBe(1);
  expect(store.objects.has(f.asset.objectKey)).toBe(true);
  store.objects.set(asset.objectKey, Buffer.from("corrupt gzip"));
  await expect(readReceiptAssetBytes(asset, store)).rejects.toThrow();
  expect((await runReceiptArchive({ store })).failed).toBe(1);
  expect((await refreshed(f.asset.id)).archiveOriginalDeletedAt).toBeNull();
  await expect(decodeReceiptArchive(validArchive, { ...asset, sizeBytes: 3 })).rejects.toThrow();
  await expect(decodeReceiptArchive(validArchive, { ...asset, sha256: "0".repeat(64) })).rejects.toThrow("integrity");
  const zipBomb = await promisify(gzip)(Buffer.alloc(1024 * 1024, 0));
  await expect(decodeReceiptArchive(zipBomb, { sizeBytes: 64, sha256: "0".repeat(64) })).rejects.toThrow();
  expect(await compressReceipt(Buffer.from("x"))).toBeInstanceOf(Buffer);
});

test("bounded batches recover crash-leftover stages but preserve any referenced archive", async () => {
  const f = await fixture();
  await runReceiptArchive({ store });
  const asset = await refreshed(f.asset.id);
  const abandoned = `receipts/archive/${f.asset.id}/${randomUUID()}.gz`;
  await store.put(abandoned, Buffer.from("abandoned staged object"), "application/gzip");
  const [crash] = await db().insert(jobRuns).values({ job: "receipt-archive", status: "RUNNING", startedAt: new Date(FIXED_NOW.getTime() - RECEIPT_ARCHIVE_CLEANUP_GRACE_MS), details: { staged: [{ key: abandoned, assetId: asset.id }, { key: asset.objectKey, assetId: asset.id }], stagingCleaned: false } }).returning();
  expect((await runReceiptArchive({ store, limit: 1 })).abandonedStages).toBe(1);
  expect(store.objects.has(abandoned)).toBe(false);
  expect(await readReceiptAssetBytes(asset, store)).toEqual(f.bytes);
  expect((await db().select().from(jobRuns).where(eq(jobRuns.id, crash.id)))[0]).toMatchObject({ status: "FAILED", details: { stagingCleaned: true } });
  await fixture();
  await fixture();
  const batch = await runReceiptArchive({ store, limit: 1 });
  expect(batch.archived).toBe(1);
  expect(batch.hasMore).toBe(true);
});
