import { requireCron } from "@/server/cron";
import { fail, json, route } from "@/server/http";
import { runExportJobs } from "@/server/services/reports/export-jobs";

export const maxDuration = 300;
export const GET = route(async req => {
  if (!/^Bearer\s+\S+$/i.test(req.headers.get("authorization") ?? "")) throw fail.unauth();
  requireCron(req);
  return json(await runExportJobs());
});
