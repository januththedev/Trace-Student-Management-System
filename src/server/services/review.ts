import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx, type DbOrTx, type Tx } from "@/db/client";
import {
  enrolments, intakes, paymentAllocations, paymentEvents, paymentSubmissions, programmes, receiptAssets,
  reviewActions, staffAccounts, students, instalments,
} from "@/db/schema";
import { planAllocation, validateAllocation, type AllocationPlan } from "@/domain/finance";
import { businessDate, isBizDate, now } from "@/lib/time";
import { formatMinor } from "@/lib/money";
import { audit, notify } from "@/server/audit";
import { assertOperational, enrolmentInScope, intakeScopeWhere, isSuper, requireSuper, type StaffPrincipal } from "@/server/auth/policy";
import { fail } from "@/server/http";
import { once } from "@/server/idempotency";
import { freshPrincipal } from "@/server/auth/fresh";
import { loadLedger } from "./ledger";
import { afterLedgerChange } from "./hooks";

export const UNDO_WINDOW_MS = Number(process.env.REVIEW_UNDO_WINDOW_SECONDS ?? 60) * 1000;
const LEASE_MS = 2 * 60 * 1000;
const mutationKey = z.string().min(8).max(200);

const allocationLine = z.object({ instalmentId: z.string().uuid(), amountMinor: z.number().int().positive() });

export const approveInput = z.object({
  submissionId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  confirmedMinor: z.number().int().positive().optional(),
  amountChangeReason: z.string().trim().max(500).optional(),
  spillOver: z.boolean().default(false),
  allocations: z.array(allocationLine).max(60).optional(),
});
export type ApproveInput = z.infer<typeof approveInput>;

export const rejectInput = z.object({
  submissionId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1, "A rejection reason is required.").max(1000),
});

export const undoInput = z.object({ submissionId: z.string().uuid(), actionId: z.string().uuid() });
export const correctionInput = z.object({ submissionId: z.string().uuid(), reason: z.string().trim().min(5).max(1000), expectedVersion: z.number().int().positive() });

/** Lock the submission row and check scope + operational state, always in that order. */
async function lockSubmission(tx: Tx, p: StaffPrincipal, submissionId: string) {
  const [sub] = await tx.select().from(paymentSubmissions).where(eq(paymentSubmissions.id, submissionId)).for("update");
  if (!sub) throw fail.notFound();
  const ctx = await enrolmentInScope(tx, p, sub.enrolmentId);
  return { sub, ctx };
}

async function staleError(tx: DbOrTx, sub: typeof paymentSubmissions.$inferSelect) {
  let reviewer: string | null = null;
  if (sub.decidedBy) {
    const [s] = await tx.select({ name: staffAccounts.name }).from(staffAccounts).where(eq(staffAccounts.id, sub.decidedBy));
    reviewer = s?.name ?? null;
  }
  return fail.stale("This receipt changed since you opened it.", { currentStatus: sub.status, currentVersion: sub.version, decidedBy: reviewer, decidedAt: sub.decidedAt?.toISOString() ?? null });
}

/** Allocation preview (read-only) using the authoritative ledger. */
export async function previewApproval(tx: DbOrTx, p: StaffPrincipal, submissionId: string, opts: { confirmedMinor?: number; spillOver: boolean }) {
  const [sub] = await tx.select().from(paymentSubmissions).where(eq(paymentSubmissions.id, submissionId));
  if (!sub) throw fail.notFound();
  await enrolmentInScope(tx, p, sub.enrolmentId);
  const ledger = await loadLedger(tx, sub.enrolmentId);
  const amount = opts.confirmedMinor ?? sub.claimedMinor;
  const plan = planAllocation(amount, ledger.instalments, sub.targetInstalmentId, { spillOver: opts.spillOver });
  return { amountMinor: amount, plan, ledger };
}

export interface DecisionResult { submissionId: string; status: "APPROVED" | "REJECTED" | "PENDING_REVIEW"; version: number; actionId: string; paymentEventId?: string; plan?: AllocationPlan }

