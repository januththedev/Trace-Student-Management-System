import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx } from "@/db/client";
import { callAttempts, enrolments, followUpTasks, paymentPromises, paymentSubmissions, students } from "@/db/schema";
import { businessDate, colomboInstant, now } from "@/lib/time";
import { assertOperational, can, enrolmentInScope, type StaffPrincipal } from "@/server/auth/policy";
import { audit } from "@/server/audit";
import { fail } from "@/server/http";
import { loadLedger } from "@/server/services/ledger";
import { daySchema, freshPrincipal, reasonSchema, replay, versionSchema } from "./shared";
import { inContactWindow, nextBusinessDay, nextContactAt } from "./calendar";
import { collectibleInstalments } from "./queue";
import { recomputePromises } from "./promises";
import { upsertTask } from "./tasks";

export const attemptSchema = z.object({
  enrolmentId: z.uuid(), expectedVersion: versionSchema, expectedStudentVersion: versionSchema.optional(), clientAttemptId: z.string().min(8).max(200),
  outcome: z.enum(["NO_ANSWER", "ANSWERED", "PROMISED_TO_PAY", "ALREADY_PAID", "NEEDS_ASSISTANCE", "NOT_CONTINUING", "FREE_CARD_SPONSORED", "WRONG_NUMBER", "CORRECTION"]),
  notes: z.string().trim().max(2000).optional(), manualOverrideReason: reasonSchema.optional(), taskId: z.uuid().optional(), correctsAttemptId: z.uuid().optional(),
  resolved: z.boolean().optional(), nextAction: reasonSchema.optional(), nextDate: daySchema.optional(),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), promisedDate: daySchema.optional(), targetInstalmentIds: z.array(z.uuid()).min(1).max(100).optional(),
  category: z.string().trim().min(1).max(100).optional(), reason: reasonSchema.optional(), priority: z.number().int().min(1).max(3).optional(), dueDate: daySchema.optional(),
}).superRefine((v, ctx) => {
  const need = (ok: unknown, path: string, message: string) => { if (!ok) ctx.addIssue({ code: "custom", path: [path], message }); };
  if (v.outcome === "ANSWERED") { need(v.notes, "notes", "Add outcome notes."); need(v.resolved === true || v.resolved === false && v.nextAction && v.nextDate, "nextAction", "Choose resolved or a next action and date."); }
  if (v.outcome === "PROMISED_TO_PAY") { need(v.amountMinor, "amountMinor", "Enter a positive amount in minor units."); need(v.promisedDate, "promisedDate", "Choose the promise date."); need(v.targetInstalmentIds?.length, "targetInstalmentIds", "Choose target instalments."); need(v.notes, "notes", "Add promise notes."); }
  if (v.outcome === "NEEDS_ASSISTANCE") for (const field of ["category", "reason", "priority", "dueDate"] as const) need(v[field], field, "Required for assistance.");
  if (v.outcome === "WRONG_NUMBER") need(v.expectedStudentVersion, "expectedStudentVersion", "Refresh the student version.");
  if (v.outcome === "CORRECTION") { need(v.correctsAttemptId, "correctsAttemptId", "Choose the original attempt."); need(v.notes, "notes", "Describe the correction."); }
  else if (v.correctsAttemptId) ctx.addIssue({ code: "custom", path: ["correctsAttemptId"], message: "Only correction attempts can reference an original attempt." });
});

