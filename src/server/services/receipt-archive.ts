import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withTx } from "@/db/client";
import { jobRuns, paymentSubmissions, receiptAssets } from "@/db/schema";
import { now } from "@/lib/time";
import { audit } from "@/server/audit";
import { objectStore, type ObjectStore } from "@/server/storage";
import { assertOriginalReceipt, compressReceipt, decodeReceiptArchive, MAX_ARCHIVE_ORIGINAL_BYTES } from "@/server/storage/receipt-archive";

const DAY_MS = 24 * 60 * 60_000;
export const RECEIPT_ARCHIVE_AGE_MS = 30 * DAY_MS;
export const RECEIPT_ARCHIVE_CLEANUP_GRACE_MS = DAY_MS;
const JOB = "receipt-archive";
const optionsSchema = z.object({ limit: z.number().int().min(1).max(25).default(10) });
type Asset = typeof receiptAssets.$inferSelect;
type Stage = { key: string; assetId: string };

function eligibleDecisions(cutoff: Date) {
  return and(inArray(paymentSubmissions.status, ["APPROVED", "REJECTED"]), lte(paymentSubmissions.decidedAt, cutoff));
}

async function unreferenced(key: string): Promise<boolean> {
  const [reference] = await db().select({ id: receiptAssets.id }).from(receiptAssets).where(or(eq(receiptAssets.objectKey, key), eq(receiptAssets.previewKey, key), eq(receiptAssets.archiveOriginalKey, key))).limit(1);
  return !reference;
}

/** Only delete a unique staging object after checking committed references, even after commit errors. */
async function removeUnpublished(store: ObjectStore, key: string): Promise<void> {
  if (await unreferenced(key)) await store.delete(key);
}

async function markChecked(candidate: Asset, cutoff: Date, compressed: { key: string; size: number } | null): Promise<boolean> {
  return withTx(async (tx) => {
    // Match review lock order: submission(s), then asset. Recheck every reference so an
    // unusually shared asset is never first-archived while any reference is pending.
    const submissions = await tx.select().from(paymentSubmissions).where(eq(paymentSubmissions.assetId, candidate.id)).orderBy(asc(paymentSubmissions.id)).for("update");
    if (!submissions.length || submissions.some((s) => !["APPROVED", "REJECTED"].includes(s.status) || !s.decidedAt || s.decidedAt > cutoff)) return false;
    const [asset] = await tx.select().from(receiptAssets).where(eq(receiptAssets.id, candidate.id)).for("update");
    if (!asset || asset.archiveCheckedAt || asset.archiveEncoding || asset.objectKey !== candidate.objectKey || asset.sha256 !== candidate.sha256 || asset.sizeBytes !== candidate.sizeBytes) return false;
    if (asset.validation !== "CLEAN" || !["CLEAN", "NOT_CONFIGURED"].includes(asset.scan) || asset.isHistoricalPlaceholder) return false;
    const checkedAt = now();
    await tx.update(receiptAssets).set(compressed ? {
      objectKey: compressed.key, archiveEncoding: "gzip", archiveOriginalKey: asset.objectKey,
      archiveSizeBytes: compressed.size, archiveCheckedAt: checkedAt, archivedAt: checkedAt,
      archiveOriginalDeletedAt: null,
    } : { archiveCheckedAt: checkedAt }).where(eq(receiptAssets.id, asset.id));
    await audit(tx, {
      actorType: "SYSTEM", action: compressed ? "receipt.archive" : "receipt.archive.no_savings", entityType: "receipt_asset", entityId: asset.id,
      before: { sizeBytes: asset.sizeBytes },
      after: { encoding: compressed ? "gzip" : null, storedBytes: compressed?.size ?? asset.sizeBytes, cleanupGraceHours: compressed ? 24 : null },
      reason: "Lossless archival at least 30 days after every approval or rejection; original evidence checksum preserved.",
    });
    return true;
  });
}

