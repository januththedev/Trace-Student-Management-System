import "server-only";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { enrolments, intakes, programmes } from "@/db/schema";
import { computeInstalment, LedgerInvariantError, type EnrolmentSummary, type InstalmentView } from "@/domain/finance";
import { assertMinor } from "@/lib/money";
import type { BizDate } from "@/lib/time";
import { intakeScopeWhere, type StaffPrincipal } from "@/server/auth/policy";

/** SQL equivalent of loadLedgers/computeInstalment/summarize. Each child table is
 * aggregated separately before joining, preventing adjustment/allocation fan-out.
 * asOf controls due dates, exactly as the live ledger does; it is not a historical snapshot.
 */
export function balanceCtes(p: StaffPrincipal, asOf: BizDate, opts: { statuses?: readonly string[]; includeTrashed?: boolean } = {}) {
  const statuses = opts.statuses ?? ["ACTIVE"];
  return sql`with visible as materialized (
    select enrolments.id, enrolments.student_id from enrolments
    join intakes on intakes.id = enrolments.intake_id
    join programmes on programmes.id = intakes.programme_id
    where ${intakeScopeWhere(p, intakes.id, intakes.programmeId)}
      and ${statuses.length ? sql`${enrolments.status} in (${sql.join(statuses.map(s => sql`${s}::enrolment_status`), sql`, `)})` : sql`false`}
      ${opts.includeTrashed ? sql`` : sql`and ${intakes.trashedAt} is null and ${programmes.trashedAt} is null`}
  ), charges as (
    select i.id, i.enrolment_id, i.due_date, i.original_charge_minor, i.sequence, i.period_label, i.component
    from instalments i join visible v on v.id = i.enrolment_id
  ), adjustments as (
    select a.instalment_id, sum(a.amount_minor) amount,
      bool_or(a.kind = 'WITHDRAWAL_CANCEL' and a.reverses_id is null) cancels from charge_adjustments a
    join visible v on v.id = a.enrolment_id group by a.instalment_id
  ), exemptions as (
    select a.instalment_id, sum(a.amount_minor) amount from exemption_applications a
    join visible v on v.id = a.enrolment_id where a.reversed_at is null group by a.instalment_id
  ), allocations as (
    select a.instalment_id, sum(a.amount_minor) amount from payment_allocations a
    join visible v on v.id = a.enrolment_id where a.reversed_at is null group by a.instalment_id
  ), obligations as (
    select i.id, i.enrolment_id, i.due_date, i.sequence, i.period_label, i.component, i.original_charge_minor,
      coalesce(a.amount::bigint, 0) adjustments, coalesce(x.amount::bigint, 0) exemptions, coalesce(a.cancels, false) cancels,
      i.original_charge_minor + coalesce(a.amount::bigint, 0) - coalesce(x.amount::bigint, 0) net,
      coalesce(l.amount::bigint, 0) allocated
    from charges i left join adjustments a on a.instalment_id = i.id
    left join exemptions x on x.instalment_id = i.id
    left join allocations l on l.instalment_id = i.id
  ), due as (
    select enrolment_id, sum(net) net, sum(allocated) allocated, sum(net - allocated) outstanding,
      coalesce(sum(net - allocated) filter (where due_date <= ${asOf}::date), 0) due_now,
      coalesce(sum(net - allocated) filter (where due_date < ${asOf}::date), 0) overdue,
      bool_or(net < 0 or allocated < 0 or net - allocated < 0) invalid
    from obligations group by enrolment_id
  ), receipts as (
    select e.enrolment_id, sum(case when e.kind = 'REVERSAL' then -e.amount_minor else e.amount_minor end) amount
    from payment_events e join visible v on v.id = e.enrolment_id group by e.enrolment_id
  ), pending as (
    select s.enrolment_id, sum(s.claimed_minor) amount from payment_submissions s
    join visible v on v.id = s.enrolment_id where s.status = 'PENDING_REVIEW' group by s.enrolment_id
  ), balances as (
    select v.id, v.student_id, coalesce(d.net, 0) net, coalesce(d.allocated, 0) allocated,
      coalesce(d.outstanding, 0) outstanding, coalesce(d.due_now, 0) due_now, coalesce(d.overdue, 0) overdue,
      coalesce(r.amount, 0) collected, coalesce(r.amount, 0) - coalesce(d.allocated, 0) credit,
      coalesce(s.amount, 0) pending, coalesce(d.invalid, false) invalid
    from visible v left join due d on d.enrolment_id = v.id
    left join receipts r on r.enrolment_id = v.id left join pending s on s.enrolment_id = v.id
  )`;
}

