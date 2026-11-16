import { db } from "@/db/client";
import { jobRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireCron } from "@/server/cron";
import { route, json } from "@/server/http";
import { cleanupOrphanUploads } from "@/server/services/submissions";

export const GET = route(async (req) => {
  requireCron(req);
  const [run] = await db().insert(jobRuns).values({ job: "uploads-cleanup", status: "RUNNING" }).returning();
  try {
    const r = await cleanupOrphanUploads();
    await db().update(jobRuns).set({ status: "SUCCEEDED", finishedAt: new Date(), processed: r.cleaned, details: r }).where(eq(jobRuns.id, run.id));
    return json(r);
  } catch (e) {
    await db().update(jobRuns).set({ status: "FAILED", finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) }).where(eq(jobRuns.id, run.id));
    throw e;
  }
});
