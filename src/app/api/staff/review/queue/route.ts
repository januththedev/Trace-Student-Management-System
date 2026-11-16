import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { route, json } from "@/server/http";
import { pendingQueue, queueFilters } from "@/server/services/review";

export const GET = route(async (req) => {
  const p = await requireStaff();
  const sp = new URL(req.url).searchParams;
  const f = queueFilters.parse({
    programmeId: sp.get("programmeId") || undefined, intakeId: sp.get("intakeId") || undefined, period: sp.get("period") || undefined,
    from: sp.get("from") || undefined, to: sp.get("to") || undefined, flagged: sp.get("flagged") || undefined,
    cursor: sp.get("cursor") || undefined, limit: sp.get("limit") || undefined, skip: sp.getAll("skip"),
  });
  return json(await pendingQueue(db(), p, f));
});
