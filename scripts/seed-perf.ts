/** Disposable performance DB only. Bulk fixtures intentionally bypass operational services. */
import "dotenv/config";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as s from "../src/db/schema";
import { encryptNic, nicLookup, hashPassword } from "../src/lib/crypto";
import { maskNic, isValidNicFormat } from "../src/lib/nic";

/** Compare database identity, including localhost aliases and URL encoding. */
export function databaseIdentity(raw: string): string {
  const u = new URL(raw);
  const host = ["localhost", "::1", "[::1]", "127.0.0.1"].includes(u.hostname) ? "loopback" : u.hostname.toLowerCase();
  return `${host}:${u.port || "5432"}/${decodeURIComponent(u.pathname.slice(1))}`;
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" } }, strict: true });
  if (process.env.NODE_ENV === "production") throw new Error("Performance seeding is forbidden in production.");
  if (!values.url || !process.env.DATABASE_URL) throw new Error("--url and DATABASE_URL are required.");
  if (databaseIdentity(values.url) === databaseIdentity(process.env.DATABASE_URL)) throw new Error("Performance database must differ from DATABASE_URL.");
  const target = new URL(values.url);
  if (!decodeURIComponent(target.pathname).endsWith("_perf")) throw new Error("Use an explicitly disposable database whose name ends in _perf.");
  const client = postgres(values.url, { max: 1, onnotice: () => {} });
  const db = drizzle(client);
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(882711)`);
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(s.students);
      const [{ staff }] = await tx.select({ staff: sql<number>`count(*)::int` }).from(s.staffAccounts);
      if (count || staff) throw new Error("Performance seed requires a new, migrated empty database; no data is deleted.");
      const passwordHash = await hashPassword("Performance-fixtures-only!");
      const [superAdmin, admin] = await tx.insert(s.staffAccounts).values([
        { email: "perf-super@example.test", name: "Performance Super Admin", role: "SUPER_ADMIN", passwordHash },
        { email: "perf-admin@example.test", name: "Performance Admin", role: "ADMIN", passwordHash, capabilities: ["exports.download", "exemptions.manage"] },
      ]).returning();
      await tx.execute(sql`update governance_lock set bootstrapped_at = now() where id = 1`);
      const programmes = await tx.insert(s.programmes).values(Array.from({ length: 4 }, (_, i) => ({ code: `PERF-${i}`, name: `Synthetic Performance Programme ${i + 1}` }))).returning();
      await tx.insert(s.staffScopes).values({ staffId: admin.id, programmeId: programmes[0].id });
      const intakes = await tx.insert(s.intakes).values(programmes.flatMap(p => [0, 1].map(i => ({ programmeId: p.id, code: `PERF-${i}`, label: `Synthetic Batch ${i + 1}`, startDate: "2026-10-01", endDate: "2027-03-31" })))).returning();
      const plans = await tx.insert(s.feePlanVersions).values(intakes.map(i => ({ intakeId: i.id, versionNo: 1, createdBy: superAdmin.id }))).returning();
      const dates = ["2026-10-05", "2026-11-05", "2026-12-05", "2027-01-05", "2027-02-05", "2027-03-05"];
      const planItems = await tx.insert(s.feePlanItems).values(plans.flatMap(p => dates.map((date, i) => ({ versionId: p.id, sequence: i + 1, periodLabel: date.slice(0, 7), amountMinor: 1_000_000, dueDate: date })))).returning();
      const planByIntake = new Map(plans.map(p => [p.intakeId, p]));
      const itemsByPlan = new Map(plans.map(p => [p.id, planItems.filter(i => i.versionId === p.id)]));
      for (let start = 0; start < 10_000; start += 250) {
        const people: (typeof s.students.$inferInsert)[] = [];
        const enrolments: (typeof s.enrolments.$inferInsert & { id: string })[] = [];
        const instalments: (typeof s.instalments.$inferInsert & { id: string })[] = [];
        const submissions: (typeof s.paymentSubmissions.$inferInsert & { id: string })[] = [];
        const actions: (typeof s.reviewActions.$inferInsert)[] = [];
        const events: (typeof s.paymentEvents.$inferInsert & { id: string })[] = [];
        const allocations: (typeof s.paymentAllocations.$inferInsert)[] = [];
        const tasks: (typeof s.followUpTasks.$inferInsert)[] = [];
        for (let n = start; n < start + 250; n++) {
          const nic = `1999001${String(n).padStart(5, "0")}`;
          if (!isValidNicFormat(nic)) throw new Error("Invalid synthetic identity");
          const studentId = randomUUID(), enrolmentId = randomUUID();
          people.push({ id: studentId, ref: `PERF-${String(n).padStart(6, "0")}`, fullName: `Synthetic Student ${n}`, nicEnc: encryptNic(nic), nicLookup: nicLookup(nic), nicMasked: maskNic(nic), phone: `+94 77 000 ${String(n).padStart(4, "0")}`, email: `perf${n}@example.test` });
          const intake = intakes[n % intakes.length];
          const plan = planByIntake.get(intake.id)!;
          enrolments.push({ id: enrolmentId, studentId, intakeId: intake.id, feePlanVersionId: plan.id, termsSnapshot: { fixture: "synthetic-performance" } });
          const items = itemsByPlan.get(plan.id)!;
          const obligations = items.map(item => ({ id: randomUUID(), enrolmentId, feePlanItemId: item.id, sequence: item.sequence, periodLabel: item.periodLabel, originalChargeMinor: item.amountMinor, dueDate: item.dueDate }));
          instalments.push(...obligations);
          // Honest historical placeholders: no fake image or claim of scanner validation.
          const approved = n % 4 < 2;
          const amount = n % 4 === 0 ? 2_000_000 : n % 4 === 1 ? 400_000 : 1_000_000;
          const submissionId = randomUUID(), actionId = randomUUID(), eventId = randomUUID();
          submissions.push({ id: submissionId, enrolmentId, targetInstalmentId: obligations[0].id, claimedMinor: amount, transferDate: "2026-11-10", bankReference: `PERF-SYNTHETIC-${n}`, status: approved ? "APPROVED" : n % 4 === 2 ? "PENDING_REVIEW" : "REJECTED", idempotencyKey: `perf-${n}`, isHistoricalImport: true, flags: ["SYNTHETIC_PERFORMANCE", "MISSING_ORIGINAL_EVIDENCE"], version: n % 4 === 2 ? 1 : 2, submittedAt: new Date("2026-11-10T04:00:00Z"), decidedBy: n % 4 === 2 ? null : superAdmin.id, decidedAt: n % 4 === 2 ? null : new Date("2026-11-11T04:00:00Z") });
          if (n % 4 !== 2) actions.push({ id: actionId, submissionId, kind: approved ? "APPROVE" : "REJECT", actorId: superAdmin.id, reason: "Synthetic performance fixture", submissionVersion: 1, confirmedMinor: approved ? amount : null });
          if (approved) {
            events.push({ id: eventId, enrolmentId, submissionId, kind: "HISTORICAL_IMPORT", amountMinor: amount, claimedMinor: amount, reviewActionId: actionId, sourceReference: `PERF-SYNTHETIC-${n}`, effectiveDate: "2026-11-11", actorId: superAdmin.id });
            allocations.push({ enrolmentId, instalmentId: obligations[0].id, paymentEventId: eventId, amountMinor: Math.min(amount, 1_000_000), source: "HISTORICAL_IMPORT", actorId: superAdmin.id });
            if (amount > 1_000_000) allocations.push({ enrolmentId, instalmentId: obligations[1].id, paymentEventId: eventId, amountMinor: amount - 1_000_000, source: "HISTORICAL_IMPORT", actorId: superAdmin.id });
          }
          if (n % 4 !== 0) tasks.push({ enrolmentId, type: "COLLECTION_CALL", dedupeKey: `PERF:${enrolmentId}`, dueAt: new Date("2026-11-15T03:30:00Z"), reason: "Synthetic overdue follow-up", ownerId: admin.id });
        }
        await tx.insert(s.students).values(people);
        await tx.insert(s.enrolments).values(enrolments);
        await tx.insert(s.instalments).values(instalments);
        await tx.insert(s.paymentSubmissions).values(submissions);
        await tx.insert(s.reviewActions).values(actions);
        await tx.insert(s.paymentEvents).values(events);
        await tx.insert(s.paymentAllocations).values(allocations);
        await tx.insert(s.followUpTasks).values(tasks);
        if ((start + 250) % 2500 === 0) console.log(`Prepared ${start + 250} students in transaction`);
      }
      await tx.insert(s.auditEvents).values({ actorType: "SYSTEM", action: "seed.performance", entityType: "database", after: { students: 10000, enrolments: 10000, instalments: 60000, submissions: 10000, historicalPayments: 5000, allocations: 7500 } });
    });
    await client`analyze`;
    const [counts] = await client`select (select count(*) from students)::int students, (select count(*) from instalments)::int instalments, (select count(*) from payment_submissions)::int submissions, (select count(*) from payment_events)::int payments, (select count(*) from payment_allocations)::int allocations`;
    console.log("Performance fixtures committed; ANALYZE complete.", counts);
  } finally { await client.end(); }
}

main().catch(e => { console.error(e instanceof Error ? e.message : "Performance seed failed"); process.exitCode = 1; });
