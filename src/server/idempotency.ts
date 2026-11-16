import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { idempotencyRecords } from "@/db/schema";
import { AppError } from "@/server/http";

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/**
 * Run `fn` at most once per (scope, key) inside the caller's transaction.
 * Replay with the same payload returns the original result; a different payload => IDEMPOTENCY_MISMATCH.
 * The record row is inserted first, so a concurrent duplicate blocks on the unique key until the first commits.
 */
export async function once<T>(tx: Tx, scope: string, key: string, payload: unknown, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
  const requestHash = hashPayload(payload);
  const inserted = await tx.insert(idempotencyRecords).values({ scope, key, requestHash }).onConflictDoNothing().returning({ key: idempotencyRecords.key });
  if (!inserted.length) {
    const [rec] = await tx.select().from(idempotencyRecords).where(and(eq(idempotencyRecords.scope, scope), eq(idempotencyRecords.key, key)));
    if (!rec || rec.requestHash !== requestHash) throw new AppError("IDEMPOTENCY_MISMATCH", "This request key was already used with different data.");
    if (rec.response === null || rec.response === undefined) throw new AppError("CONFLICT", "The original request is still being processed.");
    return { result: rec.response as T, replayed: true };
  }
  const result = await fn();
  await tx.update(idempotencyRecords).set({ response: sql`${JSON.stringify(result ?? null)}::jsonb`, status: 200 })
    .where(and(eq(idempotencyRecords.scope, scope), eq(idempotencyRecords.key, key)));
  return { result, replayed: false };
}
