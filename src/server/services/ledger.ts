import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import {
  chargeAdjustments, exemptionApplications, instalments, paymentAllocations, paymentEvents, paymentSubmissions,
} from "@/db/schema";
import { computeInstalment, summarize, type EnrolmentSummary, type InstalmentView } from "@/domain/finance";
import { businessDate, type BizDate } from "@/lib/time";

export interface EnrolmentLedger {
  enrolmentId: string;
  instalments: InstalmentView[];
  summary: EnrolmentSummary;
}

/**
 * Load the authoritative ledger projection for one or more enrolments with a fixed
 * number of queries (no N+1). Pass `lock` inside a transaction to lock the instalment rows
 * in deterministic (enrolment, sequence) order before reading.
 */
export async function loadLedgers(tx: DbOrTx, enrolmentIds: readonly string[], opts: { today?: BizDate; lock?: boolean } = {}): Promise<Map<string, EnrolmentLedger>> {
  const today = opts.today ?? businessDate();
  const out = new Map<string, EnrolmentLedger>();
  if (!enrolmentIds.length) return out;
  const ids = [...new Set(enrolmentIds)].sort();

  const base = tx.select().from(instalments).where(inArray(instalments.enrolmentId, ids)).orderBy(asc(instalments.enrolmentId), asc(instalments.sequence));
  const rows = opts.lock ? await base.for("update") : await base;

  const adj = await tx.select({
    instalmentId: chargeAdjustments.instalmentId,
    total: sql<string>`coalesce(sum(${chargeAdjustments.amountMinor}), 0)`,
    cancels: sql<number>`count(*) filter (where ${chargeAdjustments.kind} = 'WITHDRAWAL_CANCEL' and ${chargeAdjustments.reversesId} is null)`,
  }).from(chargeAdjustments).where(inArray(chargeAdjustments.enrolmentId, ids)).groupBy(chargeAdjustments.instalmentId);

  const ex = await tx.select({ instalmentId: exemptionApplications.instalmentId, total: sql<string>`coalesce(sum(${exemptionApplications.amountMinor}), 0)` })
    .from(exemptionApplications).where(and(inArray(exemptionApplications.enrolmentId, ids), isNull(exemptionApplications.reversedAt))).groupBy(exemptionApplications.instalmentId);

  const al = await tx.select({ instalmentId: paymentAllocations.instalmentId, total: sql<string>`coalesce(sum(${paymentAllocations.amountMinor}), 0)` })
    .from(paymentAllocations).where(and(inArray(paymentAllocations.enrolmentId, ids), isNull(paymentAllocations.reversedAt))).groupBy(paymentAllocations.instalmentId);

  const pend = await tx.select({ instalmentId: paymentSubmissions.targetInstalmentId, total: sql<string>`coalesce(sum(${paymentSubmissions.claimedMinor}), 0)` })
    .from(paymentSubmissions).where(and(inArray(paymentSubmissions.enrolmentId, ids), eq(paymentSubmissions.status, "PENDING_REVIEW"))).groupBy(paymentSubmissions.targetInstalmentId);

  // Unreversed verified receipts per enrolment (receipt/historical minus reversals).
  const rec = await tx.select({
    enrolmentId: paymentEvents.enrolmentId,
    total: sql<string>`coalesce(sum(case when ${paymentEvents.kind} = 'REVERSAL' then -${paymentEvents.amountMinor} else ${paymentEvents.amountMinor} end), 0)`,
  }).from(paymentEvents).where(inArray(paymentEvents.enrolmentId, ids)).groupBy(paymentEvents.enrolmentId);

  const n = (m: Map<string, string>, k: string) => Number(m.get(k) ?? 0);
  const adjM = new Map(adj.map((r) => [r.instalmentId, r.total]));
  const cancelM = new Map(adj.map((r) => [r.instalmentId, Number(r.cancels)]));
  const exM = new Map(ex.map((r) => [r.instalmentId, r.total]));
  const alM = new Map(al.map((r) => [r.instalmentId, r.total]));
  const pendM = new Map(pend.map((r) => [r.instalmentId, r.total]));
  const recM = new Map(rec.map((r) => [r.enrolmentId, r.total]));

  const grouped = new Map<string, InstalmentView[]>();
  for (const r of rows) {
    const v = computeInstalment({
      id: r.id, sequence: r.sequence, periodLabel: r.periodLabel, component: r.component, dueDate: r.dueDate,
      originalChargeMinor: r.originalChargeMinor, adjustmentsMinor: n(adjM, r.id), cancelledByAdjustment: (cancelM.get(r.id) ?? 0) > 0,
      exemptionsMinor: n(exM, r.id), allocatedMinor: n(alM, r.id), pendingClaimedMinor: n(pendM, r.id),
    }, today);
    const list = grouped.get(r.enrolmentId) ?? [];
    list.push(v);
    grouped.set(r.enrolmentId, list);
  }
  for (const id of ids) {
    const views = grouped.get(id) ?? [];
    out.set(id, { enrolmentId: id, instalments: views, summary: summarize(views, n(recM, id), today) });
  }
  return out;
}

export async function loadLedger(tx: DbOrTx, enrolmentId: string, opts: { today?: BizDate; lock?: boolean } = {}): Promise<EnrolmentLedger> {
  const m = await loadLedgers(tx, [enrolmentId], opts);
  return m.get(enrolmentId)!;
}
