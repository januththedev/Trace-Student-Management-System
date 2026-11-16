import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx, type DbOrTx } from "@/db/client";
import { enrolments, followUpTasks, intakes, programmes, students } from "@/db/schema";
import { now } from "@/lib/time";
import { assertOperational, enrolmentInScope, type StaffPrincipal } from "@/server/auth/policy";
import { audit } from "@/server/audit";
import { fail } from "@/server/http";
import { freshPrincipal, reasonSchema, replay, versionSchema } from "./shared";
import { loadLedgers, type EnrolmentLedger } from "@/server/services/ledger";
import { collectibleInstalments } from "./queue";

/** Settle obsolete automatic work after payments/holds/withdrawals, preserving task history. */
export async function reconcileCollectionTasks(tx: DbOrTx, ids: string[], ledgers?: Map<string, EnrolmentLedger>) {
  if (!ids.length) return;
  const rows = await tx.select({ id: enrolments.id, status: enrolments.status, studentStatus: students.status, doNotCall: students.doNotCall, wrongNumber: students.wrongNumber, intakeTrashed: intakes.trashedAt, programmeTrashed: programmes.trashedAt }).from(enrolments).innerJoin(students, eq(students.id, enrolments.studentId)).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(inArray(enrolments.id, ids));
  const balances = ledgers ?? await loadLedgers(tx, ids);
  for (const row of rows) {
    const ledger = balances.get(row.id)!;
    const suspended = row.status !== "ACTIVE" || row.studentStatus !== "ACTIVE" || row.doNotCall || row.wrongNumber || row.intakeTrashed || row.programmeTrashed;
    const types: ("COLLECTION_CALL" | "CALLBACK")[] = suspended || ledger.summary.outstandingMinor === 0 ? ["COLLECTION_CALL", "CALLBACK"] : !collectibleInstalments(ledger).length ? ["COLLECTION_CALL"] : [];
    if (!types.length) continue;
    const reason = suspended ? "Automatic contact suspended by status, Trash or contact flag." : ledger.summary.outstandingMinor === 0 ? "Target debt settled or eliminated; no collection required." : "No collectible due instalments; pending evidence remains held.";
    const cancelled = await tx.update(followUpTasks).set({ state: "CANCELLED", closedAt: now(), closeReason: reason, leaseHolder: null, leaseExpiresAt: null, updatedAt: now(), version: sql`${followUpTasks.version} + 1` }).where(and(eq(followUpTasks.enrolmentId, row.id), eq(followUpTasks.state, "OPEN"), inArray(followUpTasks.type, types))).returning({ id: followUpTasks.id });
    for (const task of cancelled) await audit(tx, { actorType: "SYSTEM", action: "FOLLOWUP_TASK_CANCELLED", entityType: "follow_up_task", entityId: task.id, reason });
  }
}

const taskSchema = z.object({ enrolmentId: z.uuid(), type: z.enum(["COLLECTION_CALL", "CALLBACK", "ESCALATION", "VERIFY_PAYMENT", "ASSISTANCE", "STALE_REVIEW", "EXEMPTION_APPROVAL"]), dedupeKey: z.string().min(1).max(300), dueAt: z.date(), ownerId: z.uuid().nullable().optional(), category: z.string().max(100).optional(), reason: reasonSchema.optional(), priority: z.number().int().min(1).max(3).optional(), createdBy: z.uuid().optional(), paused: z.boolean().optional() });
export async function upsertTask(tx: DbOrTx, raw: z.input<typeof taskSchema>) {
  const input = taskSchema.parse(raw);
  const [created] = await tx.insert(followUpTasks).values({ ...input, createdAt: now(), updatedAt: now() }).onConflictDoNothing({ target: followUpTasks.dedupeKey }).returning();
  if (created) await audit(tx, { actorType: input.createdBy ? "STAFF" : "SYSTEM", actorId: input.createdBy, action: "FOLLOWUP_TASK_CREATED", entityType: "follow_up_task", entityId: created.id, after: { type: created.type, enrolmentId: created.enrolmentId } });
  return created ?? (await tx.select().from(followUpTasks).where(eq(followUpTasks.dedupeKey, input.dedupeKey)))[0];
}
export const closeTaskSchema = z.object({ expectedVersion: versionSchema, reason: reasonSchema });
export const leaseTaskSchema = z.object({ expectedVersion: versionSchema });
export async function closeTask(p: StaffPrincipal, id: string, raw: unknown, key: string) {
  return mutateTask(p, id, closeTaskSchema.parse(raw), key, true);
}
export async function leaseTask(p: StaffPrincipal, id: string, raw: unknown, key: string) {
  return mutateTask(p, id, leaseTaskSchema.parse(raw), key, false);
}
async function mutateTask(p: StaffPrincipal, id: string, input: { expectedVersion: number; reason?: string }, key: string, close: boolean) {
  z.uuid().parse(id);
  return withTx(async tx => {
    const actor = await freshPrincipal(tx, p);
    const [task] = await tx.select().from(followUpTasks).where(eq(followUpTasks.id, id)).for("update");
    if (!task) throw fail.notFound();
    const ctx = await enrolmentInScope(tx, actor, task.enrolmentId); assertOperational(ctx);
    return replay(tx, `task:${p.id}:${id}`, key, { input, close }, async () => {
      if (task.version !== input.expectedVersion) throw fail.stale("This task changed. Refresh and try again.");
      if (task.state !== "OPEN") throw fail.conflict("This task is already closed.");
      if (task.leaseHolder && task.leaseHolder !== p.id && task.leaseExpiresAt && task.leaseExpiresAt > now()) throw fail.conflict("Another staff member is working on this task.");
      const [updated] = await tx.update(followUpTasks).set(close ? { state: "DONE", closedAt: now(), closedBy: p.id, closeReason: input.reason, leaseHolder: null, leaseExpiresAt: null, version: task.version + 1, updatedAt: now() } : { ownerId: p.id, leaseHolder: p.id, leaseExpiresAt: new Date(now().getTime() + 5 * 60_000), version: task.version + 1, updatedAt: now() }).where(and(eq(followUpTasks.id, id), eq(followUpTasks.version, task.version))).returning();
      // Closing an escalation explicitly resumes scheduling. Historic attempts remain intact.
      if (close && task.type === "ESCALATION") await tx.update(followUpTasks).set({ paused: false, version: sql`${followUpTasks.version} + 1` }).where(and(eq(followUpTasks.enrolmentId, task.enrolmentId), eq(followUpTasks.state, "OPEN"), eq(followUpTasks.paused, true)));
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: close ? "FOLLOWUP_TASK_CLOSED" : "FOLLOWUP_TASK_LEASED", entityType: "follow_up_task", entityId: id, intakeId: ctx.intakeId, programmeId: ctx.programmeId, reason: input.reason });
      return updated;
    });
  });
}
