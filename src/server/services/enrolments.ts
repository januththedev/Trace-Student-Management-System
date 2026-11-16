import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx, type DbOrTx, type Tx } from "@/db/client";
import {
  admissionEvents, admissions, chargeAdjustments, enrolments, exemptionApplications, exemptionAwards, feePlanItems, feePlanVersions,
  followUpTasks, instalments, intakes, paymentAllocations, paymentEvents, programmes, studentSessions, students,
} from "@/db/schema";
import { exemptionAmountFor, type InstalmentView } from "@/domain/finance";
import { encryptNic, nicLookup } from "@/lib/crypto";
import { formatMinor } from "@/lib/money";
import { isValidNicFormat, maskNic, normalizeNic } from "@/lib/nic";
import { businessDate, isBizDate, now } from "@/lib/time";
import { audit, notify } from "@/server/audit";
import { assertOperational, enrolmentInScope, inScope, isSuper, requireCap, type StaffPrincipal } from "@/server/auth/policy";
import { fail } from "@/server/http";
import { once } from "@/server/idempotency";
import { freshPrincipal } from "@/server/auth/fresh";
import { afterLedgerChange } from "./hooks";
import { loadLedger } from "./ledger";

const bizDate = z.string().refine(isBizDate, "Invalid date");

/* =============================================================== releases */

/**
 * Reduce active allocations on an instalment by `excess` (newest first), keeping payment
 * attribution: the reversed allocation is replaced by a smaller one on the same payment event.
 * The released money becomes enrolment credit automatically (credit = receipts − allocations).
 */
export async function releaseExcess(tx: Tx, p: StaffPrincipal, inst: InstalmentView, excess: number, reason: string) {
  if (excess <= 0) return 0;
  const allocs = await tx.select().from(paymentAllocations)
    .where(and(eq(paymentAllocations.instalmentId, inst.id), isNull(paymentAllocations.reversedAt)))
    .orderBy(desc(paymentAllocations.createdAt), desc(paymentAllocations.id));
  let left = excess;
  for (const a of allocs) {
    if (left <= 0) break;
    const cut = Math.min(a.amountMinor, left);
    let replacementId: string | null = null;
    if (a.amountMinor - cut > 0) {
      const [r] = await tx.insert(paymentAllocations).values({
        enrolmentId: a.enrolmentId, instalmentId: a.instalmentId, paymentEventId: a.paymentEventId, amountMinor: a.amountMinor - cut,
        currency: a.currency, source: "EXEMPTION_REALLOCATION", actorId: p.id, reason,
      }).returning({ id: paymentAllocations.id });
      replacementId = r.id;
    }
    await tx.update(paymentAllocations).set({ reversedAt: now(), reversedBy: p.id, reversalReason: reason, replacedByAllocationId: replacementId }).where(eq(paymentAllocations.id, a.id));
    left -= cut;
  }
  return excess - left;
}

/* ============================================================= exemptions */

export const awardInput = z.object({
  enrolmentId: z.string().uuid(),
  type: z.enum(["FREE_CARD", "SPONSORSHIP", "DISCOUNT", "ARREARS_WAIVER"]),
  basis: z.enum(["FIXED", "PERCENT"]),
  value: z.number().int().positive(),
  capMinor: z.number().int().positive().optional(),
  reason: z.string().trim().min(3).max(1000),
  sponsorName: z.string().trim().max(200).optional(),
  effectiveFrom: bizDate,
  effectiveTo: bizDate.optional(),
  instalmentIds: z.array(z.string().uuid()).min(1).max(120),
  expectedEnrolmentVersion: z.number().int().positive().optional(),
}).refine((v) => v.basis !== "PERCENT" || v.value <= 10000, { message: "Percent is in basis points (max 10000)", path: ["value"] })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: "End date must be after start", path: ["effectiveTo"] });

