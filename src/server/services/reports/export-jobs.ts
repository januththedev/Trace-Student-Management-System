import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx, type Tx } from "@/db/client";
import { exportJobs, jobRuns, staffAccounts, staffScopes } from "@/db/schema";
import { now } from "@/lib/time";
import { CAPABILITIES, requireCap, requireSuper, type Capability, type StaffPrincipal } from "@/server/auth/policy";
import { audit } from "@/server/audit";
import { AppError, fail } from "@/server/http";
import { hashPayload, once } from "@/server/idempotency";
import { objectStore } from "@/server/storage";
import { ExportRequestSchema, exportReportCsv, resolveExportDates, type ExportRequest } from "./exports";

const UUID = z.string().uuid();
const KEY = z.string().min(8).max(200);
const TTL = 15 * 60_000;
type Job = typeof exportJobs.$inferSelect;

/** Lock the account while checking its current permissions. Account changes use
 * the same row lock, so they cannot race a generation/delivery transaction. */
export async function exportPrincipal(tx: Tx, id: string, incoming?: StaffPrincipal): Promise<StaffPrincipal> {
  const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, id)).for("share");
  if (!a || a.status !== "ACTIVE" || a.trashedAt || (incoming && incoming.authVersion !== a.authVersion)) throw fail.unauth();
  const scopes = await tx.select({ programmeId: staffScopes.programmeId, intakeId: staffScopes.intakeId }).from(staffScopes).where(eq(staffScopes.staffId, id));
  return { kind: "staff", id, name: a.name, email: a.email, role: a.role, authVersion: a.authVersion,
    capabilities: new Set(a.capabilities.filter((c): c is Capability => (CAPABILITIES as readonly string[]).includes(c))), scopes,
    sessionId: incoming?.sessionId ?? "export-worker", csrfSecret: incoming?.csrfSecret ?? "" };
}

function authority(p: StaffPrincipal) {
  return hashPayload({ role: p.role, scopes: p.role === "SUPER_ADMIN" ? [] : p.scopes.map(s => `${s.programmeId}:${s.intakeId ?? "*"}`).sort() });
}

function authorize(p: StaffPrincipal, job?: Job) {
  requireCap(p, "exports.download");
  if (job?.fullIdentifiers) requireSuper(p);
  // A previously generated file may contain data removed from today's scope.
  // Invalidate on any scope/role change; the requester can create a fresh job.
  if (job && job.filters._authority !== authority(p)) throw fail.notFound();
}

function publicJob(job: Job) {
  return { id: job.id, report: job.report, status: job.status, rowCount: job.rowCount,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    downloadUrl: job.status === "SUCCEEDED" ? `/api/staff/exports/${job.id}` : null };
}

export async function createExportJob(p: StaffPrincipal, input: ExportRequest, key: string, requestId?: string) {
  const req = ExportRequestSchema.parse(input);
  const dates = resolveExportDates(req);
  KEY.parse(key);
  return withTx(async tx => {
    const fresh = await exportPrincipal(tx, UUID.parse(p.id), p);
    authorize(fresh);
    if (req.fullIdentifiers) requireSuper(fresh);
    const { result } = await once(tx, `export-job:${fresh.id}`, key, req, async () => {
      const id = randomUUID();
      const [job] = await tx.insert(exportJobs).values({ id, staffId: fresh.id, report: req.report,
        filters: { ...req, ...dates, _authority: authority(fresh) }, fullIdentifiers: req.fullIdentifiers === true,
        objectKey: `exports/${id}.csv`,
        // Unfinished jobs expire too: covers objects written before a worker crash.
        expiresAt: new Date(now().getTime() + 24 * 60 * 60_000) }).returning();
      await audit(tx, { actorType: "STAFF", actorId: fresh.id, action: "export.queued", entityType: "export_job", entityId: id,
        after: { report: req.report, fullIdentifiers: job.fullIdentifiers }, requestId });
      return publicJob(job);
    });
    return result;
  });
}

/** Permission and expiry are checked before reading private bytes and again just
 * before constructing the stream. No signed/public URL bypasses these checks. */
export async function downloadExportJob(p: StaffPrincipal, id: string, requestId?: string): Promise<Response> {
  UUID.parse(id);
  return withTx(async tx => {
    const fresh = await exportPrincipal(tx, p.id, p);
    const [job] = await tx.select().from(exportJobs).where(and(eq(exportJobs.id, id), eq(exportJobs.staffId, fresh.id))).for("share");
    if (!job) throw fail.notFound();
    authorize(fresh, job);
    if (!job.expiresAt || job.expiresAt <= now()) throw fail.notFound();
    if (job.status === "RUNNING") return Response.json(publicJob(job), { status: 202, headers: { "Cache-Control": "private, no-store", "Retry-After": "5" } });
    if (job.status !== "SUCCEEDED" || !job.objectKey) throw fail.notFound();
    const bytes = await objectStore().get(job.objectKey);
    if (!bytes || job.expiresAt <= now()) throw fail.notFound();
    await audit(tx, { actorType: "STAFF", actorId: fresh.id, action: "export.delivered", entityType: "export_job", entityId: id,
      after: { report: job.report, rowCount: job.rowCount }, requestId });
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 64 * 1024)));
      offset += 64 * 1024;
    } });
    return new Response(stream, { headers: { "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="t2t-${job.report}-${id}.csv"`,
      "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Vary: "Cookie",
      "X-Content-Type-Options": "nosniff", "X-Row-Count": String(job.rowCount) } });
  });
}