export async function approveSubmission(p0: StaffPrincipal, rawInput: z.input<typeof approveInput>, idemKey: string, requestId?: string): Promise<DecisionResult & { replayed: boolean }> {
  const input = approveInput.parse(rawInput);
  const res = await withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    const [s0] = await tx.select({ enrolmentId: paymentSubmissions.enrolmentId }).from(paymentSubmissions).where(eq(paymentSubmissions.id, input.submissionId));
    if (!s0) throw fail.notFound();
    await enrolmentInScope(tx, p, s0.enrolmentId); // authorize before any idempotent replay
    const { result, replayed } = await once(tx, `review:${p.id}`, idemKey, input, async (): Promise<DecisionResult> => {
      const { sub, ctx } = await lockSubmission(tx, p, input.submissionId);
      assertOperational(ctx);
      if (sub.status !== "PENDING_REVIEW" || sub.version !== input.expectedVersion) throw await staleError(tx, sub);
      if (sub.assetId) {
        const [asset] = await tx.select({ validation: receiptAssets.validation, scan: receiptAssets.scan }).from(receiptAssets).where(eq(receiptAssets.id, sub.assetId));
        if (!asset || asset.validation !== "CLEAN") throw fail.conflict("The receipt file has not passed validation yet.");
        if (asset.scan !== "CLEAN" && asset.scan !== "NOT_CONFIGURED") throw fail.conflict("The receipt file is not ready (malware scan).");
      } else if (!sub.isHistoricalImport) {
        throw fail.conflict("This submission has no evidence file.");
      }
      const confirmed = input.confirmedMinor ?? sub.claimedMinor;
      if (confirmed !== sub.claimedMinor && !input.amountChangeReason) throw fail.validation("A reason is required when the confirmed amount differs from the claimed amount.");

      const ledger = await loadLedger(tx, sub.enrolmentId, { lock: true });
      let plan: AllocationPlan;
      try {
        plan = input.allocations
          ? validateAllocation(confirmed, input.allocations, ledger.instalments)
          : planAllocation(confirmed, ledger.instalments, sub.targetInstalmentId, { spillOver: input.spillOver });
      } catch (e) {
        throw fail.validation(e instanceof Error ? e.message : "Invalid allocation.");
      }

      const [action] = await tx.insert(reviewActions).values({
        submissionId: sub.id, kind: "APPROVE", actorId: p.id, submissionVersion: sub.version, confirmedMinor: confirmed,
        reason: input.amountChangeReason ?? null,
      }).returning();
      const [event] = await tx.insert(paymentEvents).values({
        enrolmentId: sub.enrolmentId, submissionId: sub.id, kind: "RECEIPT", amountMinor: confirmed, claimedMinor: sub.claimedMinor,
        amountChangeReason: input.amountChangeReason ?? null, currency: sub.currency, reviewActionId: action.id,
        effectiveDate: businessDate(), actorId: p.id,
      }).returning();
      if (plan.lines.length) {
        await tx.insert(paymentAllocations).values(plan.lines.map((l) => ({
          enrolmentId: sub.enrolmentId, instalmentId: l.instalmentId, paymentEventId: event.id, amountMinor: l.amountMinor,
          currency: sub.currency, source: "SUBMISSION" as const, actorId: p.id,
        })));
      }
      const t = now();
      const [upd] = await tx.update(paymentSubmissions).set({ status: "APPROVED", version: sub.version + 1, decidedAt: t, decidedBy: p.id, leaseHolder: null, leaseExpiresAt: null })
        .where(and(eq(paymentSubmissions.id, sub.id), eq(paymentSubmissions.version, sub.version))).returning();
      if (!upd) throw await staleError(tx, sub);

      // Invariant re-check after the write (throws LedgerInvariantError => rollback).
      await loadLedger(tx, sub.enrolmentId);
      await audit(tx, {
        actorType: "STAFF", actorId: p.id, action: "receipt.approve", entityType: "payment_submission", entityId: sub.id,
        programmeId: ctx.programmeId, intakeId: ctx.intakeId, requestId,
        after: { confirmedMinor: confirmed, claimedMinor: sub.claimedMinor, allocations: plan.lines, creditMinor: plan.creditMinor },
        reason: input.amountChangeReason ?? null,
      });
      await notify(tx, {
        recipientType: "STUDENT", recipientId: sub.enrolmentId, event: "receipt.approved", dedupeKey: `receipt.approved:${action.id}`,
        title: "Payment receipt approved",
        body: `Your receipt for ${formatMinor(confirmed)} was approved.${plan.creditMinor > 0 ? ` ${formatMinor(plan.creditMinor)} is held as credit on this enrolment.` : ""}`,
      });
      await afterLedgerChange(tx, sub.enrolmentId);
      return { submissionId: sub.id, status: "APPROVED", version: upd.version, actionId: action.id, paymentEventId: event.id, plan };
    });
    return { ...result, replayed };
  });
  return res;
}