export interface ExemptionImpactLine { instalmentId: string; periodLabel: string; netBefore: number; exemption: number; netAfter: number; releasedToCredit: number }

function exemptionPlan(views: InstalmentView[], input: z.infer<typeof awardInput>): ExemptionImpactLine[] {
  const lines: ExemptionImpactLine[] = [];
  for (const id of input.instalmentIds) {
    const v = views.find((x) => x.id === id);
    if (!v) throw fail.validation("An instalment does not belong to this enrolment.");
    if (v.dueDate < input.effectiveFrom || (input.effectiveTo && v.dueDate > input.effectiveTo)) continue;
    const base = v.originalChargeMinor + v.adjustmentsMinor;
    const amt = exemptionAmountFor(input.basis, input.value, base, v.exemptionsMinor, input.capMinor ?? null);
    if (amt <= 0) continue;
    const netAfter = v.netObligationMinor - amt;
    lines.push({ instalmentId: v.id, periodLabel: v.periodLabel, netBefore: v.netObligationMinor, exemption: amt, netAfter, releasedToCredit: Math.max(0, v.allocatedMinor - netAfter) });
  }
  return lines;
}

export async function previewExemption(tx: DbOrTx, p: StaffPrincipal, input: z.infer<typeof awardInput>) {
  requireCap(p, "exemptions.manage");
  await enrolmentInScope(tx, p, input.enrolmentId);
  const ledger = await loadLedger(tx, input.enrolmentId);
  const lines = exemptionPlan(ledger.instalments, input);
  return { lines, totalExemption: lines.reduce((a, l) => a + l.exemption, 0), totalReleased: lines.reduce((a, l) => a + l.releasedToCredit, 0) };
}

export async function grantExemption(p0: StaffPrincipal, rawInput: z.input<typeof awardInput>, idemKey: string, requestId?: string) {
  const input = awardInput.parse(rawInput);
  requireCap(p0, "exemptions.manage");
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    await enrolmentInScope(tx, p, input.enrolmentId); // authorize before any idempotent replay
    const { result } = await once(tx, `exemption:${p.id}`, idemKey, input, async () => {
      const ctx = await enrolmentInScope(tx, p, input.enrolmentId);
      assertOperational(ctx);
      const [enr] = await tx.select().from(enrolments).where(eq(enrolments.id, input.enrolmentId)).for("update");
      if (enr.version !== input.expectedEnrolmentVersion) throw fail.stale("This enrolment changed. Review the preview again.");
      const ledger = await loadLedger(tx, input.enrolmentId, { lock: true });
      const lines = exemptionPlan(ledger.instalments, input);
      if (!lines.length) throw fail.validation("The award does not apply to any selected instalment.");
      const [award] = await tx.insert(exemptionAwards).values({
        enrolmentId: input.enrolmentId, type: input.type, basis: input.basis, value: input.value, capMinor: input.capMinor ?? null, reason: input.reason,
        sponsorName: input.sponsorName ?? null, approverId: p.id, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null,
      }).returning();
      for (const l of lines) {
        await tx.insert(exemptionApplications).values({ awardId: award.id, enrolmentId: input.enrolmentId, instalmentId: l.instalmentId, amountMinor: l.exemption });
        const v = ledger.instalments.find((x) => x.id === l.instalmentId)!;
        await releaseExcess(tx, p, v, l.releasedToCredit, `Exemption ${award.id} reduced obligation`);
      }
      await tx.update(enrolments).set({ version: enr.version + 1, updatedAt: now() }).where(eq(enrolments.id, enr.id));
      await loadLedger(tx, input.enrolmentId); // invariant check
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "exemption.grant", entityType: "exemption_award", entityId: award.id, programmeId: ctx.programmeId, intakeId: ctx.intakeId, reason: input.reason, after: { type: input.type, basis: input.basis, value: input.value, lines }, requestId });
      await closeObsoleteTasks(tx, input.enrolmentId, "Obligation reduced by exemption");
      await afterLedgerChange(tx, input.enrolmentId);
      return { awardId: award.id, lines };
    });
    return result;
  });
}