export async function recordCallAttempt(p: StaffPrincipal, raw: unknown, key?: string) {
  const input = attemptSchema.parse(raw);
  return withTx(async tx => {
    const actor = await freshPrincipal(tx, p);
    const ctx = await enrolmentInScope(tx, actor, input.enrolmentId); assertOperational(ctx);
    // Both HTTP keys and operator/clientAttemptId must replay identically.
    return replay(tx, `call-http:${p.id}`, key ?? input.clientAttemptId, input, () => replay(tx, `call-attempt:${p.id}`, input.clientAttemptId, input, async () => {
      const [enrolment] = await tx.select().from(enrolments).where(eq(enrolments.id, input.enrolmentId)).for("update");
      if (enrolment.version !== input.expectedVersion) throw fail.stale("This enrolment changed. Refresh the card.");
      const ledger = await loadLedger(tx, enrolment.id, { lock: true });
      const [student] = await tx.select().from(students).where(eq(students.id, ctx.studentId)).for("update");
      const correction = input.outcome === "CORRECTION";
      if (correction) {
        const [original] = await tx.select().from(callAttempts).where(and(eq(callAttempts.id, input.correctsAttemptId!), eq(callAttempts.enrolmentId, enrolment.id)));
        if (!original) throw fail.notFound();
      } else {
        if (enrolment.status !== "ACTIVE" || student.status !== "ACTIVE" || !collectibleInstalments(ledger).length) throw fail.conflict("This enrolment has no collectible due instalments. Refresh the queue.");
        if (student.doNotCall || student.wrongNumber || !student.phone) throw fail.conflict("Calling is blocked by contact flags or a missing phone.");
      }
      const recent = await tx.select().from(callAttempts).where(and(eq(callAttempts.enrolmentId, enrolment.id), sql`${callAttempts.outcome} <> 'CORRECTION'`)).orderBy(desc(callAttempts.createdAt), desc(callAttempts.id)).limit(3);
      const escalations = await tx.select().from(followUpTasks).where(and(eq(followUpTasks.enrolmentId, enrolment.id), eq(followUpTasks.state, "OPEN"), eq(followUpTasks.type, "ESCALATION")));
      const deferredTasks = await tx.select().from(followUpTasks).where(and(eq(followUpTasks.enrolmentId, enrolment.id), eq(followUpTasks.state, "OPEN"), inArray(followUpTasks.type, ["COLLECTION_CALL", "CALLBACK"])));
      if (!correction && deferredTasks.some(t => t.leaseHolder && t.leaseHolder !== p.id && t.leaseExpiresAt && t.leaseExpiresAt > now())) throw fail.conflict("Another staff member has leased this call task.");
      if (!correction && !input.manualOverrideReason && (!await inContactWindow(tx) || recent.some(a => businessDate(a.createdAt) === businessDate()) || escalations.length || deferredTasks.some(t => t.dueAt > now() || t.paused))) throw fail.conflict("Outside the contact window, already contacted today, or follow-up paused/deferred. A manual override reason is required.");
      if (input.taskId) {
        const [task] = await tx.select().from(followUpTasks).where(and(eq(followUpTasks.id, input.taskId), eq(followUpTasks.enrolmentId, enrolment.id))).for("update");
        if (!task) throw fail.notFound();
        if (task.state !== "OPEN" || task.leaseHolder && task.leaseHolder !== p.id && task.leaseExpiresAt && task.leaseExpiresAt > now()) throw fail.conflict("This task is closed or leased by another operator.");
      }
      const attemptId = randomUUID(); let promiseId: string | null = null; let followUpTaskId: string | null = null;
      let pointer: string | null = null; let warning: string | null = null;
      const makeTask = async (type: "COLLECTION_CALL" | "CALLBACK" | "ESCALATION" | "VERIFY_PAYMENT" | "ASSISTANCE" | "EXEMPTION_APPROVAL", dueAt: Date, extra: { category?: string; reason?: string; priority?: number } = {}) => {
        const dedupeKey = type === "COLLECTION_CALL" ? `${type}:${enrolment.id}:${businessDate(dueAt)}` : `${type}:${enrolment.id}:${attemptId}`;
        const task = await upsertTask(tx, { enrolmentId: enrolment.id, type, dueAt, dedupeKey, ownerId: p.id, createdBy: p.id, ...extra });
        followUpTaskId = task.id; return task;
      };
      if (!correction) {
        // The saved outcome completes outstanding collection work; new tasks describe the next action.
        await tx.update(followUpTasks).set({ state: "DONE", closedAt: now(), closedBy: p.id, closeReason: `Call outcome: ${input.outcome}`, updatedAt: now(), version: sql`${followUpTasks.version} + 1` }).where(and(eq(followUpTasks.enrolmentId, enrolment.id), eq(followUpTasks.state, "OPEN"), inArray(followUpTasks.type, ["COLLECTION_CALL", "CALLBACK"])));
      }
      switch (input.outcome) {
        case "NO_ANSWER": {
          const [resolvedEscalation] = await tx.select().from(followUpTasks).where(and(eq(followUpTasks.enrolmentId, enrolment.id), eq(followUpTasks.type, "ESCALATION"), eq(followUpTasks.state, "DONE"))).orderBy(desc(followUpTasks.closedAt)).limit(1);
          const sinceResolution = recent.filter(a => !resolvedEscalation?.closedAt || a.createdAt > resolvedEscalation.closedAt);
          const streak = sinceResolution.findIndex(a => a.outcome !== "NO_ANSWER");
          const count = (streak === -1 ? sinceResolution.length : streak) + 1;
          if (count >= 3) await makeTask("ESCALATION", await nextContactAt(tx), { reason: "Three consecutive no-answer outcomes; automatic retries paused.", priority: 1 });
          else await makeTask("COLLECTION_CALL", colomboInstant(await nextBusinessDay(tx, businessDate()), 9), { reason: "Next business day retry after no answer." });
          break;
        }
        case "ANSWERED":
          if (!input.resolved) {
            if (input.nextDate! < businessDate()) throw fail.validation("Next action date cannot be in the past.");
            await makeTask("CALLBACK", await nextContactAt(tx, colomboInstant(input.nextDate!, 9)), { reason: input.nextAction });
          }
          break;
        case "PROMISED_TO_PAY": {
          if (input.promisedDate! < businessDate()) throw fail.validation("Promise date cannot be in the past.");
          const targetIds = [...new Set(input.targetInstalmentIds!)];
          const targets = ledger.instalments.filter(i => targetIds.includes(i.id));
          if (targets.length !== targetIds.length) throw fail.notFound();
          if (targets.some(i => i.remainingMinor <= 0)) throw fail.validation("Promise targets must have remaining debt.");
          const currentDue = targets.filter(i => i.dueDate <= businessDate()).reduce((s, i) => s + i.remainingMinor, 0);
          if (input.amountMinor! > currentDue) warning = "Promised amount exceeds the current due amount for these targets.";
          promiseId = randomUUID();
          await recomputePromises(tx, enrolment.id);
          await tx.update(paymentPromises).set({ state: "SUPERSEDED", supersededById: promiseId, stateReason: "Replaced by a new payment promise.", updatedAt: now(), version: sql`${paymentPromises.version} + 1` }).where(and(eq(paymentPromises.enrolmentId, enrolment.id), inArray(paymentPromises.state, ["OPEN", "PARTIALLY_FULFILLED", "BROKEN"])));
          await tx.insert(paymentPromises).values({ id: promiseId, enrolmentId: enrolment.id, amountMinor: input.amountMinor!, promisedDate: input.promisedDate!, targetInstalmentIds: targetIds, baselineAllocatedMinor: targets.reduce((s, i) => s + i.allocatedMinor, 0), notes: input.notes, staffId: p.id, callAttemptId: attemptId, createdAt: now(), updatedAt: now() });
          await makeTask("CALLBACK", colomboInstant(await nextBusinessDay(tx, input.promisedDate!), 9), { reason: "Check promised payment after its local due day." });
          break;
        }
        case "ALREADY_PAID": await makeTask("VERIFY_PAYMENT", now(), { reason: "Student reports payment. Check submissions or request evidence; no balance change." }); break;
        case "NEEDS_ASSISTANCE":
          if (input.dueDate! < businessDate()) throw fail.validation("Assistance due date cannot be in the past.");
          await makeTask("ASSISTANCE", colomboInstant(input.dueDate!, 17), { category: input.category, reason: input.reason, priority: input.priority }); break;
        case "NOT_CONTINUING": pointer = `/staff/enrolments/${enrolment.id}/withdrawal`; break;
        case "FREE_CARD_SPONSORED":
          if (can(actor, "exemptions.manage")) pointer = `/staff/enrolments/${enrolment.id}/exemptions`;
          else await makeTask("EXEMPTION_APPROVAL", now(), { reason: input.notes || "Free card or sponsorship approval requested." });
          break;
        case "WRONG_NUMBER":
          if (student.version !== input.expectedStudentVersion) throw fail.stale("The student contact changed. Refresh the card.");
          await tx.update(students).set({ wrongNumber: true, version: student.version + 1, updatedAt: now() }).where(eq(students.id, student.id));
          await audit(tx, { actorType: "STAFF", actorId: p.id, action: "STUDENT_WRONG_NUMBER", entityType: "student", entityId: student.id, before: { wrongNumber: student.wrongNumber }, after: { wrongNumber: true }, intakeId: ctx.intakeId, programmeId: ctx.programmeId });
          break;
      }
      const snapshot = Object.fromEntries(Object.entries(ledger.summary).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
      const [attempt] = await tx.insert(callAttempts).values({ id: attemptId, clientAttemptId: input.clientAttemptId, enrolmentId: enrolment.id, operatorId: p.id, outcome: input.outcome, notes: input.notes, balanceSnapshot: snapshot, taskId: input.taskId, promiseId, followUpTaskId, correctsAttemptId: input.correctsAttemptId, manualOverrideReason: input.manualOverrideReason, createdAt: now() }).returning();
      await tx.update(enrolments).set({ version: enrolment.version + 1, updatedAt: now() }).where(eq(enrolments.id, enrolment.id));
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "CALL_ATTEMPT_RECORDED", entityType: "call_attempt", entityId: attempt.id, intakeId: ctx.intakeId, programmeId: ctx.programmeId, after: { outcome: input.outcome, promiseId, followUpTaskId, correctsAttemptId: input.correctsAttemptId }, reason: input.manualOverrideReason });
      const submissions = input.outcome === "ALREADY_PAID" ? await tx.select({ id: paymentSubmissions.id, status: paymentSubmissions.status, claimedMinor: paymentSubmissions.claimedMinor, submittedAt: paymentSubmissions.submittedAt }).from(paymentSubmissions).where(eq(paymentSubmissions.enrolmentId, enrolment.id)).orderBy(desc(paymentSubmissions.submittedAt)).limit(20) : [];
      return { attempt, pointer, warning, submissions, version: enrolment.version + 1 };
    }));
  });
}