async function cleanOriginal(store: ObjectStore, candidate: Asset): Promise<number> {
  if (!candidate.archiveOriginalKey || !candidate.archiveEncoding || !candidate.archivedAt || candidate.previewKey === candidate.archiveOriginalKey) return 0;
  const archived = await store.get(candidate.objectKey);
  if (!archived) throw new Error("Receipt archive is missing; retaining original.");
  await decodeReceiptArchive(archived, candidate);
  // The archive pointer is immutable once published. Check again after object I/O;
  // a failed delete leaves the marker unset and the next invocation can retry.
  const current = await withTx(async (tx) => {
    const [asset] = await tx.select().from(receiptAssets).where(eq(receiptAssets.id, candidate.id)).for("update");
    if (!asset || asset.archiveOriginalDeletedAt || asset.objectKey !== candidate.objectKey || asset.archiveOriginalKey !== candidate.archiveOriginalKey || asset.archiveEncoding !== "gzip" || !asset.archivedAt || asset.archivedAt.getTime() > now().getTime() - RECEIPT_ARCHIVE_CLEANUP_GRACE_MS) return null;
    const [otherReference] = await tx.select({ id: receiptAssets.id }).from(receiptAssets).where(and(sql`${receiptAssets.id} <> ${asset.id}`, or(eq(receiptAssets.objectKey, asset.archiveOriginalKey!), eq(receiptAssets.previewKey, asset.archiveOriginalKey!), eq(receiptAssets.archiveOriginalKey, asset.archiveOriginalKey!)))).limit(1);
    return otherReference ? null : asset;
  });
  if (!current?.archiveOriginalKey) return 0;
  // Never run a destructive object operation in a retriable database transaction.
  await store.delete(current.archiveOriginalKey);
  return withTx(async (tx) => {
    const [asset] = await tx.select().from(receiptAssets).where(eq(receiptAssets.id, current.id)).for("update");
    if (!asset || asset.archiveOriginalDeletedAt || asset.objectKey !== current.objectKey || asset.archiveOriginalKey !== current.archiveOriginalKey) return 0;
    await tx.update(receiptAssets).set({ archiveOriginalDeletedAt: now() }).where(eq(receiptAssets.id, asset.id));
    await audit(tx, { actorType: "SYSTEM", action: "receipt.archive.original_cleanup", entityType: "receipt_asset", entityId: asset.id, after: { originalBytesRemoved: asset.sizeBytes, archivedBytes: asset.archiveSizeBytes }, reason: "Verified lossless archive retained; original object removed after the 24-hour read grace period." });
    return asset.sizeBytes;
  });
}

/** Recover staged writes left by a crash without ever deleting a committed archive. */
async function cleanAbandonedStages(store: ObjectStore, limit: number): Promise<number> {
  const runs = await db().select().from(jobRuns).where(and(eq(jobRuns.job, JOB), lte(jobRuns.startedAt, new Date(now().getTime() - DAY_MS)), sql`${jobRuns.details}->>'stagingCleaned' = 'false'`)).orderBy(asc(jobRuns.startedAt)).limit(limit);
  let cleaned = 0;
  for (const run of runs) {
    const stages = z.array(z.object({ key: z.string(), assetId: z.string().uuid() })).max(25).parse(run.details?.staged ?? []);
    for (const stage of stages) {
      // Recognize only our opaque staging prefix, never arbitrary persisted paths.
      if (!stage.key.startsWith(`receipts/archive/${stage.assetId}/`) || !stage.key.endsWith(".gz")) throw new Error("Invalid receipt archive staging key.");
      if (await unreferenced(stage.key)) { await store.delete(stage.key); cleaned++; }
    }
    await withTx(async (tx) => {
      await tx.update(jobRuns).set({ details: { ...run.details, stagingCleaned: true }, ...(run.status === "RUNNING" ? { status: "FAILED" as const, finishedAt: now(), error: "Interrupted archive worker recovered its staged objects." } : {}) }).where(eq(jobRuns.id, run.id));
      await audit(tx, { actorType: "SYSTEM", action: "receipt.archive.staging_cleanup", entityType: "job_run", entityId: run.id, after: { checked: stages.length } });
    });
  }
  return cleaned;
}