export const revokeInput = z.object({ awardId: z.string().uuid(), reason: z.string().trim().min(3).max(1000), expectedEnrolmentVersion: z.number().int().positive().optional() });

export async function revokeExemption(p0: StaffPrincipal, rawInput: z.input<typeof revokeInput>, requestId?: string) {
  const input = revokeInput.parse(rawInput);
  requireCap(p0, "exemptions.manage");
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    const [award] = await tx.select().from(exemptionAwards).where(eq(exemptionAwards.id, input.awardId)).for("update");
    if (!award) throw fail.notFound();
    const ctx = await enrolmentInScope(tx, p, award.enrolmentId);
    assertOperational(ctx);
    if (award.status !== "ACTIVE") throw fail.conflict("This award was already revoked.");
    const [enr] = await tx.select().from(enrolments).where(eq(enrolments.id, award.enrolmentId)).for("update");
    if (input.expectedEnrolmentVersion !== undefined && enr.version !== input.expectedEnrolmentVersion) throw fail.stale("This enrolment changed. Review it again.");
    await tx.update(enrolments).set({ version: enr.version + 1, updatedAt: now() }).where(eq(enrolments.id, enr.id));
    await loadLedger(tx, award.enrolmentId, { lock: true });
    await tx.update(exemptionApplications).set({ reversedAt: now(), reversedBy: p.id, reversalReason: input.reason }).where(and(eq(exemptionApplications.awardId, award.id), isNull(exemptionApplications.reversedAt)));
    await tx.update(exemptionAwards).set({ status: "REVOKED", revokedAt: now(), revokedBy: p.id, revokeReason: input.reason }).where(eq(exemptionAwards.id, award.id));
    await loadLedger(tx, award.enrolmentId);
    await audit(tx, { actorType: "STAFF", actorId: p.id, action: "exemption.revoke", entityType: "exemption_award", entityId: award.id, programmeId: ctx.programmeId, intakeId: ctx.intakeId, reason: input.reason, requestId });
    await afterLedgerChange(tx, award.enrolmentId);
    return { awardId: award.id };
  });
}

/* ========================================================== credit apply */

export const creditInput = z.object({ enrolmentId: z.string().uuid(), expectedEnrolmentVersion: z.number().int().positive().optional(), instalmentId: z.string().uuid(), amountMinor: z.number().int().positive(), reason: z.string().trim().min(3).max(500) });

