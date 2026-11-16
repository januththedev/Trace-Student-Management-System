import "server-only";
import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNotNull, lte, inArray, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx, type Tx } from "@/db/client";
import { intakes, jobRuns, programmes, staffAccounts, staffScopes } from "@/db/schema";
import { now } from "@/lib/time";
import { audit } from "@/server/audit";
import { revokeAllStaffSessions } from "@/server/auth/staff";
import { invalidateInvitations } from "../governance";
import { lockGovernance } from "../governance/invariant";
import { trashTables, type TrashKind } from "./index";

/** All banner writers should acquire this same advisory lock before assigning a path. */
export async function lockMediaPath(tx: Tx, objectPath: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`public-media:${objectPath}`}, 0))`);
}

async function removeUnreferencedMedia(tx: Tx, objectPath: string) {
  await lockMediaPath(tx, objectPath);
  const [p] = await tx.select({ id: programmes.id }).from(programmes).where(or(eq(programmes.bannerPath, objectPath), eq(programmes.logoPath, objectPath))).limit(1);
  const [i] = await tx.select({ id: intakes.id }).from(intakes).where(eq(intakes.bannerPath, objectPath)).limit(1);
  if (p || i) return;
  // References are checked across ALL rows, including archived/trashed records.
  const publicRoot = await realpath(path.resolve(process.cwd(), "public"));
  if (!objectPath.startsWith("/") || objectPath.startsWith("//") || objectPath.includes("\\") || objectPath.includes("\0")) throw new Error("Unsafe public media path");
  const target = path.resolve(publicRoot, objectPath.slice(1));
  const within = (v: string) => { const rel = path.relative(publicRoot, v); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };
  if (!within(target)) throw new Error("Media path escapes public directory");
  try {
    const resolved = await realpath(target);
    if (!within(resolved)) throw new Error("Media symlink escapes public directory");
    const info = await lstat(target);
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error("Media path is not a file");
    await unlink(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** The row lock stays held through external cleanup. A crash rolls the claim back.
 * ENOENT is success on retry; other failures retain the original object paths. */
async function purgeOne(kind: TrashKind, seen: string[]) {
  let claimedId: string | undefined;
  try {
    return await withTx(async tx => {
      if (kind === "staff") await lockGovernance(tx);
      // Also exclude ordinary configuration writers during reference checks/unlink.
      // This protects existing references even before other writers adopt lockMediaPath.
      if (kind !== "staff") await tx.execute(sql`lock table programmes, intakes in share row exclusive mode`);
      const table = trashTables[kind];
      const [row] = await tx.select().from(table).where(and(isNotNull(table.trashedAt), lte(table.purgeAfter, now()), inArray(table.purgeStatus, ["PENDING", "FAILED", "IN_PROGRESS"]), seen.length ? notInArray(table.id, seen) : sql`true`))
        .orderBy(table.id).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      claimedId = row.id;
      await tx.update(table).set({ purgeStatus: "IN_PROGRESS", updatedAt: now() }).where(eq(table.id, row.id));
      const media: string[] = [];
      if (kind === "programme") {
        const [p] = await tx.select().from(programmes).where(eq(programmes.id, row.id));
        media.push(...[p.bannerPath, p.logoPath].filter((s): s is string => !!s));
        await tx.update(programmes).set({ name: `Purged programme ${p.code}`, description: "", bannerPath: null, logoPath: null, isPublic: false, trashReason: null }).where(eq(programmes.id, p.id));
      } else if (kind === "intake") {
        const [i] = await tx.select().from(intakes).where(eq(intakes.id, row.id));
        if (i.bannerPath) media.push(i.bannerPath);
        await tx.update(intakes).set({ label: `Purged intake ${i.code}`, bannerPath: null, isPublic: false, trashReason: null }).where(eq(intakes.id, i.id));
      } else {
        const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, row.id));
        await revokeAllStaffSessions(tx, a.id);
        await invalidateInvitations(tx, a);
        await tx.delete(staffScopes).where(eq(staffScopes.staffId, a.id));
        await tx.update(staffAccounts).set({ name: `Purged staff ${a.id}`, email: `purged-${a.id}@invalid`, passwordHash: null, capabilities: [], status: "DEACTIVATED", authVersion: a.authVersion + 1, trashReason: null, lastLoginAt: null }).where(eq(staffAccounts.id, a.id));
      }
      for (const objectPath of [...new Set(media)].sort()) await removeUnreferencedMedia(tx, objectPath);
      await tx.update(table).set({ purgeStatus: "PURGED", version: row.version + 1, updatedAt: now() }).where(eq(table.id, row.id));
      await audit(tx, { actorType: "SYSTEM", action: `${kind}.purge`, entityType: kind, entityId: row.id, after: { purgeStatus: "PURGED" } });
      return { id: row.id, failed: false };
    });
  } catch {
    if (!claimedId) throw new Error(`Could not claim ${kind} retention record`);
    const id = claimedId;
    await withTx(async tx => {
      if (kind === "staff") await lockGovernance(tx);
      const table = trashTables[kind];
      const [r] = await tx.select().from(table).where(eq(table.id, id)).for("update");
      if (r?.trashedAt && r.purgeAfter && r.purgeAfter <= now() && r.purgeStatus !== "PURGED") {
        await tx.update(table).set({ purgeStatus: "FAILED", updatedAt: now() }).where(eq(table.id, id));
        await audit(tx, { actorType: "SYSTEM", action: `${kind}.purge.failed`, entityType: kind, entityId: id, reason: "Disposable media cleanup failed. Inspect the asset path and retry the retention job." });
      }
    });
    return { id, failed: true };
  }
}

export async function runPurgeJob(input: { limit?: number } = {}) {
  const { limit } = z.object({ limit: z.number().int().min(1).max(1000).default(100) }).parse(input);
  const job = await withTx(async tx => {
    const [created] = await tx.insert(jobRuns).values({ job: "retention.purge", status: "RUNNING", startedAt: now() }).returning();
    await audit(tx, { actorType: "SYSTEM", action: "retention.start", entityType: "job", entityId: created.id });
    return created;
  });
  let processed = 0;
  let failed = 0;
  try {
    for (const kind of ["programme", "intake", "staff"] as const) {
      const seen: string[] = [];
      while (processed + failed < limit) {
        const r = await purgeOne(kind, seen);
        if (!r) break;
        seen.push(r.id);
        if (r.failed) failed++; else processed++;
      }
    }
    await withTx(async tx => {
      await tx.update(jobRuns).set({ status: failed ? "FAILED" : "SUCCEEDED", processed, finishedAt: now(), error: failed ? `${failed} record(s) failed cleanup; retry is safe.` : null, details: { failed } }).where(eq(jobRuns.id, job.id));
      await audit(tx, { actorType: "SYSTEM", action: "retention.finish", entityType: "job", entityId: job.id, after: { processed, failed } });
    });
    return { jobId: job.id, processed, failed };
  } catch (e) {
    await withTx(async tx => {
      await tx.update(jobRuns).set({ status: "FAILED", processed, finishedAt: now(), error: "Retention worker failed. Retry the job.", details: { failed } }).where(eq(jobRuns.id, job.id));
      await audit(tx, { actorType: "SYSTEM", action: "retention.failed", entityType: "job", entityId: job.id, after: { processed, failed } });
    });
    throw e;
  }
}