export async function rejectSubmission(p0: StaffPrincipal, rawInput: z.input<typeof rejectInput>, idemKey: string, requestId?: string) {
  const input = rejectInput.parse(rawInput);
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    const [s0] = await tx.select({ enrolmentId: paymentSubmissions.enrolmentId }).from(paymentSubmissions).where(eq(paymentSubmissions.id, input.submissionId));
    if (!s0) throw fail.notFound();
    await enrolmentInScope(tx, p, s0.enrolmentId); // authorize before any idempotent replay
    const { result, replayed } = await once(tx, `review:${p.id}`, idemKey, input, async (): Promise<DecisionResult> => {
      const { sub, ctx } = await lockSubmission(tx, p, input.submissionId);
      assertOperational(ctx);
      if (sub.status !== "PENDING_REVIEW" || sub.version !== input.expectedVersion) throw await staleError(tx, sub);
      const [action] = await tx.insert(reviewActions).values({ submissionId: sub.id, kind: "REJECT", actorId: p.id, submissionVersion: sub.version, reason: input.reason }).returning();
      const [upd] = await tx.update(paymentSubmissions).set({ status: "REJECTED", version: sub.version + 1, decidedAt: now(), decidedBy: p.id, leaseHolder: null, leaseExpiresAt: null })
        .where(and(eq(paymentSubmissions.id, sub.id), eq(paymentSubmissions.version, sub.version))).returning();
      if (!upd) throw await staleError(tx, sub);
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "receipt.reject", entityType: "payment_submission", entityId: sub.id, programmeId: ctx.programmeId, intakeId: ctx.intakeId, reason: input.reason, requestId });
      await notify(tx, {
        recipientType: "STUDENT", recipientId: sub.enrolmentId, event: "receipt.rejected", dedupeKey: `receipt.rejected:${action.id}`,
        title: "Payment receipt needs attention", body: `Your receipt was not accepted: ${input.reason}. You can upload a replacement.`,
      });
      await afterLedgerChange(tx, sub.enrolmentId);
      return { submissionId: sub.id, status: "REJECTED", version: upd.version, actionId: action.id };
    });
    return { ...result, replayed };
  });
}

/** Reverse every active allocation of a payment event and append a REVERSAL event. */
async function reversePaymentEvent(tx: Tx, p: StaffPrincipal, eventId: string, reason: string) {
  const [ev] = await tx.select().from(paymentEvents).where(eq(paymentEvents.id, eventId));
  if (!ev || ev.kind === "REVERSAL") throw fail.conflict("Nothing to reverse.");
  const t = now();
  await tx.update(paymentAllocations).set({ reversedAt: t, reversedBy: p.id, reversalReason: reason })
    .where(and(eq(paymentAllocations.paymentEventId, eventId), isNull(paymentAllocations.reversedAt)));
  const [rev] = await tx.insert(paymentEvents).values({
    enrolmentId: ev.enrolmentId, submissionId: ev.submissionId, kind: "REVERSAL", amountMinor: ev.amountMinor, currency: ev.currency,
    reversesEventId: ev.id, effectiveDate: businessDate(), actorId: p.id, amountChangeReason: reason,
  }).returning();
  return rev;
}