/** Apply existing enrolment credit to an unpaid/future instalment. Not a new collection. */
export async function applyCredit(p0: StaffPrincipal, rawInput: z.input<typeof creditInput>, idemKey: string, requestId?: string) {
  const input = creditInput.parse(rawInput);
  requireCap(p0, "fees.adjust");
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    await enrolmentInScope(tx, p, input.enrolmentId); // authorize before any idempotent replay
    const { result } = await once(tx, `credit:${p.id}`, idemKey, input, async () => {
      const ctx = await enrolmentInScope(tx, p, input.enrolmentId);
      assertOperational(ctx);
      const [enr] = await tx.select().from(enrolments).where(eq(enrolments.id, input.enrolmentId)).for("update");
      if (input.expectedEnrolmentVersion !== undefined && enr.version !== input.expectedEnrolmentVersion) throw fail.stale("This enrolment changed. Review it again.");
      await tx.update(enrolments).set({ version: enr.version + 1, updatedAt: now() }).where(eq(enrolments.id, enr.id));
      const ledger = await loadLedger(tx, input.enrolmentId, { lock: true });
      const target = ledger.instalments.find((i) => i.id === input.instalmentId);
      if (!target) throw fail.notFound();
      if (input.amountMinor > ledger.summary.creditMinor) throw fail.validation(`Only ${formatMinor(ledger.summary.creditMinor)} credit is available.`);
      if (input.amountMinor > target.remainingMinor) throw fail.validation("Amount exceeds the instalment's remaining balance.");
      // Draw from payment events that still have unallocated room, oldest first (keeps source attribution).
      const events = await tx.execute<{ id: string; currency: string; room: string }>(sql`
        select e.id, e.currency, (e.amount_minor - coalesce(sum(a.amount_minor) filter (where a.reversed_at is null), 0))::text as room
        from payment_events e left join payment_allocations a on a.payment_event_id = e.id
        where e.enrolment_id = ${input.enrolmentId} and e.kind in ('RECEIPT','HISTORICAL_IMPORT')
          and not exists (select 1 from payment_events r where r.reverses_event_id = e.id)
        group by e.id order by e.created_at, e.id`);
      let left = input.amountMinor;
      const lines: { paymentEventId: string; amountMinor: number }[] = [];
      for (const e of events) {
        const room = Number(e.room);
        if (room <= 0 || left <= 0) continue;
        const take = Math.min(room, left);
        await tx.insert(paymentAllocations).values({ enrolmentId: input.enrolmentId, instalmentId: target.id, paymentEventId: e.id, amountMinor: take, currency: e.currency, source: "CREDIT_APPLY", actorId: p.id, reason: input.reason });
        lines.push({ paymentEventId: e.id, amountMinor: take });
        left -= take;
      }
      if (left > 0) throw fail.conflict("Credit changed while applying. Please retry.");
      await loadLedger(tx, input.enrolmentId);
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "credit.apply", entityType: "instalment", entityId: target.id, programmeId: ctx.programmeId, intakeId: ctx.intakeId, reason: input.reason, after: { amountMinor: input.amountMinor, lines }, requestId });
      await afterLedgerChange(tx, input.enrolmentId);
      return { applied: input.amountMinor, lines };
    });
    return result;
  });
}

/* ============================================================ withdrawal */

export const withdrawalInput = z.object({ enrolmentId: z.string().uuid(), effectiveDate: bizDate, reason: z.string().trim().min(3).max(1000), expectedVersion: z.number().int().positive() });

export async function previewWithdrawal(tx: DbOrTx, p: StaffPrincipal, enrolmentId: string, effectiveDate: string) {
  requireCap(p, "withdrawals.manage");
  await enrolmentInScope(tx, p, enrolmentId);
  const ledger = await loadLedger(tx, enrolmentId);
  const cancel = ledger.instalments.filter((i) => i.dueDate > effectiveDate && i.netObligationMinor > 0);
  const retained = ledger.instalments.filter((i) => i.dueDate <= effectiveDate);
  const released = cancel.reduce((a, i) => a + i.allocatedMinor, 0);
  const openTasks = await tx.select({ id: followUpTasks.id, type: followUpTasks.type }).from(followUpTasks).where(and(eq(followUpTasks.enrolmentId, enrolmentId), eq(followUpTasks.state, "OPEN")));
  return {
    cancel: cancel.map((i) => ({ id: i.id, periodLabel: i.periodLabel, dueDate: i.dueDate, netObligationMinor: i.netObligationMinor, allocatedMinor: i.allocatedMinor })),
    retained: retained.map((i) => ({ id: i.id, periodLabel: i.periodLabel, dueDate: i.dueDate, remainingMinor: i.remainingMinor })),
    retainedArrearsMinor: retained.reduce((a, i) => a + i.remainingMinor, 0),
    creditAfterMinor: ledger.summary.creditMinor + released,
    refundConsiderationMinor: ledger.summary.creditMinor + released,
    openTasks: openTasks.length,
  };
}

