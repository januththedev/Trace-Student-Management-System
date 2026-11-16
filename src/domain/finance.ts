/**
 * Central payment calculations (spec §7). Pure functions; dashboards, exports, queues and
 * detail screens all derive from these so they cannot disagree.
 *
 *   net_obligation       = original_charge + Σ signed adjustments − Σ active exemptions
 *   approved_allocations = Σ active allocations backed by unreversed approved payments
 *   remaining            = net_obligation − approved_allocations
 *   enrolment credit     = Σ unreversed verified receipts − Σ active allocations
 */
import { assertMinor, type Minor } from "@/lib/money";
import type { BizDate } from "@/lib/time";

export type InstalmentState = "UPCOMING" | "DUE_TODAY" | "OVERDUE" | "PARTIALLY_PAID" | "PAID" | "EXEMPT" | "CANCELLED";

export interface InstalmentFacts {
  id: string;
  sequence: number;
  periodLabel: string;
  component: string;
  dueDate: BizDate;
  originalChargeMinor: Minor;
  adjustmentsMinor: Minor;        // signed sum of charge adjustments
  cancelledByAdjustment: boolean; // any WITHDRAWAL_CANCEL adjustment present
  exemptionsMinor: Minor;         // active exemption applications
  allocatedMinor: Minor;          // active allocations
  pendingClaimedMinor: Minor;     // pending submissions targeting it
}

export interface InstalmentView extends InstalmentFacts {
  netObligationMinor: Minor;
  remainingMinor: Minor;
  state: InstalmentState;
  hasPendingEvidence: boolean;
}

/** Apply only a template's amount difference; retain individual adjustments and exemptions. */
export function feeChangeImpact(inst: InstalmentView, acceptedTemplateMinor: Minor, nextTemplateMinor: Minor) {
  assertMinor(acceptedTemplateMinor); assertMinor(nextTemplateMinor);
  if (acceptedTemplateMinor < 0 || nextTemplateMinor < 0) throw new RangeError("Template charges cannot be negative");
  const deltaMinor = assertMinor(nextTemplateMinor - acceptedTemplateMinor);
  const netAfterMinor = assertMinor(inst.netObligationMinor + deltaMinor);
  if (netAfterMinor < 0) throw new LedgerInvariantError("Fee reduction exceeds the obligation after exemptions");
  const releasedToCreditMinor = Math.max(0, inst.allocatedMinor - netAfterMinor);
  return { instalmentId: inst.id, sequence: inst.sequence, periodLabel: inst.periodLabel, component: inst.component, dueDate: inst.dueDate,
    acceptedTemplateMinor, nextTemplateMinor, deltaMinor, netBeforeMinor: inst.netObligationMinor, netAfterMinor, releasedToCreditMinor };
}

export class LedgerInvariantError extends Error {}

export function computeInstalment(f: InstalmentFacts, today: BizDate): InstalmentView {
  const net = assertMinor(f.originalChargeMinor + f.adjustmentsMinor - f.exemptionsMinor, "net obligation");
  const remaining = assertMinor(net - f.allocatedMinor, "remaining");
  if (net < 0) throw new LedgerInvariantError(`instalment ${f.id}: net obligation ${net} < 0`);
  if (f.allocatedMinor < 0) throw new LedgerInvariantError(`instalment ${f.id}: allocations < 0`);
  if (remaining < 0) throw new LedgerInvariantError(`instalment ${f.id}: remaining ${remaining} < 0`);
  return { ...f, netObligationMinor: net, remainingMinor: remaining, state: deriveState(f, net, remaining, today), hasPendingEvidence: f.pendingClaimedMinor > 0 };
}

function deriveState(f: InstalmentFacts, net: Minor, remaining: Minor, today: BizDate): InstalmentState {
  if (net === 0) {
    if (f.cancelledByAdjustment) return "CANCELLED";
    if (f.exemptionsMinor > 0 && f.allocatedMinor === 0) return "EXEMPT";
    return "PAID";
  }
  if (remaining === 0) return "PAID";
  if (today > f.dueDate) return "OVERDUE";       // strictly later than due date
  if (today === f.dueDate) return "DUE_TODAY";   // due today is not overdue
  if (f.allocatedMinor > 0) return "PARTIALLY_PAID";
  return "UPCOMING";
}

/** Partially paid instalments that are overdue still count as overdue for collection; expose both flags. */
export const isPartial = (v: InstalmentView) => v.allocatedMinor > 0 && v.remainingMinor > 0;
export const isDueNow = (v: InstalmentView, today: BizDate) => v.remainingMinor > 0 && v.dueDate <= today;
export const isOverdue = (v: InstalmentView, today: BizDate) => v.remainingMinor > 0 && v.dueDate < today;

export interface EnrolmentSummary {
  netObligationMinor: Minor;
  approvedAllocatedMinor: Minor;
  pendingClaimedMinor: Minor;
  creditMinor: Minor;
  outstandingMinor: Minor;   // all remaining incl. future
  dueNowMinor: Minor;        // remaining with due date <= today
  overdueMinor: Minor;       // remaining with due date < today
  collectedMinor: Minor;     // unreversed verified receipts (cash)
  settled: boolean;
}