/** Bounded daily maintenance; the caller authenticates the scheduled invocation. */
export async function runReceiptArchive(options: { limit?: number; store?: ObjectStore } = {}) {
  const { limit } = optionsSchema.parse({ limit: options.limit });
  const store = options.store ?? objectStore();
  const cutoff = new Date(now().getTime() - RECEIPT_ARCHIVE_AGE_MS);
  const staged: Stage[] = [];
  const [run] = await withTx(tx => tx.insert(jobRuns).values({ job: JOB, status: "RUNNING", startedAt: now(), details: { staged, stagingCleaned: false } }).returning());
  const result = { archived: 0, noSavings: 0, skipped: 0, cleaned: 0, reclaimedBytes: 0, potentialSavingsBytes: 0, abandonedStages: 0, failed: 0, hasMore: false };
  try {
    try { result.abandonedStages = await cleanAbandonedStages(store, limit); } catch { result.failed++; }
    const cleanup = await db().select().from(receiptAssets).where(and(eq(receiptAssets.archiveEncoding, "gzip"), isNotNull(receiptAssets.archiveOriginalKey), isNull(receiptAssets.archiveOriginalDeletedAt), lte(receiptAssets.archivedAt, new Date(now().getTime() - RECEIPT_ARCHIVE_CLEANUP_GRACE_MS)))).orderBy(asc(receiptAssets.archivedAt)).limit(limit);
    for (const asset of cleanup) {
      try { const removed = await cleanOriginal(store, asset); if (removed) { result.cleaned++; result.reclaimedBytes += removed; } }
      catch { result.failed++; }
    }
    const candidates = await db().select({ asset: receiptAssets }).from(receiptAssets).innerJoin(paymentSubmissions, eq(paymentSubmissions.assetId, receiptAssets.id)).where(and(
      eligibleDecisions(cutoff), isNull(receiptAssets.archiveCheckedAt), isNull(receiptAssets.archiveEncoding),
      eq(receiptAssets.validation, "CLEAN"), inArray(receiptAssets.scan, ["CLEAN", "NOT_CONFIGURED"]),
      eq(receiptAssets.isHistoricalPlaceholder, false), lte(receiptAssets.sizeBytes, MAX_ARCHIVE_ORIGINAL_BYTES),
      // Exclude shared pending/newer references before applying the batch limit;
      // otherwise old ineligible shared assets could starve later eligible rows.
      sql`not exists (
        select 1 from payment_submissions archive_reference
        where archive_reference.asset_id = ${receiptAssets.id}
          and (archive_reference.status not in ('APPROVED', 'REJECTED')
            or archive_reference.decided_at is null
            or archive_reference.decided_at > ${cutoff.toISOString()}::timestamptz)
      )`,
    )).groupBy(receiptAssets.id).orderBy(asc(receiptAssets.createdAt), asc(receiptAssets.id)).limit(limit + 1);
    result.hasMore = candidates.length > limit || cleanup.length === limit;
    for (const { asset } of candidates.slice(0, limit)) {
      let stage: Stage | null = null;
      try {
        const original = await store.get(asset.objectKey);
        if (!original) throw new Error("Original receipt is missing.");
        assertOriginalReceipt(original, asset);
        const compressed = await compressReceipt(original);
        if (compressed.byteLength >= original.byteLength) {
          if (await markChecked(asset, cutoff, null)) result.noSavings++;
          else result.skipped++;
          continue;
        }
        stage = { key: `receipts/archive/${asset.id}/${randomUUID()}.gz`, assetId: asset.id };
        staged.push(stage);
        // Persist the intended key BEFORE writing it, so a process crash is recoverable.
        await withTx(tx => tx.update(jobRuns).set({ details: { staged: [...staged], stagingCleaned: false } }).where(eq(jobRuns.id, run.id)));
        await store.put(stage.key, compressed, "application/gzip");
        const readback = await store.get(stage.key);
        if (!readback || readback.byteLength !== compressed.byteLength) throw new Error("Archive write verification failed.");
        await decodeReceiptArchive(readback, asset);
        if (await markChecked(asset, cutoff, { key: stage.key, size: compressed.byteLength })) {
          result.archived++; result.potentialSavingsBytes += original.byteLength - compressed.byteLength;
        } else result.skipped++;
      } catch { result.failed++; }
      finally {
        if (stage) {
          try { await removeUnpublished(store, stage.key); }
          catch { result.failed++; }
        }
      }
    }
    // Failed stage deletion remains discoverable by the next recovery pass.
    const stagingCleaned = result.failed === 0;
    await withTx(async tx => {
      await tx.update(jobRuns).set({ status: result.failed ? "FAILED" : "SUCCEEDED", finishedAt: now(), processed: result.archived + result.noSavings + result.cleaned, error: result.failed ? "Some archive operations failed safely; retained originals and retryable stages remain." : null, details: { ...result, staged, stagingCleaned } }).where(eq(jobRuns.id, run.id));
      await audit(tx, { actorType: "SYSTEM", action: "receipt.archive.batch", entityType: "job_run", entityId: run.id, after: { ...result } });
    });
    return result;
  } catch (error) {
    await withTx(tx => tx.update(jobRuns).set({ status: "FAILED", finishedAt: now(), error: "Receipt archive maintenance failed; original evidence is retained and the batch can retry.", details: { ...result, staged, stagingCleaned: false } }).where(eq(jobRuns.id, run.id)));
    throw error;
  }
}