async function activeReceiptEvent(tx: DbOrTx, submissionId: string) {
  const rows = await tx.select().from(paymentEvents).where(and(eq(paymentEvents.submissionId, submissionId), eq(paymentEvents.kind, "RECEIPT")));
  for (const r of rows) {
    const [rev] = await tx.select({ id: paymentEvents.id }).from(paymentEvents).where(eq(paymentEvents.reversesEventId, r.id));
    if (!rev) return r;
  }
  return null;
}

/** Allocations on this event created by later, dependent actions (credit applied elsewhere). */
async function dependentAllocations(tx: DbOrTx, eventId: string) {
  return tx.select().from(paymentAllocations).where(and(eq(paymentAllocations.paymentEventId, eventId), isNull(paymentAllocations.reversedAt), eq(paymentAllocations.source, "CREDIT_APPLY")));
}

/**
 * Quick undo: own latest decision, within the window, same receipt version, no dependent changes.
 * Append-only: original actions remain; an UNDO action and (for approvals) a REVERSAL event are added.
 */
export async function undoDecision(p0: StaffPrincipal, rawInput: z.input<typeof undoInput>, idemKey: string, requestId?: string) {
  const input = undoInput.parse(rawInput);
  mutationKey.parse(idemKey);
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    const [original] = await tx.select({ enrolmentId: paymentSubmissions.enrolmentId }).from(paymentSubmissions).where(eq(paymentSubmissions.id, input.submissionId));
    if (!original) throw fail.notFound();
    assertOperational(await enrolmentInScope(tx, p, original.enrolmentId));
    const { result } = await once(tx, `review.undo:${p.id}`, idemKey, input, async () => {
      const { sub, ctx } = await lockSubmission(tx, p, input.submissionId);
      assertOperational(ctx);
      const [last] = await tx.select().from(reviewActions).where(eq(reviewActions.submissionId, sub.id)).orderBy(desc(reviewActions.createdAt)).limit(1);
      if (!last || last.id !== input.actionId || (last.kind !== "APPROVE" && last.kind !== "REJECT")) throw fail.conflict("Only the latest decision can be undone.");
      if (last.actorId !== p.id) throw fail.conflict("You can only undo your own decision.");
      if (now().getTime() - last.createdAt.getTime() > UNDO_WINDOW_MS) throw fail.conflict("The undo window has passed. A Super Admin can use the correction workflow.");
      if (sub.version !== last.submissionVersion + 1) throw fail.conflict("This receipt changed after your decision.");
      if (last.kind === "REJECT") {
        const [rep] = await tx.select({ id: paymentSubmissions.id }).from(paymentSubmissions).where(eq(paymentSubmissions.supersedesSubmissionId, sub.id));
        if (rep) throw fail.conflict("The student already uploaded a replacement for this receipt.");
      }
      if (last.kind === "APPROVE") {
        const ev = await activeReceiptEvent(tx, sub.id);
        if (!ev) throw fail.conflict("No active payment found for this decision.");
        if ((await dependentAllocations(tx, ev.id)).length) throw fail.conflict("Credit from this payment was applied elsewhere. Use the correction workflow.");
        await loadLedger(tx, sub.enrolmentId, { lock: true });
        await reversePaymentEvent(tx, p, ev.id, "Quick undo of approval");
      }
      const [undo] = await tx.insert(reviewActions).values({ submissionId: sub.id, kind: "UNDO", actorId: p.id, submissionVersion: sub.version, priorActionId: last.id }).returning();
      const [upd] = await tx.update(paymentSubmissions).set({ status: "PENDING_REVIEW", version: sub.version + 1, decidedAt: null, decidedBy: null })
        .where(and(eq(paymentSubmissions.id, sub.id), eq(paymentSubmissions.version, sub.version))).returning();
      await loadLedger(tx, sub.enrolmentId);
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "receipt.undo", entityType: "payment_submission", entityId: sub.id, programmeId: ctx.programmeId, intakeId: ctx.intakeId, before: { kind: last.kind }, requestId });
      await notify(tx, { recipientType: "STUDENT", recipientId: sub.enrolmentId, event: "receipt.reopened", dedupeKey: `receipt.reopened:${undo.id}`, title: "Receipt back under review", body: "A recent decision on your receipt was withdrawn; it is being reviewed again." });
      await afterLedgerChange(tx, sub.enrolmentId);
      return { submissionId: sub.id, status: "PENDING_REVIEW" as const, version: upd.version, actionId: undo.id };
    });
    return result;
  });
}

