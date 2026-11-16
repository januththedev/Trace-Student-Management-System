/** Apply checked-in migrations using a direct connection when configured. */
import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

async function main() {
  const i = process.argv.indexOf("--url");
  const explicitUrl = i > -1 ? process.argv[i + 1] : undefined;
  if (i > -1 && (!explicitUrl || explicitUrl.startsWith("--"))) throw new Error("--url requires a connection URL");
  const url = explicitUrl ?? (process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim());
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log("migrations applied");
}
main().catch(() => {
  // Driver errors can contain connection details; never print credentials.
  console.error("Migration failed. Verify the direct connection, permissions and checked-in migration chain.");
  process.exitCode = 1;
});
