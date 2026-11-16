import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { idempotencyRecords } from "@/db/schema";
import { hashToken } from "@/lib/crypto";
import { AppError } from "@/server/http";
import { z } from "zod";

export const operationKey = z.string().min(8).max(200);

/** Transaction-scoped key lock also covers operations without the governance lock. */
export async function once<T>(tx: Tx, scope: string, key: string, input: unknown, work: () => Promise<T>): Promise<T> {
  operationKey.parse(key);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${scope}:${key}`}, 0))`);
  const digest = hashToken(JSON.stringify(input), "staff-operation");
  const [existing] = await tx.select().from(idempotencyRecords).where(and(eq(idempotencyRecords.scope, scope), eq(idempotencyRecords.key, key)));
  if (existing) {
    if (existing.requestHash !== digest) throw new AppError("IDEMPOTENCY_MISMATCH", "This request key was already used for different values.");
    return existing.response as T;
  }
  const response = await work();
  // Persist JSON-shaped data only; secrets must never be returned from work().
  const stored = JSON.parse(JSON.stringify(response)) as T;
  await tx.insert(idempotencyRecords).values({ scope, key, requestHash: digest, response: stored, status: 200 });
  return stored;
}
