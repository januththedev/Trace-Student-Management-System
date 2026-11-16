import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;
/** A transaction handle has the same query API as DB. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type DbOrTx = DB | Tx;

const g = globalThis as unknown as { __t2tSql?: postgres.Sql; __t2tDb?: DB; __t2tUrl?: string };

export function sqlClient(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  // Pool is keyed by URL (tests switch databases per file within one worker).
  if (g.__t2tSql && g.__t2tUrl !== url) {
    void g.__t2tSql.end({ timeout: 1 }).catch(() => {});
    g.__t2tSql = undefined;
    g.__t2tDb = undefined;
  }
  if (!g.__t2tSql) {
    g.__t2tUrl = url;
    g.__t2tSql = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 10), prepare: false, onnotice: () => {} });
  }
  return g.__t2tSql;
}

export function db(): DB {
  const client = sqlClient();
  if (!g.__t2tDb) g.__t2tDb = drizzle(client, { schema });
  return g.__t2tDb;
}

/** Close pool (tests/scripts). */
export async function closeDb() {
  if (g.__t2tSql) await g.__t2tSql.end({ timeout: 5 });
  g.__t2tSql = undefined;
  g.__t2tDb = undefined;
}

const RETRYABLE = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected

/** Run fn in a transaction, retrying serialization/deadlock failures with jittered backoff. */
export async function withTx<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: { isolation?: "read committed" | "repeatable read" | "serializable"; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db().transaction(fn, { isolationLevel: opts.isolation ?? "read committed" });
    } catch (e) {
      const code = pgCode(e);
      if (code && RETRYABLE.has(code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
        continue;
      }
      throw e;
    }
  }
}

export function pgCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
export const isUniqueViolation = (e: unknown) => pgCode(e) === "23505";