export async function withdrawEnrolment(p0: StaffPrincipal, rawInput: z.input<typeof withdrawalInput>, idemKey: string, requestId?: string) {
  const input = withdrawalInput.parse(rawInput);
  requireCap(p0, "withdrawals.manage");
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    await enrolmentInScope(tx, p, input.enrolmentId); // authorize before any idempotent replay
    const { result } = await once(tx, `withdraw:${p.id}`, idemKey, input, async () => {
      const ctx = await enrolmentInScope(tx, p, input.enrolmentId);
      assertOperational(ctx);
      const [enr] = await tx.select().from(enrolments).where(eq(enrolments.id, input.enrolmentId)).for("update");
      if (enr.status !== "ACTIVE") throw fail.conflict("Only an active enrolment can be withdrawn.");
      if (enr.version !== input.expectedVersion) throw fail.stale("This enrolment changed. Review the preview again.");
      const ledger = await loadLedger(tx, input.enrolmentId, { lock: true });
      const future = ledger.instalments.filter((i) => i.dueDate > input.effectiveDate && i.netObligationMinor > 0);
      for (const i of future) {
        await releaseExcess(tx, p, i, i.allocatedMinor, "Future obligation cancelled by withdrawal");
        await tx.insert(chargeAdjustments).values({ enrolmentId: enr.id, instalmentId: i.id, amountMinor: -i.netObligationMinor, kind: "WITHDRAWAL_CANCEL", reason: input.reason, effectiveDate: input.effectiveDate, actorId: p.id });
      }
      await tx.update(enrolments).set({ status: "WITHDRAWN", withdrawnAt: now(), withdrawalEffectiveDate: input.effectiveDate, withdrawalReason: input.reason, version: enr.version + 1, updatedAt: now() }).where(eq(enrolments.id, enr.id));
      await tx.update(studentSessions).set({ revokedAt: now(), revokeReason: "withdrawn" }).where(and(eq(studentSessions.enrolmentId, enr.id), isNull(studentSessions.revokedAt)));
      await tx.update(followUpTasks).set({ state: "CANCELLED", closedAt: now(), closedBy: p.id, closeReason: "Enrolment withdrawn", updatedAt: now() })
        .where(and(eq(followUpTasks.enrolmentId, enr.id), eq(followUpTasks.state, "OPEN"), inArray(followUpTasks.type, ["COLLECTION_CALL", "CALLBACK", "ESCALATION"])));
      const after = await loadLedger(tx, input.enrolmentId);
      if (after.summary.creditMinor > 0) {
        await tx.insert(followUpTasks).values({ enrolmentId: enr.id, type: "REFUND_CONSIDERATION", reason: `Withdrawn with ${formatMinor(after.summary.creditMinor)} unapplied credit. Refunds are handled outside the system.`, dueAt: now(), dedupeKey: `REFUND:${enr.id}`, createdBy: p.id, priority: 1 })
          .onConflictDoNothing({ target: followUpTasks.dedupeKey });
      }
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "enrolment.withdraw", entityType: "enrolment", entityId: enr.id, programmeId: ctx.programmeId, intakeId: ctx.intakeId, reason: input.reason, after: { effectiveDate: input.effectiveDate, cancelled: future.map((f) => f.id), creditMinor: after.summary.creditMinor }, requestId });
      await afterLedgerChange(tx, input.enrolmentId);
      return { enrolmentId: enr.id, cancelled: future.length, creditMinor: after.summary.creditMinor, retainedArrearsMinor: after.summary.outstandingMinor };
    });
    return result;
  });
}

/* ========================================================== fee plans */

export const feePlanInput = z.object({
  intakeId: z.string().uuid(),
  notes: z.string().trim().max(500).default(""),
  items: z.array(z.object({ periodLabel: z.string().trim().min(1).max(80), component: z.string().trim().min(1).max(40).default("TUITION"), amountMinor: z.number().int().min(0), dueDate: bizDate })).min(1).max(120),
});