type RawBalance = { id: string; student_id: string; net: string; allocated: string; outstanding: string;
  due_now: string; overdue: string; collected: string; credit: string; pending: string; invalid: boolean };

export function balanceSummary(r: Omit<RawBalance, "id" | "student_id">): EnrolmentSummary {
  if (r.invalid || Number(r.credit) < 0) throw new LedgerInvariantError("Invalid report ledger balances");
  const n = (v: string) => assertMinor(Number(v));
  return { netObligationMinor: n(r.net), approvedAllocatedMinor: n(r.allocated), outstandingMinor: n(r.outstanding),
    dueNowMinor: n(r.due_now), overdueMinor: n(r.overdue), collectedMinor: n(r.collected), creditMinor: n(r.credit),
    pendingClaimedMinor: n(r.pending), settled: Number(r.outstanding) === 0 };
}

export async function loadBalanceSummaries(tx: DbOrTx, p: StaffPrincipal, asOf: BizDate, opts: { statuses?: readonly string[]; includeTrashed?: boolean } = {}) {
  const rows = await tx.execute<RawBalance>(sql`${balanceCtes(p, asOf, opts)} select * from balances`);
  return new Map(rows.map(r => [r.id, balanceSummary(r)]));
}

/** Detailed report rows use the same SQL facts and the canonical state derivation,
 * without expanding thousands of enrolment IDs into repeated IN parameter lists. */
export async function loadBalanceInstalments(tx: DbOrTx, p: StaffPrincipal, asOf: BizDate, opts: { statuses?: readonly string[]; includeTrashed?: boolean } = {}) {
  const rows = await tx.execute<{ id: string; enrolment_id: string; due_date: string; sequence: number; period_label: string; component: string;
    original_charge_minor: string; adjustments: string; exemptions: string; allocated: string; cancels: boolean; pending: string }>(sql`${balanceCtes(p, asOf, opts)}
    select o.*, o.due_date::text due_date, coalesce(s.amount, 0) pending from obligations o
    left join (select s.target_instalment_id, sum(s.claimed_minor) amount from payment_submissions s
      join visible v on v.id = s.enrolment_id where s.status = 'PENDING_REVIEW' group by s.target_instalment_id) s
      on s.target_instalment_id = o.id order by o.enrolment_id, o.sequence`);
  const grouped = new Map<string, InstalmentView[]>();
  for (const r of rows) {
    const view = computeInstalment({ id: r.id, sequence: r.sequence, periodLabel: r.period_label, component: r.component, dueDate: r.due_date,
      originalChargeMinor: Number(r.original_charge_minor), adjustmentsMinor: Number(r.adjustments), exemptionsMinor: Number(r.exemptions),
      allocatedMinor: Number(r.allocated), cancelledByAdjustment: r.cancels, pendingClaimedMinor: Number(r.pending) }, asOf);
    const list = grouped.get(r.enrolment_id) ?? [];
    list.push(view);
    grouped.set(r.enrolment_id, list);
  }
  return grouped;
}

export function balanceMetricsQuery(p: StaffPrincipal, asOf: BizDate) {
  return sql`${balanceCtes(p, asOf)}
    select count(distinct student_id) students, count(*) enrolments,
      count(distinct student_id) filter (where due_now > 0) dues,
      coalesce(sum(net), 0) net, coalesce(sum(allocated), 0) allocated,
      coalesce(sum(outstanding), 0) outstanding, coalesce(sum(due_now), 0) due_now, coalesce(sum(overdue), 0) overdue,
      coalesce(sum(collected), 0) collected, coalesce(sum(credit), 0) credit, coalesce(sum(pending), 0) pending,
      coalesce(bool_or(invalid or credit < 0), false) invalid from balances`;
}

export async function balanceMetrics(tx: DbOrTx, p: StaffPrincipal, asOf: BizDate) {
  const [r] = await tx.execute<RawBalance & { students: string; enrolments: string; dues: string }>(balanceMetricsQuery(p, asOf));
  return { activeStudents: Number(r.students), activeEnrolments: Number(r.enrolments), studentsWithDues: Number(r.dues), summary: balanceSummary(r) };
}
