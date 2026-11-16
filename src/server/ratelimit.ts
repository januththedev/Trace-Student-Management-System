import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { hmacHex } from "@/lib/crypto";

/**
 * Fixed-window counter in PostgreSQL (shared across serverless instances = distributed).
 * Keys are HMAC'd so raw NICs/IPs never land in the table. Windows expire — no permanent lockout.
 */
export async function hit(bucket: string, rawKey: string, limit: number, windowSec: number): Promise<{ allowed: boolean; remaining: number }> {
  const key = `${bucket}:${hmacHex(rawKey, "ratelimit").slice(0, 40)}`;
  const rows = await db().execute<{ count: number }>(sql`
    insert into rate_limit_buckets (key, count, window_start) values (${key}, 1, now())
    on conflict (key) do update set
      count = case when rate_limit_buckets.window_start < now() - make_interval(secs => ${windowSec}) then 1 else rate_limit_buckets.count + 1 end,
      window_start = case when rate_limit_buckets.window_start < now() - make_interval(secs => ${windowSec}) then now() else rate_limit_buckets.window_start end
    returning count`);
  const count = Number(rows[0]?.count ?? 1);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

export const STUDENT_ENTRY_LIMITS = {
  perIp: { limit: Number(process.env.RL_ENTRY_IP ?? 30), windowSec: 15 * 60 },
  perIdentity: { limit: Number(process.env.RL_ENTRY_IDENTITY ?? 8), windowSec: 15 * 60 },
};

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim();
}