/** New immutable fee-plan version. Existing enrolments keep their snapshot (no rewrite). */
export async function createFeePlanVersion(p0: StaffPrincipal, rawInput: z.input<typeof feePlanInput>, requestId?: string, idemKey?: string) {
  const input = feePlanInput.parse(rawInput);
  requireCap(p0, "fees.adjust");
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    requireCap(p, "fees.adjust");
    const [intake] = await tx.select().from(intakes).where(eq(intakes.id, input.intakeId)).for("update");
    if (!intake || !inScope(p, intake.programmeId, intake.id)) throw fail.notFound();
    const [prog] = await tx.select({ trashedAt: programmes.trashedAt }).from(programmes).where(eq(programmes.id, intake.programmeId)).for("share");
    if (intake.trashedAt || prog?.trashedAt) throw fail.conflict("This programme or intake is in Trash.");
    const create = async () => {
      const [{ maxV }] = await tx.select({ maxV: sql<number>`coalesce(max(${feePlanVersions.versionNo}), 0)::int` }).from(feePlanVersions).where(eq(feePlanVersions.intakeId, intake.id));
      await tx.update(feePlanVersions).set({ isCurrent: false }).where(and(eq(feePlanVersions.intakeId, intake.id), eq(feePlanVersions.isCurrent, true)));
      const [v] = await tx.insert(feePlanVersions).values({ intakeId: intake.id, versionNo: maxV + 1, notes: input.notes, createdBy: p.id, isCurrent: true }).returning();
      const sorted = [...input.items].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
      await tx.insert(feePlanItems).values(sorted.map((it, i) => ({ versionId: v.id, sequence: i + 1, periodLabel: it.periodLabel, component: it.component, amountMinor: it.amountMinor, dueDate: it.dueDate })));
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "feeplan.version", entityType: "intake", entityId: intake.id, programmeId: intake.programmeId, intakeId: intake.id, after: { versionNo: v.versionNo, items: sorted }, requestId });
      return { versionId: v.id, versionNo: v.versionNo };
    };
    if (!idemKey) return create();
    const { result } = await once(tx, `feeplan.version:${p.id}`, idemKey, input, create);
    return result;
  });
}

async function generateInstalments(tx: Tx, enrolmentId: string, versionId: string) {
  const items = await tx.select().from(feePlanItems).where(eq(feePlanItems.versionId, versionId)).orderBy(asc(feePlanItems.sequence));
  if (!items.length) return 0;
  await tx.insert(instalments).values(items.map((it) => ({ enrolmentId, feePlanItemId: it.id, sequence: it.sequence, component: it.component, periodLabel: it.periodLabel, originalChargeMinor: it.amountMinor, dueDate: it.dueDate })));
  return items.length;
}

/* ============================================================ admissions */

export const admissionInput = z.object({
  intakeId: z.string().uuid(),
  applicantName: z.string().trim().min(2).max(200),
  nic: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal("").transform(() => undefined)),
  sponsorshipRequested: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function createAdmission(p0: StaffPrincipal, rawInput: z.input<typeof admissionInput>, requestId?: string) {
  const input = admissionInput.parse(rawInput);
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    const [intake] = await tx.select({ i: intakes, trashed: programmes.trashedAt }).from(intakes).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(eq(intakes.id, input.intakeId));
    if (!intake || !inScope(p, intake.i.programmeId, intake.i.id)) throw fail.notFound();
    if (intake.i.trashedAt || intake.trashed) throw fail.conflict("This intake is in Trash.");
    let nicFields: { nicEnc: string; nicLookup: string; nicMasked: string } | null = null;
    if (input.nic) {
      const n = normalizeNic(input.nic);
      if (!isValidNicFormat(n)) throw fail.validation("The NIC format is not valid.", { field: "nic" });
      nicFields = { nicEnc: encryptNic(n), nicLookup: nicLookup(n), nicMasked: maskNic(n) };
    }
    const [a] = await tx.insert(admissions).values({
      intakeId: input.intakeId, applicantName: input.applicantName, phone: input.phone ?? null, email: input.email ?? null,
      sponsorshipRequested: input.sponsorshipRequested ?? null, notes: input.notes ?? "", state: "UNDER_REVIEW", createdBy: p.id, ...(nicFields ?? {}),
    }).returning();
    await tx.insert(admissionEvents).values({ admissionId: a.id, fromState: null, toState: "UNDER_REVIEW", actorId: p.id });
    await audit(tx, { actorType: "STAFF", actorId: p.id, action: "admission.create", entityType: "admission", entityId: a.id, programmeId: intake.i.programmeId, intakeId: intake.i.id, requestId });
    return a;
  });
}

