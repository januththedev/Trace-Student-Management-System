import { withTx } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { route, parseBody } from "@/server/http";
import { z } from "zod";
import { ExportRequestSchema, exportReportCsv, exportReportData } from "@/server/services/reports/exports";
import { exportPrincipal } from "@/server/services/reports/export-jobs";
import { renderReportPdf } from "@/server/services/reports/pdf";

const DownloadSchema = ExportRequestSchema.extend({ format: z.enum(["csv", "pdf"]).default("csv") });

/** Both formats recheck current authorization, use scoped data, and record the format in audit. */
export const POST = route(async (req, { requestId }) => {
  const p = await requireStaff(req);
  const { format, ...input } = await parseBody(req, DownloadSchema);
  if (format === "pdf") {
    const result = await withTx(async tx => {
      const data = await exportReportData(tx, await exportPrincipal(tx, p.id, p), input, { requestId, format });
      return { data, bytes: await renderReportPdf(data) };
    });
    return new Response(new Uint8Array(result.bytes), { headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.data.filename}"`,
      "Cache-Control": "private, no-store", "Vary": "Cookie",
      "X-Row-Count": String(result.data.rowCount),
    } });
  }
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
