import { requireCron } from "@/server/cron";
import { json, route } from "@/server/http";
import { runReceiptArchive } from "@/server/services/receipt-archive";
import { refreshStorageUsage } from "@/server/services/storage-usage";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Daily, bounded archival and actual bucket inventory; safe to replay after downtime. */
export const GET = route(async (req) => {
  requireCron(req);
  const batches = [];
  let archiveFailed = false;
  try {
    for (let i = 0; i < 4; i++) {
      const batch = await runReceiptArchive({ limit: 25 });
      batches.push(batch);
      if (!batch.hasMore || batch.failed) break;
    }
  } catch {
    // Still record unavailable/stale capacity when provider setup prevents archival.
    archiveFailed = true;
  }
  const storage = await refreshStorageUsage({ force: true });
  const failed = archiveFailed || batches.some(batch => batch.failed > 0) || storage.state === "failed";
  return json({ batches, archiveFailed, storage }, { status: failed ? 503 : 200 });
});