export const decisionInput = z.object({
  admissionId: z.string().uuid(),
  decision: z.enum(["ACCEPTED", "REJECTED", "WAITLISTED", "WITHDRAWN", "UNDER_REVIEW"]),
  reason: z.string().trim().max(1000).optional(),
  expectedVersion: z.number().int().positive(),
  /** Must be true to reuse an existing student with the same NIC (explicit confirmation). */
  confirmExistingStudent: z.boolean().default(false),
});

/**
 * Accept: create/reuse the student, create ONE enrolment, snapshot the current fee plan and
 * generate instalments — one idempotent transaction. Re-accepting returns the same enrolment.
 */
export async function decideAdmission(p0: StaffPrincipal, rawInput: z.input<typeof decisionInput>, requestId?: string) {
  const input = decisionInput.parse(rawInput);
  requireCap(p0, "admissions.decide");
  return withTx(async (tx) => {
    const p = await freshPrincipal(tx, p0);
    const [a] = await tx.select().from(admissions).where(eq(admissions.id, input.admissionId)).for("update");
    if (!a) throw fail.notFound();
    const [intake] = await tx.select().from(intakes).where(eq(intakes.id, a.intakeId));
    if (!inScope(p, intake.programmeId, intake.id)) throw fail.notFound();
    if (a.state === "ACCEPTED" && input.decision === "ACCEPTED" && a.enrolmentId) return { admission: a, enrolmentId: a.enrolmentId, replayed: true };
    if (a.version !== input.expectedVersion) throw fail.stale("This application changed. Refresh and try again.");
    if (a.state === "ACCEPTED") throw fail.conflict("Accepted applications cannot change state; manage the enrolment instead.");
    if ((input.decision === "REJECTED" || input.decision === "WITHDRAWN") && !input.reason) throw fail.validation("A reason is required.");
    let enrolmentId: string | null = null;
    let studentId: string | null = null;
    if (input.decision === "ACCEPTED") {
      const [prog] = await tx.select({ trashedAt: programmes.trashedAt }).from(programmes).where(eq(programmes.id, intake.programmeId)).for("share");
      if (intake.trashedAt || prog?.trashedAt) throw fail.conflict("This programme or intake is in Trash.");
      if (!a.nicLookup) throw fail.validation("A valid NIC is required before acceptance.");
      const [existing] = await tx.select().from(students).where(eq(students.nicLookup, a.nicLookup)).for("update");
      if (existing && !isSuper(p)) {
        // Never disclose or attach a person whose enrolments are all outside this staff member's scope.
        const visible = await tx.select({ programmeId: intakes.programmeId, intakeId: intakes.id }).from(enrolments).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).where(eq(enrolments.studentId, existing.id));
        if (!visible.some((v) => inScope(p, v.programmeId, v.intakeId))) throw fail.notFound();
      }
      if (existing) {
        if (!input.confirmExistingStudent) throw fail.conflict("A student with this NIC already exists. Confirm to add this enrolment to the same person.", { needsConfirmation: true });
        studentId = existing.id;
      } else {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(students);
        const [s] = await tx.insert(students).values({ ref: `T2T-${String(n + 1).padStart(6, "0")}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`, nicEnc: a.nicEnc, nicLookup: a.nicLookup, nicMasked: a.nicMasked, fullName: a.applicantName, phone: a.phone, email: a.email }).returning();
        studentId = s.id;
      }
      const [dup] = await tx.select({ id: enrolments.id }).from(enrolments).where(and(eq(enrolments.studentId, studentId), eq(enrolments.intakeId, a.intakeId)));
      if (dup) throw fail.conflict("This person is already enrolled in this intake. Use re-enrolment/reactivation instead.");
      const [plan] = await tx.select().from(feePlanVersions).where(and(eq(feePlanVersions.intakeId, a.intakeId), eq(feePlanVersions.isCurrent, true)));
      const [e] = await tx.insert(enrolments).values({ studentId, intakeId: a.intakeId, feePlanVersionId: plan?.id ?? null, termsSnapshot: { feePlanVersionNo: plan?.versionNo ?? null, acceptedAt: now().toISOString(), sponsorshipRequested: a.sponsorshipRequested } }).returning();
      if (plan) await generateInstalments(tx, e.id, plan.id);
      enrolmentId = e.id;
      if (a.sponsorshipRequested) {
        await tx.insert(followUpTasks).values({ enrolmentId: e.id, type: "EXEMPTION_APPROVAL", reason: `Sponsorship requested at admission: ${a.sponsorshipRequested}`, dueAt: now(), dedupeKey: `ADMISSION_SPONSORSHIP:${a.id}`, createdBy: p.id })
          .onConflictDoNothing({ target: followUpTasks.dedupeKey });
      }
    }
    const [upd] = await tx.update(admissions).set({ state: input.decision, decisionReason: input.reason ?? null, decidedBy: p.id, decidedAt: now(), studentId, enrolmentId, version: a.version + 1, updatedAt: now() }).where(eq(admissions.id, a.id)).returning();
    await tx.insert(admissionEvents).values({ admissionId: a.id, fromState: a.state, toState: input.decision, reason: input.reason ?? null, actorId: p.id });
    await audit(tx, { actorType: "STAFF", actorId: p.id, action: `admission.${input.decision.toLowerCase()}`, entityType: "admission", entityId: a.id, programmeId: intake.programmeId, intakeId: intake.id, reason: input.reason ?? null, after: { enrolmentId }, requestId });
    return { admission: upd, enrolmentId, replayed: false };
  });
}

