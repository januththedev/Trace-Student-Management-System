import { withTx } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { PRIVATE_HEADERS, route } from "@/server/http";
import { freshDirectoryPrincipal } from "@/server/services/directory";
import { exportReportCsv } from "@/server/services/reports/exports";

export const GET = route(async (req, ctx) => {
  const principal = await requireStaff(req);
  const result = await withTx(async tx => {
    const actor = await freshDirectoryPrincipal(tx, principal);
    return exportReportCsv(tx, actor, { report: "students", fullIdentifiers: false }, { requestId: ctx.requestId });
  });
  return new Response(result.csv, { headers: {
    ...PRIVATE_HEADERS,
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${result.filename}"`,
  } });
});
