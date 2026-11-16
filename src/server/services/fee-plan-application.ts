import "server-only";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { withTx, type Tx } from "@/db/client";
import { chargeAdjustments, enrolments, feePlanItems, feePlanVersions, intakes, programmes, students } from "@/db/schema";
import { feeChangeImpact } from "@/domain/finance";
import { businessDate, now } from "@/lib/time";
import { freshPrincipal } from "@/server/auth/fresh";
import { assertOperational, enrolmentInScope, inScope, requireCap, type StaffPrincipal } from "@/server/auth/policy";
import { audit } from "@/server/audit";
import { fail } from "@/server/http";
import { hashPayload, once } from "@/server/idempotency";
import { releaseExcess } from "./enrolments";
import { afterLedgerChange } from "./hooks";
import { loadLedger } from "./ledger";

const ids = z.array(z.string().uuid()).min(1).max(50).refine(v => new Set(v).size === v.length, "Select each enrolment once.");
export const feePreviewInput = z.object({ versionId: z.string().uuid(), enrolmentIds: ids });
export const feeApplyInput = z.object({
  versionId: z.string().uuid(), reason: z.string().trim().min(5).max(1000),
  selections: z.array(z.object({ enrolmentId: z.string().uuid(), previewHash: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(50)
    .refine(v => new Set(v.map(x => x.enrolmentId)).size === v.length, "Select each enrolment once."),
});

async function target(tx: Tx, p: StaffPrincipal, versionId: string) {
  const [version] = await tx.select().from(feePlanVersions).where(eq(feePlanVersions.id, versionId)).for("share");
  if (!version) throw fail.notFound();
  const [intake] = await tx.select().from(intakes).where(eq(intakes.id, version.intakeId)).for("share");
  if (!intake || !inScope(p, intake.programmeId, intake.id)) throw fail.notFound();
  const [programme] = await tx.select().from(programmes).where(eq(programmes.id, intake.programmeId)).for("share");
  if (!programme) throw fail.notFound();
  return { version, intake, programme };
}

export async function feePlanCandidates(p0: StaffPrincipal, versionId: string, after?: string) {
  z.string().uuid().parse(versionId); if (after) z.string().uuid().parse(after);
  return withTx(async tx => {
    const p = await freshPrincipal(tx, p0); requireCap(p, "fees.adjust");
    const t = await target(tx, p, versionId);
    const rows = await tx.select({ id: enrolments.id, name: students.fullName, ref: students.ref, version: enrolments.version, planVersionId: enrolments.feePlanVersionId })
      .from(enrolments).innerJoin(students, eq(students.id, enrolments.studentId))
      .where(and(eq(enrolments.intakeId, t.intake.id), eq(enrolments.status, "ACTIVE"), after ? gt(enrolments.id, after) : undefined))
      .orderBy(asc(enrolments.id)).limit(101);
    return { items: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99].id : null };
  });
}

async function impact(tx: Tx, p: StaffPrincipal, t: Awaited<ReturnType<typeof target>>, id: string) {
  const scope = await enrolmentInScope(tx, p, id); assertOperational(scope);
  const [enrolment] = await tx.select().from(enrolments).where(eq(enrolments.id, id)).for("update");
  if (enrolment.intakeId !== t.intake.id) throw fail.notFound();
  const [student] = await tx.select({ name: students.fullName, ref: students.ref }).from(students).where(eq(students.id, enrolment.studentId));
  const ledger = await loadLedger(tx, id, { lock: true });
  const sourceItems = enrolment.feePlanVersionId ? await tx.select().from(feePlanItems).where(eq(feePlanItems.versionId, enrolment.feePlanVersionId)).orderBy(asc(feePlanItems.sequence)) : [];
  const targetItems = await tx.select().from(feePlanItems).where(eq(feePlanItems.versionId, t.version.id)).orderBy(asc(feePlanItems.sequence));
  let blocked: string | null = null;
  if (!t.version.isCurrent) blocked = "Choose the current fee-plan version and preview again.";
  else if (t.intake.trashedAt || t.programme.trashedAt) blocked = "Restore this programme or intake before applying changes.";
  else if (enrolment.status !== "ACTIVE") blocked = "Only active enrolments can receive fee changes.";
  else if (enrolment.currency !== t.version.currency) blocked = "Currencies do not match.";
  else if (enrolment.feePlanVersionId === t.version.id) blocked = "This enrolment already uses this version.";
  else if (!sourceItems.length || sourceItems.length !== targetItems.length || ledger.instalments.length !== sourceItems.length) blocked = "The schedule has missing or extra instalments. Correct its structure separately before applying amounts.";
  const lines: ReturnType<typeof feeChangeImpact>[] = [];
  if (!blocked) {
    for (let n = 0; n < sourceItems.length; n++) {
      const before = sourceItems[n], after = targetItems[n], inst = ledger.instalments[n];
      if (before.sequence !== after.sequence || inst.sequence !== before.sequence || before.component !== after.component || inst.component !== before.component || before.dueDate !== after.dueDate || inst.dueDate !== before.dueDate || before.periodLabel !== after.periodLabel || inst.periodLabel !== before.periodLabel) {
        blocked = "Dates, sequence, component or period labels differ. No automatic mapping is permitted; correct the schedule separately."; break;
      }
      try { lines.push(feeChangeImpact(inst, before.amountMinor, after.amountMinor)); }
      catch { blocked = "This reduction would exceed the obligation after existing exemptions. Review the individual awards first."; break; }
    }
  }
  const result = { enrolmentId: id, studentName: student.name, studentRef: student.ref, expectedVersion: enrolment.version, blocked, lines: blocked ? [] : lines };
  const previewHash = hashPayload({ enrolment, ledger, sourceItems, targetItems, current: t.version.isCurrent, result });
  return { ...result, previewHash };
}

export async function previewFeePlan(p0: StaffPrincipal, raw: z.input<typeof feePreviewInput>) {
  const input = feePreviewInput.parse(raw);
  return withTx(async tx => {
    const p = await freshPrincipal(tx, p0); requireCap(p, "fees.adjust");
    const t = await target(tx, p, input.versionId);
    const rows = [];
    for (const id of [...input.enrolmentIds].sort()) rows.push(await impact(tx, p, t, id));
    return { versionId: t.version.id, versionNo: t.version.versionNo, rows };
  });
}

export async function applyFeePlan(p0: StaffPrincipal, raw: z.input<typeof feeApplyInput>, idemKey: string, requestId?: string) {
  const input = feeApplyInput.parse(raw);
  return withTx(async tx => {
    const p = await freshPrincipal(tx, p0); requireCap(p, "fees.adjust");
    const t = await target(tx, p, input.versionId);
    const selections = [...input.selections].sort((a, b) => a.enrolmentId.localeCompare(b.enrolmentId));
    // Replays still require current authorization for every selected record.
    for (const row of selections) await enrolmentInScope(tx, p, row.enrolmentId);
    const { result } = await once(tx, `feeplan.apply:${p.id}`, idemKey, input, async () => {
      // Check all locked previews before writing anything; the batch is all-or-nothing.
      const previews = [];
      for (const row of selections) {
        const preview = await impact(tx, p, t, row.enrolmentId);
        if (preview.previewHash !== row.previewHash) throw fail.stale("Financial details or fee-plan terms changed. Preview the selected enrolments again.");
        if (preview.blocked) throw fail.validation(preview.blocked);
        previews.push(preview);
      }
      for (const preview of previews) {
        const ledger = await loadLedger(tx, preview.enrolmentId);
        for (const line of preview.lines) {
          if (!line.deltaMinor) continue;
          const inst = ledger.instalments.find(i => i.id === line.instalmentId)!;
          await releaseExcess(tx, p, inst, line.releasedToCreditMinor, input.reason);
          await tx.insert(chargeAdjustments).values({ enrolmentId: preview.enrolmentId, instalmentId: line.instalmentId, amountMinor: line.deltaMinor, kind: "FEE_CHANGE", reason: input.reason, effectiveDate: businessDate(), actorId: p.id });
        }
        await tx.update(enrolments).set({ feePlanVersionId: t.version.id, version: preview.expectedVersion + 1, updatedAt: now() }).where(eq(enrolments.id, preview.enrolmentId));
        await loadLedger(tx, preview.enrolmentId); // Enforce financial invariants before commit.
        await afterLedgerChange(tx, preview.enrolmentId);
        await audit(tx, { actorType: "STAFF", actorId: p.id, action: "feeplan.apply", entityType: "enrolment", entityId: preview.enrolmentId, programmeId: t.programme.id, intakeId: t.intake.id, reason: input.reason, before: { previewHash: preview.previewHash }, after: { versionId: t.version.id, lines: preview.lines }, requestId });
      }
      return { applied: previews.map(row => row.enrolmentId), versionId: t.version.id };
    });
    return result;
  });
}
