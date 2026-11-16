import { withTx } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { route, parseBody } from "@/server/http";
import { ExportRequestSchema, exportReportCsv } from "@/server/services/reports/exports";
import { exportPrincipal } from "@/server/services/reports/export-jobs";

/** Authorized CSV export; permission is rechecked on every request and every export is audited. */
export const POST = route(async (req, { requestId }) => {
  const p = await requireStaff(req);
  const input = await parseBody(req, ExportRequestSchema);
  const r = await withTx(async tx => exportReportCsv(tx, await exportPrincipal(tx, p.id, p), input, { requestId }));
  return new Response(r.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${r.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Row-Count": String(r.rowCount),
    },
  });
});