/** Preview what a Super Admin correction would reverse (including dependent credit applications). */
export async function previewCorrection(tx: DbOrTx, p: StaffPrincipal, submissionId: string) {
  requireSuper(p);
  const [sub] = await tx.select().from(paymentSubmissions).where(eq(paymentSubmissions.id, submissionId));
  if (!sub) throw fail.notFound();
  const ev = await activeReceiptEvent(tx, sub.id);
  if (!ev) return { submission: sub, event: null, allocations: [] };
  const allocs = await tx.select({ a: paymentAllocations, label: instalments.periodLabel }).from(paymentAllocations)
    .innerJoin(instalments, eq(instalments.id, paymentAllocations.instalmentId))
    .where(and(eq(paymentAllocations.paymentEventId, ev.id), isNull(paymentAllocations.reversedAt)));
  return { submission: sub, event: ev, allocations: allocs.map((r) => ({ ...r.a, periodLabel: r.label })) };
}

/** Controlled correction (Super Admin, reason required, any age). Reverses the payment incl. dependents. */
export async function correctApproval(p0: StaffPrincipal, rawInput: z.input<typeof correctionInput>, idemKey: string, requestId?: string) {
  const input = correctionInput.parse(rawInput);
  mutationKey.parse(idemKey);
  requireSuper(p0);
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    requireSuper(p);
    const [original] = await tx.select({ enrolmentId: paymentSubmissions.enrolmentId }).from(paymentSubmissions).where(eq(paymentSubmissions.id, input.submissionId));
    if (!original) throw fail.notFound();
    await enrolmentInScope(tx, p, original.enrolmentId);
    const { result } = await once(tx, `review.correct:${p.id}`, idemKey, input, async () => {
      const { sub, ctx } = await lockSubmission(tx, p, input.submissionId);
      if (sub.status !== "APPROVED" || sub.version !== input.expectedVersion) throw await staleError(tx, sub);
      const ev = await activeReceiptEvent(tx, sub.id);
      if (!ev) throw fail.conflict("No active payment to correct.");
      await loadLedger(tx, sub.enrolmentId, { lock: true });
      await reversePaymentEvent(tx, p, ev.id, `Correction: ${input.reason}`);
      const [act] = await tx.insert(reviewActions).values({ submissionId: sub.id, kind: "CORRECTION", actorId: p.id, submissionVersion: sub.version, reason: input.reason }).returning();
      const [upd] = await tx.update(paymentSubmissions).set({ status: "PENDING_REVIEW", version: sub.version + 1, decidedAt: null, decidedBy: null }).where(eq(paymentSubmissions.id, sub.id)).returning();
      await loadLedger(tx, sub.enrolmentId);
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "receipt.correction", entityType: "payment_submission", entityId: sub.id, programmeId: ctx.programmeId, intakeId: ctx.intakeId, reason: input.reason, requestId });
      await notify(tx, { recipientType: "STUDENT", recipientId: sub.enrolmentId, event: "receipt.reopened", dedupeKey: `receipt.corrected:${act.id}`, title: "Receipt back under review", body: "A payment decision was corrected; your receipt is being reviewed again." });
      await afterLedgerChange(tx, sub.enrolmentId);
      return { submissionId: sub.id, status: "PENDING_REVIEW" as const, version: upd.version, actionId: act.id };
    });
    return result;
  });
}

