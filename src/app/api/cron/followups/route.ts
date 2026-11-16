import { safeEqual } from "@/lib/crypto";
import { fail, json, route } from "@/server/http";
import { runFollowUpJobs } from "@/server/services/followups/jobs";

export const maxDuration = 60;
export const POST = route(async req => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) throw fail.unauth();
  return json(await runFollowUpJobs());
});
export const GET = POST;
