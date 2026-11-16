import "server-only";
import { safeEqual } from "@/lib/crypto";
import { fail } from "@/server/http";

/** Scheduler invocations must carry `Authorization: Bearer <CRON_SECRET>`. */
export function requireCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw fail.unauth();
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(got, secret)) throw fail.unauth();
}