/* ============================================================ helpers */

async function closeObsoleteTasks(tx: Tx, enrolmentId: string, reason: string) {
  const ledger = await loadLedger(tx, enrolmentId);
  if (ledger.summary.dueNowMinor > 0) return;
  await tx.update(followUpTasks).set({ state: "DONE", closedAt: now(), closeReason: reason, updatedAt: now() })
    .where(and(eq(followUpTasks.enrolmentId, enrolmentId), eq(followUpTasks.state, "OPEN"), inArray(followUpTasks.type, ["COLLECTION_CALL", "CALLBACK"])));
}

/** Staff-side enrolment detail (scoped). */
export async function enrolmentDetail(tx: DbOrTx, p: StaffPrincipal, enrolmentId: string) {
  const ctx = await enrolmentInScope(tx, p, enrolmentId);
  const [row] = await tx.select({ e: enrolments, s: students, i: intakes, pr: programmes }).from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId)).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(eq(enrolments.id, enrolmentId));
  const ledger = await loadLedger(tx, enrolmentId);
  const awards = await tx.select().from(exemptionAwards).where(eq(exemptionAwards.enrolmentId, enrolmentId)).orderBy(desc(exemptionAwards.createdAt));
  const events = await tx.select().from(paymentEvents).where(eq(paymentEvents.enrolmentId, enrolmentId)).orderBy(desc(paymentEvents.createdAt)).limit(100);
  return { ctx, enrolment: row.e, student: row.s, intake: row.i, programme: row.pr, ledger, awards, events, today: businessDate() };
}

export { notify };