/** Advisory lease to reduce collisions; DB locks/version checks stay authoritative. */
export async function claimLease(p0: StaffPrincipal, submissionId: string) {
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    const [sub] = await tx.select().from(paymentSubmissions).where(eq(paymentSubmissions.id, submissionId)).for("update");
    if (!sub) throw fail.notFound();
    await enrolmentInScope(tx, p, sub.enrolmentId);
    const t = now();
    if (sub.leaseHolder && sub.leaseHolder !== p.id && sub.leaseExpiresAt && sub.leaseExpiresAt > t) {
      const [s] = await tx.select({ name: staffAccounts.name }).from(staffAccounts).where(eq(staffAccounts.id, sub.leaseHolder));
      return { leased: false, heldBy: s?.name ?? "another reviewer", until: sub.leaseExpiresAt.toISOString() };
    }
    await tx.update(paymentSubmissions).set({ leaseHolder: p.id, leaseExpiresAt: new Date(t.getTime() + LEASE_MS) }).where(eq(paymentSubmissions.id, sub.id));
    return { leased: true, heldBy: null, until: new Date(t.getTime() + LEASE_MS).toISOString() };
  });
}

export async function releaseLease(p0: StaffPrincipal, submissionId: string) {
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    const [sub] = await tx.select({ enrolmentId: paymentSubmissions.enrolmentId }).from(paymentSubmissions).where(eq(paymentSubmissions.id, submissionId));
    if (!sub) throw fail.notFound();
    await enrolmentInScope(tx, p, sub.enrolmentId);
    await tx.update(paymentSubmissions).set({ leaseHolder: null, leaseExpiresAt: null })
      .where(and(eq(paymentSubmissions.id, submissionId), eq(paymentSubmissions.leaseHolder, p.id)));
  });
}

