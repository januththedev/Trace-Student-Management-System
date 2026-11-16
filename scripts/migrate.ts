/** Apply checked-in migrations. Usage: pnpm db:migrate [--url <DATABASE_URL>] */
import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

async function main() {
  const i = process.argv.indexOf("--url");
  const url = i > -1 ? process.argv[i + 1] : process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
  console.log("migrations applied");
}
main().catch((e) => { console.error(e); process.exit(1); });
