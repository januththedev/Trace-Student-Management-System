import { safeEqual } from "@/lib/crypto";
import { fail, json, route } from "@/server/http";
import { runPurgeJob } from "@/server/services/trash/purge";

export const runtime = "nodejs";
export const POST = route(async req => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) throw fail.unauth();
  const result = await runPurgeJob();
  return json(result, { status: result.failed ? 503 : 200 });
});

// Scheduled invocations use GET; operator clients may also use POST.
export const GET = POST;
