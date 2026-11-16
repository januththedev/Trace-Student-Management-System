/**
 * Read-only financial integrity / reconciliation command.
 *
 *   pnpm exec tsx scripts/reconcile.ts
 *
 * Compares payment events, allocations, credits, instalment projections (via loadLedgers)
 * and report totals. Prints every discrepancy and exits non-zero when any is found.
 * It never writes to the database.
 *
 * The service modules import `server-only`, so when this file starts without the
 * `react-server` export condition it re-executes itself with that condition. This keeps
 * the documented command working while leaving the runtime guard intact elsewhere.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EnrolmentLedger } from "../src/server/services/ledger";

const REACT_SERVER = "--conditions=react-server";
if (!process.execArgv.includes(REACT_SERVER) && !process.env.T2T_RECONCILE_CHILD) {
  const child = spawnSync(process.execPath, [REACT_SERVER, ...process.execArgv, __filename], {
    stdio: "inherit",
    env: { ...process.env, T2T_RECONCILE_CHILD: "1" },
  });
  process.exit(child.status ?? 1);
}

interface Discrepancy {
  area: string;
  message: string;
}

async function main() {
  const { db, closeDb } = await import("../src/db/client");
  const database = db();
  const { enrolments, intakes, programmes, paymentEvents, paymentAllocations, instalments, chargeAdjustments, exemptionApplications } = await import("../src/db/schema");
  const { loadLedgers } = await import("../src/server/services/ledger");
  const { businessDate } = await import("../src/lib/time");
  const { getCommandCentreMetrics } = await import("../src/server/services/reports/metrics");
  const { collectionRateReport, receiptsByApprovalDate } = await import("../src/server/services/reports/reports");
  const { and, eq, isNull, sql } = await import("drizzle-orm");

  const discrepancies: Discrepancy[] = [];
  const add = (area: string, message: string) => discrepancies.push({ area, message });
  const asOf = businessDate();

  const rows = await database.select({ id: enrolments.id }).from(enrolments).orderBy(enrolments.id);
  const ids = rows.map((r) => r.id);
  const reportRows = await database.select({ id: enrolments.id })
    .from(enrolments)
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(eq(enrolments.status, "ACTIVE"), isNull(intakes.trashedAt), isNull(programmes.trashedAt)))
    .orderBy(enrolments.id);
  const reportIds = reportRows.map((r) => r.id);

  // ---- 1. Instalment projections via the authoritative ledger -----------------
  let ledgers = new Map<string, EnrolmentLedger>();
  try {
    ledgers = await loadLedgers(database, ids, { today: asOf });
  } catch {
    // Locate the individual broken ledger(s) so the report is actionable.
    for (const id of ids) {
      try {
        const one = await loadLedgers(database, [id], { today: asOf });
        for (const [k, v] of one) ledgers.set(k, v);
      } catch (inner) {
        add("LEDGER", `enrolment ${id}: ${inner instanceof Error ? inner.message : String(inner)}`);
      }
    }
  }

  // ---- 2. Active allocations vs payment events -------------------------------
  const allocByEvent = await database
    .select({
      eventId: paymentAllocations.paymentEventId,
      enrolmentId: paymentAllocations.enrolmentId,
      total: sql<string>`coalesce(sum(${paymentAllocations.amountMinor}) filter (where ${paymentAllocations.reversedAt} is null), 0)`,
    })
    .from(paymentAllocations)
    .groupBy(paymentAllocations.paymentEventId, paymentAllocations.enrolmentId);
  const eventRows = await database
    .select({ id: paymentEvents.id, enrolmentId: paymentEvents.enrolmentId, kind: paymentEvents.kind, amountMinor: paymentEvents.amountMinor })
    .from(paymentEvents);
  const eventById = new Map(eventRows.map((e) => [e.id, e]));

  for (const a of allocByEvent) {
    const ev = eventById.get(a.eventId);
    if (!ev) {
      add("ALLOCATION", `allocation references missing payment event ${a.eventId}`);
      continue;
    }
    if (ev.kind === "REVERSAL") {
      add("ALLOCATION", `enrolment ${a.enrolmentId}: active allocation ${a.total} references a REVERSAL event ${ev.id}`);
    } else if (Number(a.total) > ev.amountMinor) {
      add("ALLOCATION", `enrolment ${a.enrolmentId}: active allocations ${a.total} exceed event ${ev.id} amount ${ev.amountMinor}`);
    }
    if (ev.enrolmentId !== a.enrolmentId) {
      add("ALLOCATION", `allocation enrolment ${a.enrolmentId} does not match event enrolment ${ev.enrolmentId}`);
    }
  }

  // ---- 3. Reversal events ----------------------------------------------------
  const reversals = await database
    .select({ id: paymentEvents.id, reversesEventId: paymentEvents.reversesEventId, amountMinor: paymentEvents.amountMinor, enrolmentId: paymentEvents.enrolmentId })
    .from(paymentEvents)
    .where(sql`${paymentEvents.kind} = 'REVERSAL'`);
  const reversedTotals = new Map<string, number>();
  for (const r of reversals) {
    if (!r.reversesEventId) {
      add("REVERSAL", `reversal ${r.id} has no reverses_event_id`);
      continue;
    }
    const original = eventById.get(r.reversesEventId);
    if (!original) {
      add("REVERSAL", `reversal ${r.id} references missing event ${r.reversesEventId}`);
      continue;
    }
    if (original.enrolmentId !== r.enrolmentId) add("REVERSAL", `reversal ${r.id} enrolment differs from original event`);
    reversedTotals.set(r.reversesEventId, (reversedTotals.get(r.reversesEventId) ?? 0) + r.amountMinor);
  }
  for (const [eventId, total] of reversedTotals) {
    const original = eventById.get(eventId);
    if (original && total > original.amountMinor) {
      add("REVERSAL", `event ${eventId}: reversals ${total} exceed original amount ${original.amountMinor}`);
    }
  }

  // ---- 4. Ledger summaries vs raw event/allocation sums -----------------------
  const receiptByEnrolment = new Map<string, number>();
  for (const ev of eventRows) {
    const signed = ev.kind === "REVERSAL" ? -ev.amountMinor : ev.amountMinor;
    receiptByEnrolment.set(ev.enrolmentId, (receiptByEnrolment.get(ev.enrolmentId) ?? 0) + signed);
  }
  const allocByEnrolment = new Map<string, number>();
  for (const a of allocByEvent) allocByEnrolment.set(a.enrolmentId, (allocByEnrolment.get(a.enrolmentId) ?? 0) + Number(a.total));

  for (const [id, ledger] of ledgers) {
    const rawReceipts = receiptByEnrolment.get(id) ?? 0;
    const rawAlloc = allocByEnrolment.get(id) ?? 0;
    if (ledger.summary.collectedMinor !== rawReceipts) {
      add("CREDIT", `enrolment ${id}: ledger receipts ${ledger.summary.collectedMinor} != payment events ${rawReceipts}`);
    }
    if (ledger.summary.approvedAllocatedMinor !== rawAlloc) {
      add("CREDIT", `enrolment ${id}: ledger allocations ${ledger.summary.approvedAllocatedMinor} != allocation rows ${rawAlloc}`);
    }
    if (ledger.summary.creditMinor < 0) add("CREDIT", `enrolment ${id}: negative credit ${ledger.summary.creditMinor}`);
    if (ledger.summary.creditMinor !== rawReceipts - rawAlloc) {
      add("CREDIT", `enrolment ${id}: credit ${ledger.summary.creditMinor} != receipts ${rawReceipts} - allocations ${rawAlloc}`);
    }
  }

  // ---- 5. Report totals vs ledger totals -------------------------------------
  const principal = {
    kind: "staff" as const, id: randomUUID(), name: "Reconciliation", email: "reconcile@system.local",
    role: "SUPER_ADMIN" as const, capabilities: new Set<never>(), scopes: [] as const,
    authVersion: 1, sessionId: "", csrfSecret: "",
  };

  let ledgerOutstanding = 0, ledgerDueNow = 0, ledgerOverdue = 0;
  for (const id of reportIds) {
    const l = ledgers.get(id);
    if (!l) continue;
    ledgerOutstanding += l.summary.outstandingMinor;
    ledgerDueNow += l.summary.dueNowMinor;
    ledgerOverdue += l.summary.overdueMinor;
  }

  try {
    const metrics = await getCommandCentreMetrics(database, principal, { asOf });
    if (metrics.outstandingMinor !== ledgerOutstanding) {
      add("REPORT", `dashboard outstanding ${metrics.outstandingMinor} != ledger ${ledgerOutstanding}`);
    }
    if (metrics.dueNowMinor !== ledgerDueNow) {
      add("REPORT", `dashboard due-now ${metrics.dueNowMinor} != ledger ${ledgerDueNow}`);
    }
    if (metrics.overdueMinor !== ledgerOverdue) {
      add("REPORT", `dashboard overdue ${metrics.overdueMinor} != ledger ${ledgerOverdue}`);
    }
  } catch (e) {
    add("REPORT", `dashboard metrics failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Direct SQL reproduction of the due-through collection ratio, compared to the report.
  try {
    const direct = (await database.execute(sql`
      select
        coalesce(sum(case when i.due_date <= ${asOf} then
          i.original_charge_minor + coalesce(a.adj, 0) - coalesce(e.ex, 0) else 0 end), 0) as denom,
        coalesce(sum(case when i.due_date <= ${asOf} then
          least(coalesce(al.alloc, 0), i.original_charge_minor + coalesce(a.adj, 0) - coalesce(e.ex, 0))
          else 0 end), 0) as num
      from ${instalments} i
      inner join ${enrolments} en on en.id = i.enrolment_id
      inner join ${intakes} it on it.id = en.intake_id
      inner join ${programmes} pr on pr.id = it.programme_id
      left join (select instalment_id, sum(amount_minor) as adj from ${chargeAdjustments} group by instalment_id) a on a.instalment_id = i.id
      left join (select instalment_id, sum(amount_minor) as ex from ${exemptionApplications} where reversed_at is null group by instalment_id) e on e.instalment_id = i.id
      left join (select instalment_id, sum(amount_minor) as alloc from ${paymentAllocations} where reversed_at is null group by instalment_id) al on al.instalment_id = i.id
      where en.status = 'ACTIVE' and it.trashed_at is null and pr.trashed_at is null
    `)) as unknown as { denom: string; num: string }[];
    const rate = await collectionRateReport(database, principal, { asOf });
    if (Number(direct[0]?.denom ?? 0) !== rate.denominatorMinor) {
      add("REPORT", `collection-rate denominator ${rate.denominatorMinor} != direct net due ${direct[0]?.denom}`);
    }
    if (Number(direct[0]?.num ?? 0) !== rate.numeratorMinor) {
      add("REPORT", `collection-rate numerator ${rate.numeratorMinor} != direct allocated due ${direct[0]?.num}`);
    }
  } catch (e) {
    add("REPORT", `collection-rate cross-check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Receipts report net must equal raw payment-event net for an all-time window.
  try {
    const report = await receiptsByApprovalDate(database, principal, { from: "1900-01-01", to: "2999-12-31" });
    let rawNet = 0;
    for (const ev of eventRows) rawNet += ev.kind === "REVERSAL" ? -ev.amountMinor : ev.amountMinor;
    if (report.totals.netMinor !== rawNet) {
      add("REPORT", `receipts report net ${report.totals.netMinor} != payment events net ${rawNet}`);
    }
  } catch (e) {
    add("REPORT", `receipts report cross-check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- output ----------------------------------------------------------------
  console.log("T2T reconciliation (read-only)");
  console.log(`Business date: ${asOf}`);
  console.log(`All stored enrolments audited (all statuses and Trash): ${ids.length}`);
  console.log(`Active non-trashed enrolments compared with balance reports: ${reportIds.length}`);
  console.log(`Payment events checked: ${eventRows.length}`);
  console.log(`Active allocations checked: ${allocByEvent.length}`);
  console.log("");

  if (!discrepancies.length) {
    console.log("No discrepancies found.");
  } else {
    for (const d of discrepancies) console.log(`✗ [${d.area}] ${d.message}`);
    console.log("");
    console.log(`${discrepancies.length} discrepancy(ies) found. No data was modified.`);
  }

  await closeDb();
  process.exitCode = discrepancies.length ? 1 : 0;
}

main().catch((e) => {
  console.error("Reconciliation failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