/** Bounded, persistent queue. Row locks with SKIP LOCKED prevent two scheduler
 * invocations generating the same job. A crashed transaction remains queued;
 * deterministic keys are overwritten on retry and cleaned even after a crash. */
export async function runExportJobs(limit = 5) {
  z.number().int().min(1).max(20).parse(limit);
  const run = await withTx(async tx => (await tx.insert(jobRuns).values({ job: "exports", status: "RUNNING" }).returning())[0]);
  let processed = 0, failed = 0, cleaned = 0;
  try {
    cleaned = await cleanupExpiredExports(100);
    for (let i = 0; i < limit; i++) {
      const result = await withTx(async tx => {
        const [job] = await tx.select().from(exportJobs).where(and(eq(exportJobs.status, "RUNNING"),
          sql`${exportJobs.expiresAt} > ${now().toISOString()}::timestamptz`,
          sql`coalesce((${exportJobs.filters}->>'_retryAt')::timestamptz, '-infinity'::timestamptz) <= ${now().toISOString()}::timestamptz`))
          .orderBy(asc(exportJobs.createdAt), asc(exportJobs.id)).limit(1).for("update", { skipLocked: true });
        if (!job) return null;
        try {
          // Savepoint keeps partial audit/query work out of a failed attempt.
          await tx.transaction(async nested => {
            const p = await exportPrincipal(nested, job.staffId);
            authorize(p, job);
            const input = ExportRequestSchema.parse({ ...job.filters, report: job.report, fullIdentifiers: job.fullIdentifiers });
            const r = await exportReportCsv(nested, p, input);
            await objectStore().put(job.objectKey!, Buffer.from(r.csv, "utf8"), "text/csv; charset=utf-8");
            await nested.update(exportJobs).set({ status: "SUCCEEDED", rowCount: r.rowCount, error: null,
              expiresAt: new Date(now().getTime() + TTL) }).where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, "RUNNING")));
            await audit(nested, { actorType: "SYSTEM", action: "export.generated", entityType: "export_job", entityId: job.id,
              after: { rowCount: r.rowCount } });
          });
          return "succeeded";
        } catch (e) {
          const attempts = Number(job.filters._attempts ?? 0) + 1;
          const terminal = e instanceof AppError || e instanceof z.ZodError || attempts >= 3;
          await tx.update(exportJobs).set({ status: terminal ? "FAILED" : "RUNNING", error: "Export generation failed. Create a new job or retry after the dependency recovers.",
            filters: { ...job.filters, _attempts: attempts, _retryAt: new Date(now().getTime() + 60_000 * 2 ** (attempts - 1)).toISOString() } })
            .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, "RUNNING")));
          await audit(tx, { actorType: "SYSTEM", action: "export.failed", entityType: "export_job", entityId: job.id, after: { attempts, terminal } });
          return "failed";
        }
      });
      if (!result) break;
      if (result === "succeeded") processed++; else failed++;
    }
    await withTx(async tx => { await tx.update(jobRuns).set({ status: failed ? "FAILED" : "SUCCEEDED", finishedAt: now(), processed,
      details: { processed, failed, cleaned } }).where(eq(jobRuns.id, run.id)); });
    return { processed, failed, cleaned };
  } catch (e) {
    await withTx(async tx => { await tx.update(jobRuns).set({ status: "FAILED", finishedAt: now(), processed,
      error: "Export worker dependency failed", details: { processed, failed, cleaned } }).where(eq(jobRuns.id, run.id)); });
    throw e;
  }
}

export async function cleanupExpiredExports(limit = 100) {
  z.number().int().min(1).max(100).parse(limit);
  return withTx(async tx => {
    const jobs = await tx.select().from(exportJobs).where(and(isNotNull(exportJobs.objectKey), lte(exportJobs.expiresAt, now())))
      .orderBy(asc(exportJobs.expiresAt)).limit(limit).for("update", { skipLocked: true });
    for (const job of jobs) {
      await objectStore().delete(job.objectKey!);
      await tx.update(exportJobs).set({ objectKey: null, ...(job.status === "RUNNING" ? { status: "FAILED" as const, error: "Export job expired" } : {}) }).where(eq(exportJobs.id, job.id));
      await audit(tx, { actorType: "SYSTEM", action: "export.cleaned", entityType: "export_job", entityId: job.id });
    }
    return jobs.length;
  });
}
