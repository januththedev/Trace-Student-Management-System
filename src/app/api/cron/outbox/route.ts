import { and, eq, sql } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import { jobRuns, outboxEvents } from "@/db/schema";
import { requireCron } from "@/server/cron";
import { route, json } from "@/server/http";

/**
 * Outbox delivery. Portal events are delivered by the in-app notification row written in the
 * business transaction, so they are marked SENT. Email/SMS adapters are disabled unless configured
 * (EMAIL_ENABLED/SMS_ENABLED); events for disabled channels are SKIPPED, never faked.
 * Claim + update run in ONE transaction (FOR UPDATE SKIP LOCKED), and counts use rows actually updated,
 * so overlapping workers never double-process or double-count an event.
 */
export const GET = route(async (req) => {
  requireCron(req);
  const [run] = await db().insert(jobRuns).values({ job: "outbox", status: "RUNNING" }).returning();
  try {
    const r = await withTx(async (tx) => {
      const due = await tx.execute<{ id: string; channel: string }>(sql`
        select id, channel from outbox_events where status = 'PENDING' and next_attempt_at <= now()
        order by created_at limit 200 for update skip locked`);
      let sent = 0, skipped = 0;
      for (const e of due) {
        const portal = e.channel === "portal";
        const upd = await tx.update(outboxEvents)
          .set(portal ? { status: "SENT", sentAt: new Date(), attempts: sql`${outboxEvents.attempts} + 1` } : { status: "SKIPPED", lastError: "channel not enabled" })
          .where(and(eq(outboxEvents.id, e.id), eq(outboxEvents.status, "PENDING"))).returning({ id: outboxEvents.id });
        if (upd.length) { if (portal) sent++; else skipped++; }
      }
      return { sent, skipped };
    });
    await db().update(jobRuns).set({ status: "SUCCEEDED", finishedAt: new Date(), processed: r.sent + r.skipped, details: r }).where(eq(jobRuns.id, run.id));
    return json(r);
  } catch (e) {
    await db().update(jobRuns).set({ status: "FAILED", finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) }).where(eq(jobRuns.id, run.id));
    throw e;
  }
});
