import { requireStaff } from "@/server/auth/staff";
import { route } from "@/server/http";
import { downloadExportJob } from "@/server/services/reports/export-jobs";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params, requestId }) => {
  return downloadExportJob(await requireStaff(req), (await params).id, requestId);
});
