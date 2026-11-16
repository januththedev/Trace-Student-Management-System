import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { createExportJob } from "@/server/services/reports/export-jobs";
import { ExportRequestSchema } from "@/server/services/reports/exports";

export const POST = route(async (req, { requestId }) => {
  const p = await requireStaff(req);
  const job = await createExportJob(p, await parseBody(req, ExportRequestSchema), idempotencyKey(req), requestId);
  return json(job, { status: 202 });
});
