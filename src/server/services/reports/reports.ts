import "server-only";
import { and, asc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import {
  callAttempts, enrolments, exemptionApplications, exemptionAwards, instalments, intakes,
  paymentAllocations, paymentEvents, paymentPromises, paymentSubmissions, programmes, reviewActions, students,
} from "@/db/schema";
import { intakeScopeWhere, type StaffPrincipal } from "@/server/auth/policy";
import {
  ageingBucket, collectionRate, type AgeingBucket, type InstalmentView,
} from "@/domain/finance";
import { addDays, businessDate, colomboInstant, isBizDate, type BizDate } from "@/lib/time";
import { fail } from "@/server/http";
import { loadEnrolmentProjection } from "./metrics";

/* ------------------------------------------------------------------ types */

export interface ReportFilters {
  from: BizDate;
  to: BizDate;
  programmeId?: string;
  intakeId?: string;
}

export interface BalanceOptions {
  asOf?: BizDate;
  programmeId?: string;
  intakeId?: string;
}

export type ReceiptBasis = "APPROVAL_DATE" | "TRANSFER_DATE";

export interface ReceiptDateRow {
  date: BizDate;
  receiptCount: number;
  receiptMinor: number;
  historicalCount: number;
  historicalMinor: number;
  reversalCount: number;
  correctionsMinor: number;
  claimedMinor: number;
  netMinor: number;
}

export interface ReceiptsReport {
  basis: ReceiptBasis;
  /** Human-readable label that accompanies every export/UI surface. */
  basisLabel: string;
  currency: "LKR";
  rows: ReceiptDateRow[];
  totals: Omit<ReceiptDateRow, "date">;
}

export interface AllocationByInstalmentRow {
  enrolmentId: string;
  instalmentId: string;
  studentRef: string;
  studentName: string;
  programmeCode: string;
  intakeCode: string;
  sequence: number;
  periodLabel: string;
  component: string;
  dueDate: BizDate;
  activeAllocatedMinor: number;
  reversedAllocatedMinor: number;
  activeAllocationCount: number;
}

export interface EnrolmentCreditRow {
  enrolmentId: string;
  studentId: string;
  studentRef: string;
  studentName: string;
  programmeCode: string;
  intakeCode: string;
  collectedMinor: number;
  allocatedMinor: number;
  creditMinor: number;
}

export interface AgeingRow {
  enrolmentId: string;
  studentId: string;
  studentRef: string;
  studentName: string;
  programmeCode: string;
  intakeCode: string;
  outstandingMinor: number;
  dueNowMinor: number;
  overdueMinor: number;
  buckets: Record<AgeingBucket, number>;
}

export interface AgeingReport {
  asOf: BizDate;
  rows: AgeingRow[];
  totals: { outstandingMinor: number; dueNowMinor: number; overdueMinor: number; buckets: Record<AgeingBucket, number> };
}

export interface ExemptionByTypeRow {
  type: string;
  activeApplications: number;
  activeMinor: number;
  reversedApplications: number;
  reversedMinor: number;
}

export interface ExemptionAwardRow {
  awardId: string;
  enrolmentId: string;
  studentRef: string;
  studentName: string;
  programmeCode: string;
  intakeCode: string;
  type: string;
  basis: string;
  value: number;
  capMinor: number | null;
  sponsorName: string | null;
  status: string;
  effectiveFrom: BizDate;
  effectiveTo: BizDate | null;
}

export interface ExemptionsReport {
  byType: ExemptionByTypeRow[];
  awards: ExemptionAwardRow[];
  totals: { activeMinor: number; reversedMinor: number };
}

export interface ProgrammeIntakeTotalRow {
  groupId: string;
  groupCode: string;
  groupLabel: string;
  programmeCode: string;
  intakeCode: string | null;
  studentCount: number;
  enrolmentCount: number;
  collectedMinor: number;
  outstandingMinor: number;
  dueNowMinor: number;
  overdueMinor: number;
  creditMinor: number;
}

export interface ReviewThroughputRow {
  date: BizDate;
  kind: string;
  count: number;
}

export interface ReviewThroughputReport {
  rows: ReviewThroughputRow[];
  totals: Record<string, number>;
}

export interface FollowUpOutcomeRow {
  outcome: string;
  count: number;
}

export interface FollowUpOutcomesReport {
  rows: FollowUpOutcomeRow[];
  total: number;
  /** Open promise state counts, recorded alongside call outcomes. */
  promises: { state: string; count: number }[];
}

export interface CollectionRateReport {
  asOf: BizDate;
  numeratorMinor: number;
  denominatorMinor: number;
  /** null means the denominator is zero; display "N/A" rather than dividing by zero. */
  rate: number | null;
  display: string;
  /** All-plan settlement view (not limited to obligations due through asOf). */
  settlement: { netObligationMinor: number; approvedAllocatedMinor: number; outstandingMinor: number; collectedMinor: number; creditMinor: number };
}

/* ---------------------------------------------------------------- helpers */

function resolveAsOf(opts: BalanceOptions): BizDate {
  const d = opts.asOf ?? businessDate();
  if (!isBizDate(d)) throw fail.validation("asOf must be a YYYY-MM-DD business date.");
  return d;
}

function resolveFilters(f: ReportFilters): ReportFilters {
  if (!isBizDate(f.from) || !isBizDate(f.to)) throw fail.validation("Report dates must be YYYY-MM-DD business dates.");
  if (f.from > f.to) throw fail.validation("Report start date must be on or before the end date.");
  return f;
}

function scopeAndFilters(p: StaffPrincipal, f: Partial<ReportFilters>): SQL {
  const parts: SQL[] = [intakeScopeWhere(p, intakes.id, intakes.programmeId)];
  if (f.programmeId) parts.push(eq(intakes.programmeId, f.programmeId));
  if (f.intakeId) parts.push(eq(intakes.id, f.intakeId));
  return and(...parts) as SQL;
}

const fromInstant = (d: BizDate) => colomboInstant(d, 0, 0);
const toExclusiveInstant = (d: BizDate) => colomboInstant(addDays(d, 1), 0, 0);

const ZERO_BUCKETS = (): Record<AgeingBucket, number> => ({ "1-30": 0, "31-60": 0, "61-90": 0, "91+": 0 });

/* -------------------------------------------------------------- receipts */

interface RawReceiptDay {
  day: string;
  kind: string;
  n: string;
  total: string;
  claimed: string;
}

function foldReceiptDays(rows: RawReceiptDay[]): ReceiptDateRow[] {
  const byDay = new Map<BizDate, ReceiptDateRow>();
  for (const r of rows) {
    const day = r.day;
    const row = byDay.get(day) ?? {
      date: day, receiptCount: 0, receiptMinor: 0, historicalCount: 0, historicalMinor: 0,
      reversalCount: 0, correctionsMinor: 0, claimedMinor: 0, netMinor: 0,
    };
    const count = Number(r.n);
    const total = Number(r.total);
    if (r.kind === "REVERSAL") {
      row.reversalCount += count;
      row.correctionsMinor += total;
    } else if (r.kind === "HISTORICAL_IMPORT") {
      row.historicalCount += count;
      row.historicalMinor += total;
      row.claimedMinor += Number(r.claimed);
    } else {
      row.receiptCount += count;
      row.receiptMinor += total;
      row.claimedMinor += Number(r.claimed);
    }
    row.netMinor = row.receiptMinor + row.historicalMinor - row.correctionsMinor;
    byDay.set(day, row);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function receiptRowsByApproval(tx: DbOrTx, p: StaffPrincipal, f: ReportFilters): Promise<RawReceiptDay[]> {
  const approvalInstant = sql`coalesce(${reviewActions.createdAt}, ${paymentEvents.createdAt})`;
  const day = sql<string>`to_char((${approvalInstant}) at time zone 'Asia/Colombo', 'YYYY-MM-DD')`;
  return tx
    .select({
      day,
      kind: sql<string>`${paymentEvents.kind}::text`,
      n: sql<string>`count(*)`,
      total: sql<string>`coalesce(sum(${paymentEvents.amountMinor}), 0)`,
      claimed: sql<string>`coalesce(sum(${paymentEvents.claimedMinor}) filter (where ${paymentEvents.kind} in ('RECEIPT', 'HISTORICAL_IMPORT')), 0)`,
    })
    .from(paymentEvents)
    .leftJoin(reviewActions, eq(reviewActions.id, paymentEvents.reviewActionId))
    .innerJoin(enrolments, eq(enrolments.id, paymentEvents.enrolmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      sql`${approvalInstant} >= ${fromInstant(f.from).toISOString()}::timestamptz`,
      sql`${approvalInstant} < ${toExclusiveInstant(f.to).toISOString()}::timestamptz`,
      scopeAndFilters(p, f),
    ))
    .groupBy(day, paymentEvents.kind);
}

/**
 * Approved receipts grouped by the business date the approval was recorded
 * (review action time, falling back to the payment event time). Reversals are shown
 * as corrections on their own reversal date; gross approvals stay visible.
 */
export async function receiptsByApprovalDate(tx: DbOrTx, p: StaffPrincipal, filters: ReportFilters): Promise<ReceiptsReport> {
  const f = resolveFilters(filters);
  const rows = foldReceiptDays(await receiptRowsByApproval(tx, p, f));
  return {
    basis: "APPROVAL_DATE",
    basisLabel: "Approval/reversal date (Asia/Colombo)",
    currency: "LKR",
    rows,
    totals: totalsOf(rows),
  };
}

async function receiptRowsByTransfer(tx: DbOrTx, p: StaffPrincipal, f: ReportFilters): Promise<RawReceiptDay[]> {
  return tx
    .select({
      day: sql<string>`${paymentEvents.effectiveDate}::text`,
      kind: sql<string>`${paymentEvents.kind}::text`,
      n: sql<string>`count(*)`,
      total: sql<string>`coalesce(sum(${paymentEvents.amountMinor}), 0)`,
      claimed: sql<string>`coalesce(sum(${paymentEvents.claimedMinor}) filter (where ${paymentEvents.kind} in ('RECEIPT', 'HISTORICAL_IMPORT')), 0)`,
    })
    .from(paymentEvents)
    .innerJoin(enrolments, eq(enrolments.id, paymentEvents.enrolmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      gte(paymentEvents.effectiveDate, f.from),
      lte(paymentEvents.effectiveDate, f.to),
      scopeAndFilters(p, f),
    ))
    .groupBy(paymentEvents.effectiveDate, paymentEvents.kind);
}

/**
 * The transfer-date view uses the bank transfer/effective date recorded on each event.
 * It is deliberately labelled: it must never be presented as an approval-date total.
 */
export async function receiptsByTransferDate(tx: DbOrTx, p: StaffPrincipal, filters: ReportFilters): Promise<ReceiptsReport> {
  const f = resolveFilters(filters);
  const rows = foldReceiptDays(await receiptRowsByTransfer(tx, p, f));
  return {
    basis: "TRANSFER_DATE",
    basisLabel: "Bank transfer/effective date (Asia/Colombo) — not an approval-date total",
    currency: "LKR",
    rows,
    totals: totalsOf(rows),
  };
}

function totalsOf(rows: ReceiptDateRow[]): Omit<ReceiptDateRow, "date"> {
  const t = { receiptCount: 0, receiptMinor: 0, historicalCount: 0, historicalMinor: 0, reversalCount: 0, correctionsMinor: 0, claimedMinor: 0, netMinor: 0 };
  for (const r of rows) {
    t.receiptCount += r.receiptCount; t.receiptMinor += r.receiptMinor;
    t.historicalCount += r.historicalCount; t.historicalMinor += r.historicalMinor;
    t.reversalCount += r.reversalCount; t.correctionsMinor += r.correctionsMinor;
    t.claimedMinor += r.claimedMinor; t.netMinor += r.netMinor;
  }
  return t;
}

/* ----------------------------------------------------------- allocations */

/** Active and reversed payment allocations, grouped by enrolment instalment. */
export async function allocationsByInstalment(tx: DbOrTx, p: StaffPrincipal, filters: ReportFilters): Promise<AllocationByInstalmentRow[]> {
  const f = resolveFilters(filters);
  const rows = await tx
    .select({
      enrolmentId: paymentAllocations.enrolmentId,
      instalmentId: paymentAllocations.instalmentId,
      studentRef: students.ref,
      studentName: students.fullName,
      programmeCode: programmes.code,
      intakeCode: intakes.code,
      sequence: instalments.sequence,
      periodLabel: instalments.periodLabel,
      component: instalments.component,
      dueDate: instalments.dueDate,
      activeAllocated: sql<string>`coalesce(sum(${paymentAllocations.amountMinor}) filter (where ${paymentAllocations.reversedAt} is null), 0)`,
      reversedAllocated: sql<string>`coalesce(sum(${paymentAllocations.amountMinor}) filter (where ${paymentAllocations.reversedAt} is not null), 0)`,
      activeCount: sql<string>`count(*) filter (where ${paymentAllocations.reversedAt} is null)`,
    })
    .from(paymentAllocations)
    .innerJoin(enrolments, eq(enrolments.id, paymentAllocations.enrolmentId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(instalments, eq(instalments.id, paymentAllocations.instalmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      gte(paymentAllocations.createdAt, fromInstant(f.from)),
      sql`${paymentAllocations.createdAt} < ${toExclusiveInstant(f.to).toISOString()}::timestamptz`,
      scopeAndFilters(p, f),
    ))
    .groupBy(
      paymentAllocations.enrolmentId, paymentAllocations.instalmentId, students.ref, students.fullName,
      programmes.code, intakes.code, instalments.sequence, instalments.periodLabel, instalments.component, instalments.dueDate,
    )
    .orderBy(asc(intakes.code), asc(instalments.sequence));
  return rows.map((r) => ({
    enrolmentId: r.enrolmentId, instalmentId: r.instalmentId, studentRef: r.studentRef, studentName: r.studentName,
    programmeCode: r.programmeCode, intakeCode: r.intakeCode, sequence: r.sequence, periodLabel: r.periodLabel,
    component: r.component, dueDate: r.dueDate,
    activeAllocatedMinor: Number(r.activeAllocated), reversedAllocatedMinor: Number(r.reversedAllocated),
    activeAllocationCount: Number(r.activeCount),
  }));
}

/* --------------------------------------------------------------- credits */

function filterProjection<T extends { programmeId: string; intakeId: string }>(rows: T[], opts: BalanceOptions): T[] {
  return rows.filter((r) => (!opts.programmeId || r.programmeId === opts.programmeId) && (!opts.intakeId || r.intakeId === opts.intakeId));
}

/** Enrolment credit = unreversed verified receipts minus active allocations. */
export async function enrolmentCredits(tx: DbOrTx, p: StaffPrincipal, opts: BalanceOptions = {}): Promise<EnrolmentCreditRow[]> {
  const asOf = resolveAsOf(opts);
  const projection = filterProjection(await loadEnrolmentProjection(tx, p, { asOf }), opts);
  return projection
    .filter((r) => r.summary.creditMinor > 0)
    .map((r) => ({
      enrolmentId: r.enrolmentId, studentId: r.studentId, studentRef: r.studentRef, studentName: r.studentName,
      programmeCode: r.programmeCode, intakeCode: r.intakeCode,
      collectedMinor: r.summary.collectedMinor, allocatedMinor: r.summary.approvedAllocatedMinor, creditMinor: r.summary.creditMinor,
    }))
    .sort((a, b) => b.creditMinor - a.creditMinor);
}

/* --------------------------------------------------------------- ageing */

/** Outstanding and overdue balances with 1–30 / 31–60 / 61–90 / 91+ day ageing buckets. */
export async function outstandingAgeing(tx: DbOrTx, p: StaffPrincipal, opts: BalanceOptions = {}): Promise<AgeingReport> {
  const asOf = resolveAsOf(opts);
  const projection = filterProjection(await loadEnrolmentProjection(tx, p, { asOf, instalments: true }), opts);
  const rows: AgeingRow[] = [];
  const totals = { outstandingMinor: 0, dueNowMinor: 0, overdueMinor: 0, buckets: ZERO_BUCKETS() };

  for (const r of projection) {
    if (r.summary.outstandingMinor <= 0) continue;
    const buckets = ZERO_BUCKETS();
    for (const v of r.instalments) {
      if (v.remainingMinor <= 0) continue;
      const b = ageingBucket(v.dueDate, asOf);
      if (b) buckets[b] += v.remainingMinor;
    }
    rows.push({
      enrolmentId: r.enrolmentId, studentId: r.studentId, studentRef: r.studentRef, studentName: r.studentName,
      programmeCode: r.programmeCode, intakeCode: r.intakeCode,
      outstandingMinor: r.summary.outstandingMinor, dueNowMinor: r.summary.dueNowMinor, overdueMinor: r.summary.overdueMinor,
      buckets,
    });
    totals.outstandingMinor += r.summary.outstandingMinor;
    totals.dueNowMinor += r.summary.dueNowMinor;
    totals.overdueMinor += r.summary.overdueMinor;
    for (const b of Object.keys(buckets) as AgeingBucket[]) totals.buckets[b] += buckets[b];
  }
  rows.sort((a, b) => b.overdueMinor - a.overdueMinor || b.outstandingMinor - a.outstandingMinor);
  return { asOf, rows, totals };
}

/* ------------------------------------------------------------ exemptions */

/** Exemption awards plus active/reversed application totals, by exemption type. */
export async function exemptionsReport(tx: DbOrTx, p: StaffPrincipal, filters: ReportFilters): Promise<ExemptionsReport> {
  const f = resolveFilters(filters);

  const typeRows = await tx
    .select({
      type: sql<string>`${exemptionAwards.type}::text`,
      activeApplications: sql<string>`count(*) filter (where ${exemptionApplications.reversedAt} is null)`,
      activeMinor: sql<string>`coalesce(sum(${exemptionApplications.amountMinor}) filter (where ${exemptionApplications.reversedAt} is null), 0)`,
      reversedApplications: sql<string>`count(*) filter (where ${exemptionApplications.reversedAt} is not null)`,
      reversedMinor: sql<string>`coalesce(sum(${exemptionApplications.amountMinor}) filter (where ${exemptionApplications.reversedAt} is not null), 0)`,
    })
    .from(exemptionApplications)
    .innerJoin(exemptionAwards, eq(exemptionAwards.id, exemptionApplications.awardId))
    .innerJoin(enrolments, eq(enrolments.id, exemptionApplications.enrolmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      gte(exemptionApplications.createdAt, fromInstant(f.from)),
      sql`${exemptionApplications.createdAt} < ${toExclusiveInstant(f.to).toISOString()}::timestamptz`,
      scopeAndFilters(p, f),
    ))
    .groupBy(exemptionAwards.type);

  const byType: ExemptionByTypeRow[] = typeRows.map((r) => ({
    type: r.type,
    activeApplications: Number(r.activeApplications),
    activeMinor: Number(r.activeMinor),
    reversedApplications: Number(r.reversedApplications),
    reversedMinor: Number(r.reversedMinor),
  }));

  const awardRows = await tx
    .select({
      awardId: exemptionAwards.id,
      enrolmentId: exemptionAwards.enrolmentId,
      studentRef: students.ref,
      studentName: students.fullName,
      programmeCode: programmes.code,
      intakeCode: intakes.code,
      type: sql<string>`${exemptionAwards.type}::text`,
      basis: sql<string>`${exemptionAwards.basis}::text`,
      value: exemptionAwards.value,
      capMinor: exemptionAwards.capMinor,
      sponsorName: exemptionAwards.sponsorName,
      status: sql<string>`${exemptionAwards.status}::text`,
      effectiveFrom: exemptionAwards.effectiveFrom,
      effectiveTo: exemptionAwards.effectiveTo,
    })
    .from(exemptionAwards)
    .innerJoin(enrolments, eq(enrolments.id, exemptionAwards.enrolmentId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      lte(exemptionAwards.effectiveFrom, f.to),
      sql`(${exemptionAwards.effectiveTo} is null or ${exemptionAwards.effectiveTo} >= ${f.from})`,
      scopeAndFilters(p, f),
    ))
    .orderBy(asc(students.fullName), asc(exemptionAwards.effectiveFrom));

  return {
    byType,
    awards: awardRows,
    totals: {
      activeMinor: byType.reduce((a, r) => a + r.activeMinor, 0),
      reversedMinor: byType.reduce((a, r) => a + r.reversedMinor, 0),
    },
  };
}

/* ------------------------------------------------------ programme totals */

/** Enrolment, collection and outstanding totals grouped by programme or intake. */
export async function programmeIntakeTotals(
  tx: DbOrTx,
  p: StaffPrincipal,
  opts: BalanceOptions & { groupBy?: "PROGRAMME" | "INTAKE" } = {},
): Promise<ProgrammeIntakeTotalRow[]> {
  const asOf = resolveAsOf(opts);
  const groupBy = opts.groupBy ?? "PROGRAMME";
  const projection = filterProjection(await loadEnrolmentProjection(tx, p, { asOf }), opts);
  const groups = new Map<string, ProgrammeIntakeTotalRow & { students: Set<string> }>();

  for (const r of projection) {
    const groupId = groupBy === "PROGRAMME" ? r.programmeId : r.intakeId;
    let g = groups.get(groupId);
    if (!g) {
      g = {
        groupId,
        groupCode: groupBy === "PROGRAMME" ? r.programmeCode : r.intakeCode,
        groupLabel: groupBy === "PROGRAMME" ? r.programmeName : r.intakeLabel,
        programmeCode: r.programmeCode,
        intakeCode: groupBy === "INTAKE" ? r.intakeCode : null,
        studentCount: 0, enrolmentCount: 0, collectedMinor: 0, outstandingMinor: 0,
        dueNowMinor: 0, overdueMinor: 0, creditMinor: 0,
        students: new Set<string>(),
      };
      groups.set(groupId, g);
    }
    g.students.add(r.studentId);
    g.studentCount = g.students.size;
    g.enrolmentCount += 1;
    g.collectedMinor += r.summary.collectedMinor;
    g.outstandingMinor += r.summary.outstandingMinor;
    g.dueNowMinor += r.summary.dueNowMinor;
    g.overdueMinor += r.summary.overdueMinor;
    g.creditMinor += r.summary.creditMinor;
  }

  return [...groups.values()]
    .map((g) => {
      const row = { ...g };
      delete (row as { students?: unknown }).students;
      return row;
    })
    .sort((a, b) => b.outstandingMinor - a.outstandingMinor || a.groupCode.localeCompare(b.groupCode));
}

/* ------------------------------------------------------ review throughput */

/** Review decisions by business day and action kind, scoped to the principal. */
export async function reviewThroughput(tx: DbOrTx, p: StaffPrincipal, filters: ReportFilters): Promise<ReviewThroughputReport> {
  const f = resolveFilters(filters);
  const day = sql<string>`to_char(${reviewActions.createdAt} at time zone 'Asia/Colombo', 'YYYY-MM-DD')`;
  const rows = await tx
    .select({ date: day, kind: sql<string>`${reviewActions.kind}::text`, n: sql<string>`count(*)` })
    .from(reviewActions)
    .innerJoin(paymentSubmissions, eq(paymentSubmissions.id, reviewActions.submissionId))
    .innerJoin(enrolments, eq(enrolments.id, paymentSubmissions.enrolmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      gte(reviewActions.createdAt, fromInstant(f.from)),
      sql`${reviewActions.createdAt} < ${toExclusiveInstant(f.to).toISOString()}::timestamptz`,
      scopeAndFilters(p, f),
    ))
    .groupBy(day, reviewActions.kind)
    .orderBy(asc(day));

  const totals: Record<string, number> = {};
  const out = rows.map((r) => {
    const count = Number(r.n);
    totals[r.kind] = (totals[r.kind] ?? 0) + count;
    return { date: r.date, kind: r.kind, count };
  });
  return { rows: out, totals };
}

/* ------------------------------------------------------ follow-up outcome */

/** Recorded call outcomes in range, plus current promise state counts. */
export async function followUpOutcomes(tx: DbOrTx, p: StaffPrincipal, filters: ReportFilters): Promise<FollowUpOutcomesReport> {
  const f = resolveFilters(filters);
  const rows = await tx
    .select({ outcome: sql<string>`${callAttempts.outcome}::text`, n: sql<string>`count(*)` })
    .from(callAttempts)
    .innerJoin(enrolments, eq(enrolments.id, callAttempts.enrolmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      gte(callAttempts.createdAt, fromInstant(f.from)),
      sql`${callAttempts.createdAt} < ${toExclusiveInstant(f.to).toISOString()}::timestamptz`,
      scopeAndFilters(p, f),
    ))
    .groupBy(callAttempts.outcome)
    .orderBy(asc(callAttempts.outcome));

  const promiseRows = await tx
    .select({ state: sql<string>`${paymentPromises.state}::text`, n: sql<string>`count(*)` })
    .from(paymentPromises)
    .innerJoin(enrolments, eq(enrolments.id, paymentPromises.enrolmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(scopeAndFilters(p, f))
    .groupBy(paymentPromises.state);

  const out = rows.map((r) => ({ outcome: r.outcome, count: Number(r.n) }));
  return {
    rows: out,
    total: out.reduce((a, r) => a + r.count, 0),
    promises: promiseRows.map((r) => ({ state: r.state, count: Number(r.n) })),
  };
}

/* -------------------------------------------------------- collection rate */

/**
 * Collection rate for obligations due through an as-of date: approved allocations against
 * those net obligations divided by those net obligations. Future obligations and advance
 * payments are excluded from the ratio; a zero denominator yields `rate: null` / "N/A".
 */
export async function collectionRateReport(tx: DbOrTx, p: StaffPrincipal, opts: BalanceOptions = {}): Promise<CollectionRateReport> {
  const asOf = resolveAsOf(opts);
  const projection = filterProjection(await loadEnrolmentProjection(tx, p, { asOf, instalments: true }), opts);
  const views: InstalmentView[] = projection.flatMap((r) => r.instalments);
  const r = collectionRate(views, asOf);

  let netObligation = 0, allocated = 0, outstanding = 0, collected = 0, credit = 0;
  for (const row of projection) {
    netObligation += row.summary.netObligationMinor;
    allocated += row.summary.approvedAllocatedMinor;
    outstanding += row.summary.outstandingMinor;
    collected += row.summary.collectedMinor;
    credit += row.summary.creditMinor;
  }

  return {
    asOf,
    numeratorMinor: r.numerator,
    denominatorMinor: r.denominator,
    rate: r.rate,
    display: r.rate === null ? "N/A" : `${(r.rate * 100).toFixed(2)}%`,
    settlement: {
      netObligationMinor: netObligation,
      approvedAllocatedMinor: allocated,
      outstandingMinor: outstanding,
      collectedMinor: collected,
      creditMinor: credit,
    },
  };
}

/** All-plan settlement totals (includes future obligations), offered separately from the due-through rate. */
export async function allPlanSettlement(tx: DbOrTx, p: StaffPrincipal, opts: BalanceOptions = {}) {
  return (await collectionRateReport(tx, p, opts)).settlement;
}

/* ---------------------------------------------------------- shared guard */

/**
 * Ensure every enrolment id in a drill-down belongs to the principal's scope.
 * Exported for route handlers that accept raw enrolment ids in report filters.
 */
export async function assertReportScope(tx: DbOrTx, p: StaffPrincipal, enrolmentId: string): Promise<void> {
  const [row] = await tx
    .select({ id: enrolments.id })
    .from(enrolments)
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(eq(enrolments.id, enrolmentId), intakeScopeWhere(p, intakes.id, intakes.programmeId), isNull(intakes.trashedAt) as SQL));
  if (!row) throw fail.notFound();
}
