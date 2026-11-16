import "dotenv/config";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { asc, eq, sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client";
import { enrolments, staffAccounts, staffScopes } from "../src/db/schema";
import type { StaffPrincipal, Capability } from "../src/server/auth/policy";
import { loadLedgers } from "../src/server/services/ledger";
import { pendingQueue, queueFilters } from "../src/server/services/review";
import { getCommandCentreMetrics } from "../src/server/services/reports/metrics";
import { balanceMetricsQuery } from "../src/server/services/reports/balances";
import { getCallQueue } from "../src/server/services/followups/queue";

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" }, explain: { type: "boolean" } }, strict: true });
  if (!values.url) throw new Error("--url of the disposable performance database is required.");
  if (!decodeURIComponent(new URL(values.url).pathname).endsWith("_perf")) throw new Error("Expected a performance database ending in _perf.");
  process.env.DATABASE_URL = values.url;
  process.env.T2T_FAKE_NOW = "2026-11-15T04:30:00Z";
  const counts = await db().execute(sql`select (select count(*) from students)::int students, (select count(*) from instalments)::int instalments`);
  console.log("Dataset:", counts[0]);
  assert(Number(counts[0].students) >= 10000 && Number(counts[0].instalments) >= 50000, "Dataset is below the required volume");
  const staff = await db().select().from(staffAccounts).orderBy(asc(staffAccounts.email));
  async function principal(role: "SUPER_ADMIN" | "ADMIN"): Promise<StaffPrincipal> {
    const a = staff.find(s => s.role === role && s.status === "ACTIVE" && !s.trashedAt);
    if (!a) throw new Error(`Missing ${role} performance principal`);
    const scopes = await db().select({ programmeId: staffScopes.programmeId, intakeId: staffScopes.intakeId }).from(staffScopes).where(eq(staffScopes.staffId, a.id));
    return { kind: "staff", id: a.id, name: a.name, email: a.email, role, capabilities: new Set(a.capabilities as Capability[]), scopes, authVersion: a.authVersion, sessionId: randomUUID(), csrfSecret: "performance-operator" };
  }
  const superAdmin = await principal("SUPER_ADMIN"), admin = await principal("ADMIN");
  assert(admin.scopes.length > 0, "Scoped Admin must have a scope");
  if (values.explain) {
    for (const p of [superAdmin, admin]) {
      console.log(`EXPLAIN ANALYZE / ${p.role} / financial aggregates`);
      const plan = await db().execute(sql`explain (analyze, buffers, format text) ${balanceMetricsQuery(p, "2026-11-15")}`);
      console.log(plan.map(row => row["QUERY PLAN"]).join("\n"));
    }
    return;
  }
  const ids = (await db().select({ id: enrolments.id }).from(enrolments).orderBy(asc(enrolments.id)).limit(50)).map(e => e.id);
  const cases: [string, () => Promise<unknown>][] = [
    ["loadLedgers / 50 enrolments", async () => { const result = await loadLedgers(db(), ids); assert.equal(result.size, 50); }],
    ["pendingQueue / first 50", async () => { const result = await pendingQueue(db(), superAdmin, queueFilters.parse({ limit: 50 })); assert(result.items.length > 0); }],
    ["metrics / Super Admin", async () => { const result = await getCommandCentreMetrics(db(), superAdmin); assert.equal(result.totalRegisteredStudents, 10000); }],
    ["metrics / scoped Admin", async () => { const result = await getCommandCentreMetrics(db(), admin); assert(result.totalRegisteredStudents > 0 && result.totalRegisteredStudents < 10000); }],
    ["call queue / first 50 scanned", async () => { const result = await getCallQueue(superAdmin, { limit: 50 }); assert(result.items.length > 0); }],
  ];
  console.log(`Machine: ${os.hostname()}, ${os.platform()} ${os.release()}, ${os.arch()}, ${os.cpus()[0]?.model}, ${os.cpus().length} logical CPUs, ${Math.round(os.totalmem() / 1024 ** 3)} GiB RAM; Node ${process.version}`);
  console.log("Conditions: local Postgres TCP; one warmup per case; 20 sequential measured runs; warm DB/OS caches; no application result cache; as-of 2026-11-15; assertions included; no concurrent-load simulation.");
  const output = [];
  for (const [name, run] of cases) {
    await run();
    const durations: number[] = [];
    for (let i = 0; i < 20; i++) { const start = performance.now(); await run(); durations.push(performance.now() - start); }
    durations.sort((a, b) => a - b);
    output.push({ query: name, runs: 20, "p50 ms": Number(durations[Math.ceil(20 * 0.5) - 1].toFixed(2)), "p95 ms": Number(durations[Math.ceil(20 * 0.95) - 1].toFixed(2)), "max ms": Number(durations.at(-1)!.toFixed(2)) });
  }
  console.table(output);
  console.log("Sub-second target:", output.every(row => row["p95 ms"] < 1000) ? "PASS for these conditions" : "NOT MET; investigate the reported slow queries");
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Performance check failed"); process.exitCode = 1; }).finally(closeDb);