export function summarize(views: readonly InstalmentView[], receiptsMinor: Minor, today: BizDate): EnrolmentSummary {
  let net = 0, alloc = 0, pending = 0, out = 0, due = 0, over = 0;
  for (const v of views) {
    net += v.netObligationMinor; alloc += v.allocatedMinor; pending += v.pendingClaimedMinor; out += v.remainingMinor;
    if (isDueNow(v, today)) due += v.remainingMinor;
    if (isOverdue(v, today)) over += v.remainingMinor;
  }
  const credit = receiptsMinor - alloc;
  if (credit < 0) throw new LedgerInvariantError(`credit ${credit} < 0: allocations exceed receipts`);
  return {
    netObligationMinor: net, approvedAllocatedMinor: alloc, pendingClaimedMinor: pending, creditMinor: credit,
    outstandingMinor: out, dueNowMinor: due, overdueMinor: over, collectedMinor: receiptsMinor, settled: out === 0,
  };
}

/**
 * Preselection (spec §6): active collectible instalments ordered by due date then sequence;
 * first with positive remaining. Pending evidence keeps it selected (with a warning).
 */
export function suggestInstalment(views: readonly InstalmentView[]): InstalmentView | null {
  const open = views.filter((v) => v.remainingMinor > 0).sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.sequence - b.sequence));
  return open[0] ?? null;
}

export interface AllocationLine { instalmentId: string; amountMinor: Minor }
export interface AllocationPlan { lines: AllocationLine[]; creditMinor: Minor }

/**
 * Default allocation (spec §7): selected instalment first, then the earliest remaining
 * eligible obligations (only when the reviewer confirms spill-over), excess → enrolment credit.
 */
export function planAllocation(amountMinor: Minor, views: readonly InstalmentView[], targetId: string, opts: { spillOver: boolean }): AllocationPlan {
  assertMinor(amountMinor);
  if (amountMinor <= 0) throw new RangeError("amount must be positive");
  let left = amountMinor;
  const lines: AllocationLine[] = [];
  const target = views.find((v) => v.id === targetId);
  if (!target) throw new RangeError("target instalment not in enrolment");
  const take = (v: InstalmentView) => {
    const already = lines.find((l) => l.instalmentId === v.id)?.amountMinor ?? 0;
    const room = v.remainingMinor - already;
    const n = Math.min(room, left);
    if (n > 0) { lines.push({ instalmentId: v.id, amountMinor: n }); left -= n; }
  };
  take(target);
  if (opts.spillOver && left > 0) {
    const rest = views.filter((v) => v.id !== targetId && v.remainingMinor > 0)
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.sequence - b.sequence));
    for (const v of rest) { if (left <= 0) break; take(v); }
  }
  return { lines, creditMinor: left };
}

/** Validate a reviewer-edited allocation: positive lines, within remaining, sum <= amount. */
export function validateAllocation(amountMinor: Minor, lines: readonly AllocationLine[], views: readonly InstalmentView[]): AllocationPlan {
  const byId = new Map(views.map((v) => [v.id, v]));
  let total = 0;
  const seen = new Set<string>();
  for (const l of lines) {
    assertMinor(l.amountMinor);
    const v = byId.get(l.instalmentId);
    if (!v) throw new RangeError("allocation targets an instalment outside this enrolment");
    if (seen.has(l.instalmentId)) throw new RangeError("duplicate allocation line");
    seen.add(l.instalmentId);
    if (l.amountMinor <= 0) throw new RangeError("allocation lines must be positive");
    if (l.amountMinor > v.remainingMinor) throw new RangeError(`allocation exceeds remaining for ${v.periodLabel}`);
    total += l.amountMinor;
  }
  if (total > amountMinor) throw new RangeError("allocations exceed the confirmed amount");
  return { lines: [...lines], creditMinor: amountMinor - total };
}

/** Exemption amount for one instalment (fixed or basis points), capped so it never exceeds the charge. */
export function exemptionAmountFor(basis: "FIXED" | "PERCENT", value: number, chargeBaseMinor: Minor, alreadyExemptMinor: Minor, capMinor?: Minor | null): Minor {
  const raw = basis === "PERCENT" ? Math.floor((chargeBaseMinor * value + 5000) / 10000) : value;
  const room = Math.max(0, chargeBaseMinor - alreadyExemptMinor);
  let amt = Math.min(raw, room);
  if (capMinor != null) amt = Math.min(amt, capMinor);
  return assertMinor(Math.max(0, amt));
}

/** Collection rate for obligations due through asOf; null denominator => "N/A". */
export function collectionRate(views: readonly InstalmentView[], asOf: BizDate): { numerator: Minor; denominator: Minor; rate: number | null } {
  let num = 0, den = 0;
  for (const v of views) {
    if (v.dueDate > asOf) continue;
    den += v.netObligationMinor;
    num += Math.min(v.allocatedMinor, v.netObligationMinor);
  }
  return { numerator: num, denominator: den, rate: den === 0 ? null : num / den };
}

export type AgeingBucket = "1-30" | "31-60" | "61-90" | "91+";
export function ageingBucket(dueDate: BizDate, today: BizDate): AgeingBucket | null {
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000);
  if (d <= 0) return null;
  if (d <= 30) return "1-30";
  if (d <= 60) return "31-60";
  if (d <= 90) return "61-90";
  return "91+";
}
