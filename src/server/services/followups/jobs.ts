import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { withTx } from "@/db/client";
import { enrolments, followUpTasks, intakes, jobLeases, jobRuns, paymentPromises, paymentSubmissions, programmes } from "@/db/schema";
import { businessDate, now } from "@/lib/time";
import { audit } from "@/server/audit";
import { nextContactAt } from "./calendar";
import { recomputePromises } from "./promises";
import { loadQueueBatch } from "./queue";
import { reconcileCollectionTasks, upsertTask } from "./tasks";

const JOB = "followups";
/** Each invocation advances persistent cursors. No dependence on process-local timers. */
export async function runFollowUpJobs() {
  const holder = randomUUID();
  const runId = await withTx(async tx => {
    await tx.insert(jobLeases).values({ job: JOB }).onConflictDoNothing();
    const [lease] = await tx.select().from(jobLeases).where(eq(jobLeases.job, JOB)).for("update");
    if (lease.expiresAt && lease.expiresAt > now()) return null;
    await tx.update(jobRuns).set({ status: "FAILED", finishedAt: now(), error: "Previous worker lease expired before completion; recovering its batch." }).where(and(eq(jobRuns.job, JOB), eq(jobRuns.status, "RUNNING")));
    await tx.update(jobLeases).set({ holder, expiresAt: new Date(now().getTime() + 5 * 60_000) }).where(eq(jobLeases.job, JOB));
    const [run] = await tx.insert(jobRuns).values({ job: JOB, status: "RUNNING", startedAt: now() }).returning();
    return run.id;
  });
  if (!runId) return { skipped: true, processed: 0 };
  try {
    return await withTx(async tx => {
      const [lease] = await tx.select().from(jobLeases).where(eq(jobLeases.job, JOB)).for("update");
      if (lease.holder !== holder) throw new Error("Follow-up lease lost.");
      const [previous] = await tx.select().from(jobRuns).where(and(eq(jobRuns.job, JOB), eq(jobRuns.status, "SUCCEEDED"))).orderBy(desc(jobRuns.finishedAt)).limit(1);
      const cursor = typeof previous?.details?.queueCursor === "string" ? previous.details.queueCursor : undefined;
      const promiseCursor = typeof previous?.details?.promiseCursor === "string" ? previous.details.promiseCursor : undefined;
      const maintenanceCursor = typeof previous?.details?.maintenanceCursor === "string" ? previous.details.maintenanceCursor : undefined;
      const maintenance = await tx.select({ enrolmentId: followUpTasks.enrolmentId }).from(followUpTasks).where(and(eq(followUpTasks.state, "OPEN"), inArray(followUpTasks.type, ["COLLECTION_CALL", "CALLBACK"]), maintenanceCursor ? gt(followUpTasks.enrolmentId, maintenanceCursor) : undefined)).groupBy(followUpTasks.enrolmentId).orderBy(asc(followUpTasks.enrolmentId)).limit(50);
      await reconcileCollectionTasks(tx, maintenance.map(t => t.enrolmentId));
      const promises = await tx.select({ enrolmentId: paymentPromises.enrolmentId }).from(paymentPromises).where(and(inArray(paymentPromises.state, ["OPEN", "PARTIALLY_FULFILLED", "FULFILLED", "BROKEN"]), promiseCursor ? gt(paymentPromises.enrolmentId, promiseCursor) : undefined)).groupBy(paymentPromises.enrolmentId).orderBy(asc(paymentPromises.enrolmentId)).limit(50);
      for (const p of promises) await recomputePromises(tx, p.enrolmentId);
      const queue = await loadQueueBatch(tx, null, { cursor, limit: 50 });
      let scheduled = 0;
      for (const card of queue.items) {
        if (card.flags.length || card.deferred) continue;
        const dueAt = await nextContactAt(tx);
        // Old missed collection tasks are cancelled and rolled into today's single business key.
        await tx.update(followUpTasks).set({ state: "CANCELLED", closeReason: "Rolled into the next actionable business day.", closedAt: now(), updatedAt: now(), version: sql`${followUpTasks.version} + 1` }).where(and(eq(followUpTasks.enrolmentId, card.id), eq(followUpTasks.state, "OPEN"), eq(followUpTasks.type, "COLLECTION_CALL"), lt(followUpTasks.dueAt, new Date(`${businessDate(dueAt)}T00:00:00+05:30`))));
        await upsertTask(tx, { enrolmentId: card.id, type: "COLLECTION_CALL", dueAt, dedupeKey: `COLLECTION_CALL:${card.id}:${businessDate(dueAt)}`, reason: "Daily collectible due balance." });
        scheduled++;
      }
      // A pending submission gets one escalation, including after downtime. Trashed scopes stay suspended.
      const stale = await tx.select({ id: paymentSubmissions.id, enrolmentId: paymentSubmissions.enrolmentId }).from(paymentSubmissions).innerJoin(enrolments, eq(enrolments.id, paymentSubmissions.enrolmentId)).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(and(eq(paymentSubmissions.status, "PENDING_REVIEW"), lt(paymentSubmissions.submittedAt, new Date(now().getTime() - 48 * 60 * 60_000)), isNull(intakes.trashedAt), isNull(programmes.trashedAt), sql`not exists (select 1 from follow_up_tasks t where t.dedupe_key = 'STALE_REVIEW:' || ${paymentSubmissions.id}::text)`)).orderBy(asc(paymentSubmissions.submittedAt)).limit(50);
      for (const sub of stale) await upsertTask(tx, { enrolmentId: sub.enrolmentId, type: "STALE_REVIEW", dueAt: now(), priority: 1, dedupeKey: `STALE_REVIEW:${sub.id}`, reason: "Payment evidence pending for over 48 hours; review required, not rejection." });
      const processed = queue.items.length + promises.length + stale.length;
      await audit(tx, { actorType: "SYSTEM", action: "FOLLOWUP_JOBS_COMPLETED", entityType: "job_run", entityId: runId, after: { scheduled, stale: stale.length, promises: promises.length } });
      await tx.update(jobRuns).set({ status: "SUCCEEDED", finishedAt: now(), processed, details: { queueCursor: queue.nextCursor, promiseCursor: promises.length === 50 ? promises.at(-1)!.enrolmentId : null, maintenanceCursor: maintenance.length === 50 ? maintenance.at(-1)!.enrolmentId : null, scheduled, stale: stale.length } }).where(eq(jobRuns.id, runId));
      await tx.update(jobLeases).set({ holder: null, expiresAt: null }).where(and(eq(jobLeases.job, JOB), eq(jobLeases.holder, holder)));
      return { skipped: false, processed, scheduled, stale: stale.length, hasMore: !!queue.nextCursor || promises.length === 50 || stale.length === 50 };
    });
  } catch (error) {
    await withTx(async tx => {
      await tx.update(jobRuns).set({ status: "FAILED", finishedAt: now(), error: "Follow-up batch failed; retry with the same persistent cursors." }).where(eq(jobRuns.id, runId));
      await tx.update(jobLeases).set({ holder: null, expiresAt: null }).where(and(eq(jobLeases.job, JOB), eq(jobLeases.holder, holder)));
    });
    throw error;
  }
}
