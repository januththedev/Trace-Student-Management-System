import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { adminUrl, e2eUrl, PROGRAMME_ID, STAFF_EMAIL, STAFF_PASSWORD } from "./environment";
import { programmes, staffAccounts } from "../../src/db/schema";
import { hashPassword } from "../../src/lib/crypto";

export default async function globalSetup() {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    try { await admin.unsafe('create database "t2t_e2e"'); }
    catch (e) { if ((e as { code?: string }).code !== "42P04") throw e; }
  } finally { await admin.end(); }
  if (new URL(e2eUrl).pathname !== "/t2t_e2e") throw new Error("Refusing to reset a non-e2e database");
  const client = postgres(e2eUrl, { max: 1, onnotice: () => {} });
  const database = drizzle(client);
  try {
    await migrate(database, { migrationsFolder: path.resolve("drizzle") });
    const tables = await database.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
    const names = tables.filter((t) => t.tablename !== "governance_lock").map((t) => `"${t.tablename.replaceAll('"', '""')}"`);
    if (names.length) await client.unsafe(`truncate ${names.join(", ")} restart identity cascade`);
    await database.insert(programmes).values({ id: PROGRAMME_ID, code: "ACCEPTANCE", name: "Acceptance Course", isPublic: true });
    await database.insert(staffAccounts).values({ email: STAFF_EMAIL, name: "Acceptance Super Admin", role: "SUPER_ADMIN", passwordHash: await hashPassword(STAFF_PASSWORD) });
    await database.execute(sql`update governance_lock set bootstrapped_at = now()`);
  } finally { await client.end(); }
}