export const queueFilters = z.object({
  programmeId: z.string().uuid().optional(),
  intakeId: z.string().uuid().optional(),
  period: z.string().trim().max(100).optional(),
  from: z.string().refine(isBizDate, "Enter a valid start date.").optional(),
  to: z.string().refine(isBizDate, "Enter a valid end date.").optional(),
  flagged: z.enum(["any", "flagged", "clean"]).default("any"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  skip: z.array(z.string().uuid()).max(500).default([]),
}).refine(f => !f.from || !f.to || f.from <= f.to, { message: "End date must be on or after start date.", path: ["to"] });
export type QueueFilters = z.infer<typeof queueFilters>;

/** Pending queue in scope, oldest first, keyset pagination on (submitted_at, id). */
export async function pendingQueue(tx: DbOrTx, p: StaffPrincipal, f: QueueFilters) {
  const conds = [
    eq(paymentSubmissions.status, "PENDING_REVIEW"),
    intakeScopeWhere(p, intakes.id, intakes.programmeId),
    isNull(intakes.trashedAt), isNull(programmes.trashedAt),
  ];
  if (f.programmeId) conds.push(eq(intakes.programmeId, f.programmeId));
  if (f.intakeId) conds.push(eq(intakes.id, f.intakeId));
  if (f.period) conds.push(sql`lower(${instalments.periodLabel}) like ${"%" + f.period.toLowerCase() + "%"}`);
  if (f.from) conds.push(sql`(${paymentSubmissions.submittedAt} at time zone 'Asia/Colombo')::date >= ${f.from}::date`);
  if (f.to) conds.push(sql`(${paymentSubmissions.submittedAt} at time zone 'Asia/Colombo')::date <= ${f.to}::date`);
  if (f.flagged === "flagged") conds.push(sql`jsonb_array_length(${paymentSubmissions.flags}) > 0`);
  if (f.flagged === "clean") conds.push(sql`jsonb_array_length(${paymentSubmissions.flags}) = 0`);
  if (f.skip.length) conds.push(sql`${paymentSubmissions.id} not in (${sql.join(f.skip.map((s) => sql`${s}::uuid`), sql`, `)})`);
  if (f.cursor) {
    const [ts, id] = f.cursor.split("|");
    if (ts && id && /^[0-9a-f-]{36}$/i.test(id)) {
      const d = new Date(ts);
      conds.push(or(gt(paymentSubmissions.submittedAt, d), and(eq(paymentSubmissions.submittedAt, d), gt(paymentSubmissions.id, id)))!);
    }
  }
  const rows = await tx.select({
    id: paymentSubmissions.id, enrolmentId: paymentSubmissions.enrolmentId, claimedMinor: paymentSubmissions.claimedMinor,
    transferDate: paymentSubmissions.transferDate, submittedAt: paymentSubmissions.submittedAt, flags: paymentSubmissions.flags,
    version: paymentSubmissions.version, studentName: students.fullName, studentRef: students.ref,
    programmeName: programmes.name, intakeLabel: intakes.label, periodLabel: instalments.periodLabel,
    leaseHolder: paymentSubmissions.leaseHolder, leaseExpiresAt: paymentSubmissions.leaseExpiresAt,
  }).from(paymentSubmissions)
    .innerJoin(enrolments, eq(enrolments.id, paymentSubmissions.enrolmentId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .innerJoin(instalments, eq(instalments.id, paymentSubmissions.targetInstalmentId))
    .where(and(...conds))
    .orderBy(asc(paymentSubmissions.submittedAt), asc(paymentSubmissions.id))
    .limit(f.limit + 1);
  const more = rows.length > f.limit;
  const items = rows.slice(0, f.limit);
  const last = items[items.length - 1];
  const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(paymentSubmissions)
    .innerJoin(enrolments, eq(enrolments.id, paymentSubmissions.enrolmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(eq(paymentSubmissions.status, "PENDING_REVIEW"), intakeScopeWhere(p, intakes.id, intakes.programmeId), isNull(intakes.trashedAt), isNull(programmes.trashedAt)));
  return { items, nextCursor: more && last ? `${last.submittedAt.toISOString()}|${last.id}` : null, totalPending: total };
}

/** Full review context for one submission (scoped). */
export async function reviewContext(tx: DbOrTx, p: StaffPrincipal, submissionId: string) {
  const [sub] = await tx.select().from(paymentSubmissions).where(eq(paymentSubmissions.id, submissionId));
  if (!sub) throw fail.notFound();
  const ctx = await enrolmentInScope(tx, p, sub.enrolmentId);
  const [info] = await tx.select({ student: students, programmeName: programmes.name, intakeLabel: intakes.label })
    .from(enrolments).innerJoin(students, eq(students.id, enrolments.studentId)).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(eq(enrolments.id, sub.enrolmentId));
  const asset = sub.assetId ? (await tx.select().from(receiptAssets).where(eq(receiptAssets.id, sub.assetId)))[0] ?? null : null;
  const ledger = await loadLedger(tx, sub.enrolmentId);
  const history = await tx.select().from(paymentSubmissions).where(and(eq(paymentSubmissions.enrolmentId, sub.enrolmentId))).orderBy(desc(paymentSubmissions.submittedAt)).limit(30);
  const actions = await tx.select({ a: reviewActions, actor: staffAccounts.name }).from(reviewActions).leftJoin(staffAccounts, eq(staffAccounts.id, reviewActions.actorId))
    .where(inArray(reviewActions.submissionId, history.map((h) => h.id))).orderBy(desc(reviewActions.createdAt));
  // Replacement chain.
  const chain: (typeof paymentSubmissions.$inferSelect)[] = [];
  let cur: typeof paymentSubmissions.$inferSelect | undefined = sub;
  const seen = new Set<string>();
  while (cur?.supersedesSubmissionId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const prev: typeof paymentSubmissions.$inferSelect | undefined = history.find((h) => h.id === cur!.supersedesSubmissionId) ?? (await tx.select().from(paymentSubmissions).where(eq(paymentSubmissions.id, cur.supersedesSubmissionId)))[0];
    if (!prev) break;
    chain.push(prev);
    cur = prev;
  }
  const { plan } = await previewApproval(tx, p, sub.id, { spillOver: false });
  return {
    submission: sub, ctx, student: { name: info.student.fullName, ref: info.student.ref, nicMasked: info.student.nicMasked, phone: info.student.phone },
    programmeName: info.programmeName, intakeLabel: info.intakeLabel, asset, ledger, history, chain,
    actions: actions.map((r) => ({ ...r.a, actorName: r.actor })), proposedPlan: plan, isSuper: isSuper(p),
    myLatestUndoable: actions.find((r) => r.a.submissionId === sub.id)?.a ?? null,
  };
}

