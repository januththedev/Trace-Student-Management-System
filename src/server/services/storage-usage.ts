import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx, type Tx } from "@/db/client";
import { jobRuns, receiptAssets } from "@/db/schema";
import { now } from "@/lib/time";
import { audit } from "@/server/audit";
import { freshPrincipal } from "@/server/auth/fresh";
import { requireSuper, type StaffPrincipal } from "@/server/auth/policy";
import { once } from "@/server/idempotency";
import { objectStore } from "@/server/storage";

const DEFAULT_BUDGET_BYTES = 10_000_000_000;
const REFRESH_INTERVAL_MS = 10 * 60_000;
const STALE_AFTER_MS = 36 * 60 * 60_000;
const FAILURE_MESSAGE = "Storage usage could not be checked. Try again later.";

const inventorySchema = z.object({
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  objectCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export interface StorageUsageSummary {
  status: "ready" | "not_checked" | "unavailable";
  driver: "local" | "s3";
  budgetBytes: number;
  usedBytes: number | null;
  remainingBytes: number | null;
  objectCount: number | null;
  percentageUsed: number | null;
  measuredAt: string | null;
  stale: boolean;
  lastCheckFailed: boolean;
  savedBytes: number;
  archivedOriginals: number;
}

interface InventoryOptions {
  /** Object-storage boundary injection, used by integration tests. */
  inventory?: () => Promise<{ totalBytes: number; objectCount: number }>;
  force?: boolean;
}

interface RefreshResult {
  state: "refreshed" | "cached" | "busy" | "failed";
  usage: StorageUsageSummary;
}

function config() {
  const driver = process.env.STORAGE_DRIVER === "s3" ? "s3" : "local";
  const budget = process.env.STORAGE_BUDGET_BYTES ?? String(DEFAULT_BUDGET_BYTES);
  const budgetBytes = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(budget);
  const identity = driver === "s3"
    ? [driver, process.env.S3_ENDPOINT ?? "AWS", process.env.S3_REGION ?? "", process.env.S3_BUCKET ?? ""]
    : [driver, path.resolve(process.env.LOCAL_STORAGE_DIR ?? "./.private-storage")];
  // Only a digest is persisted. Bucket names, endpoints and local paths never reach the client.
  const job = `storage.inventory:${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}`;
  return { driver, budgetBytes, job } as const;
}

async function summary(tx: Tx): Promise<StorageUsageSummary> {
  const { driver, budgetBytes, job } = config();
  const [[successful], [failed], [archival]] = await Promise.all([
    tx.select().from(jobRuns).where(and(eq(jobRuns.job, job), eq(jobRuns.status, "SUCCEEDED")))
      .orderBy(desc(jobRuns.finishedAt), desc(jobRuns.startedAt)).limit(1),
    tx.select().from(jobRuns).where(and(eq(jobRuns.job, job), eq(jobRuns.status, "FAILED")))
      .orderBy(desc(jobRuns.finishedAt), desc(jobRuns.startedAt)).limit(1),
    // Both copies count toward usage during the recovery grace period. Savings
    // are only real once deletion of the old uncompressed object is confirmed.
    tx.select({
      savedBytes: sql<string>`coalesce(sum(${receiptAssets.sizeBytes}::bigint - ${receiptAssets.archiveSizeBytes}::bigint), 0)::text`,
      archivedOriginals: sql<number>`count(*)::int`,
    }).from(receiptAssets).where(and(isNotNull(receiptAssets.archiveOriginalDeletedAt), isNotNull(receiptAssets.archiveSizeBytes))),
  ]);
  const savedBytes = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(archival.savedBytes);
  const archivedOriginals = archival.archivedOriginals;
  const parsed = inventorySchema.safeParse(successful?.details);
  const measured = successful?.finishedAt ?? null;
  const lastCheckFailed = !!failed && (!measured || !failed.finishedAt || failed.finishedAt >= measured);
  if (!parsed.success || !measured) {
    return {
      status: failed ? "unavailable" : "not_checked", driver, budgetBytes,
      usedBytes: null, remainingBytes: null, objectCount: null, percentageUsed: null,
      measuredAt: null, stale: false, lastCheckFailed, savedBytes, archivedOriginals,
    };
  }
  const { totalBytes, objectCount } = parsed.data;
  return {
    status: "ready", driver, budgetBytes, usedBytes: totalBytes,
    remainingBytes: Math.max(0, budgetBytes - totalBytes), objectCount,
    percentageUsed: totalBytes / budgetBytes * 100,
    measuredAt: measured.toISOString(),
    stale: lastCheckFailed || now().getTime() - measured.getTime() > STALE_AFTER_MS,
    lastCheckFailed, savedBytes, archivedOriginals,
  };
}

/** Fresh Super Admin authorization precedes every global storage summary read. No bucket listing here. */
export async function getStorageUsage(p0: StaffPrincipal): Promise<StorageUsageSummary> {
  return withTx(async tx => {
    requireSuper(await freshPrincipal(tx, p0));
    return summary(tx);
  });
}

async function refresh(tx: Tx, options: InventoryOptions, p?: StaffPrincipal, requestId?: string): Promise<RefreshResult> {
  const { job } = config();
  const [lock] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${job})) as locked`);
  if (!lock.locked) return { state: "busy", usage: await summary(tx) };
  const previous = await summary(tx);
  if (!options.force && !previous.lastCheckFailed && previous.measuredAt && now().getTime() - Date.parse(previous.measuredAt) < REFRESH_INTERVAL_MS) {
    return { state: "cached", usage: previous };
  }
  const startedAt = now();
  let inventory: z.infer<typeof inventorySchema>;
  try {
    inventory = inventorySchema.parse(await (options.inventory ?? (() => objectStore().inventory()))());
  } catch {
    // Provider errors can contain endpoints or credentials. Persist only this stable message.
    await tx.insert(jobRuns).values({ job, status: "FAILED", startedAt, finishedAt: now(), processed: 0, error: FAILURE_MESSAGE });
    await audit(tx, {
      actorType: p ? "STAFF" : "SYSTEM", actorId: p?.id, action: "storage.inventory.failed",
      entityType: "storage", requestId, after: { status: "FAILED" },
    });
    return { state: "failed", usage: await summary(tx) };
  }
  await tx.insert(jobRuns).values({
    job, status: "SUCCEEDED", startedAt, finishedAt: now(),
    processed: Math.min(inventory.objectCount, 2_147_483_647), details: inventory,
  });
  await audit(tx, {
    actorType: p ? "STAFF" : "SYSTEM", actorId: p?.id, action: "storage.inventory.checked",
    entityType: "storage", requestId, after: inventory,
  });
  return { state: "refreshed", usage: await summary(tx) };
}

/** Trusted scheduler entry point; also used after receipt archival to account for actual physical objects. */
export async function refreshStorageUsage(options: InventoryOptions = {}): Promise<RefreshResult> {
  return withTx(tx => refresh(tx, options));
}

/** Manual refresh is CSRF-protected at the route, freshly authorized and safely replayable here. */
export async function refreshStorageUsageForStaff(p0: StaffPrincipal, key: string, requestId?: string, options: InventoryOptions = {}): Promise<RefreshResult> {
  z.string().min(8).max(200).parse(key);
  return withTx(async tx => {
    const p = await freshPrincipal(tx, p0);
    requireSuper(p);
    const { result } = await once(tx, `storage.inventory.refresh:${p.id}`, key, { scope: config().job }, () => refresh(tx, options, p, requestId));
    return result;
  });
}
