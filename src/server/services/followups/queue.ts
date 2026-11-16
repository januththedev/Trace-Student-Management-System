import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx, type DbOrTx } from "@/db/client";
import { callAttempts, enrolments, followUpTasks, intakes, paymentPromises, paymentSubmissions, programmes, students } from "@/db/schema";
import { businessDate, now } from "@/lib/time";
import { enrolmentInScope, intakeScopeWhere, type StaffPrincipal } from "@/server/auth/policy";
import { fail } from "@/server/http";
import { loadLedgers, type EnrolmentLedger } from "@/server/services/ledger";
import { inContactWindow } from "./calendar";
import { freshPrincipal } from "./shared";

export const queueSchema = z.object({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
export function collectibleInstalments(ledger: EnrolmentLedger) {
  return ledger.instalments.filter(i => i.remainingMinor > 0 && i.dueDate <= businessDate() && !i.hasPendingEvidence);
}
const selection = { id: enrolments.id, version: enrolments.version, status: enrolments.status, studentId: students.id, studentVersion: students.version, studentStatus: students.status, name: students.fullName, phone: students.phone, doNotCall: students.doNotCall, wrongNumber: students.wrongNumber, intake: intakes.label, programme: programmes.name, intakeTrashedAt: intakes.trashedAt, programmeTrashedAt: programmes.trashedAt };
type QueueRow = { id: string; version: number; status: string; studentId: string; studentVersion: number; studentStatus: string; name: string; phone: string | null; doNotCall: boolean; wrongNumber: boolean; intake: string; programme: string; intakeTrashedAt: Date | null; programmeTrashedAt: Date | null };

async function hydrate(tx: DbOrTx, rows: QueueRow[], ledgers: Map<string, EnrolmentLedger>) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const history = await tx.select().from(callAttempts).where(and(inArray(callAttempts.enrolmentId, ids), sql`${callAttempts.id} in (select id from (select id, row_number() over (partition by enrolment_id order by created_at desc, id desc) as rn from call_attempts where enrolment_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})) ranked where rn <= 15)`)).orderBy(desc(callAttempts.createdAt), desc(callAttempts.id));
  const promises = await tx.select().from(paymentPromises).where(and(inArray(paymentPromises.enrolmentId, ids), sql`${paymentPromises.id} in (select distinct on (enrolment_id) id from payment_promises where enrolment_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}) order by enrolment_id, created_at desc, id desc)`));
  const tasks = await tx.select().from(followUpTasks).where(and(inArray(followUpTasks.enrolmentId, ids), eq(followUpTasks.state, "OPEN"))).orderBy(asc(followUpTasks.dueAt));
  const submissions = await tx.select({ id: paymentSubmissions.id, enrolmentId: paymentSubmissions.enrolmentId, targetInstalmentId: paymentSubmissions.targetInstalmentId, status: paymentSubmissions.status, claimedMinor: paymentSubmissions.claimedMinor, submittedAt: paymentSubmissions.submittedAt }).from(paymentSubmissions).where(and(inArray(paymentSubmissions.enrolmentId, ids), sql`${paymentSubmissions.id} in (select id from (select id, row_number() over (partition by enrolment_id order by submitted_at desc, id desc) rn from payment_submissions where enrolment_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})) ranked where rn <= 20)`)).orderBy(desc(paymentSubmissions.submittedAt));
  const windowOpen = await inContactWindow(tx);
  return rows.map(row => {
    const ledger = ledgers.get(row.id)!;
    const dueInstalments = collectibleInstalments(ledger);
    const openTasks = tasks.filter(t => t.enrolmentId === row.id);
    const contactHistory = history.filter(h => h.enrolmentId === row.id);
    const todayAttempt = contactHistory.find(h => h.outcome !== "CORRECTION" && businessDate(h.createdAt) === businessDate());
    const latestPromise = promises.find(p => p.enrolmentId === row.id) ?? null;
    const escalation = openTasks.some(t => t.type === "ESCALATION");
    const nextAction = openTasks.find(t => !t.paused) ?? null;
    const flags = [row.doNotCall ? "Do not call" : null, row.wrongNumber ? "Wrong number" : null, !row.phone ? "Missing phone" : null].filter((s): s is string => !!s);
    const eligible = row.status === "ACTIVE" && row.studentStatus === "ACTIVE" && !row.intakeTrashedAt && !row.programmeTrashedAt && dueInstalments.length > 0;
    const deferred = !!todayAttempt || escalation || openTasks.some(t => ["COLLECTION_CALL", "CALLBACK"].includes(t.type) && (t.paused || t.dueAt > now())) || !!latestPromise && ["OPEN", "PARTIALLY_FULFILLED"].includes(latestPromise.state) && latestPromise.promisedDate >= businessDate();
    return { ...row, eligible, callable: eligible && !flags.length && windowOpen && !deferred, windowOpen, flags, deferred, ledger, dueInstalments, pendingEvidence: ledger.instalments.filter(i => i.hasPendingEvidence), contactHistory, latestPromise, openTasks, nextAction, submissions: submissions.filter(s => s.enrolmentId === row.id) };
  });
}
export type CallCard = Awaited<ReturnType<typeof hydrate>>[number];

/** Bounded keyset scan: cursor tracks examined rows even when many are held or settled. */
export async function loadQueueBatch(tx: DbOrTx, p: StaffPrincipal | null, raw: unknown = {}) {
  const input = queueSchema.parse(raw);
  const rows = await tx.select(selection).from(enrolments).innerJoin(students, eq(students.id, enrolments.studentId)).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(and(eq(enrolments.status, "ACTIVE"), eq(students.status, "ACTIVE"), isNull(intakes.trashedAt), isNull(programmes.trashedAt), p ? intakeScopeWhere(p, enrolments.intakeId, intakes.programmeId) : sql`true`, input.cursor ? gt(enrolments.id, input.cursor) : undefined,
    sql`exists (select 1 from instalments i where i.enrolment_id = ${enrolments.id} and i.due_date <= ${businessDate()}::date)`)).orderBy(asc(enrolments.id)).limit(input.limit);
  const ledgers = await loadLedgers(tx, rows.map(r => r.id));
  const items = (await hydrate(tx, rows, ledgers)).filter(c => c.eligible);
  return { items, nextCursor: rows.length === input.limit ? rows.at(-1)!.id : null, refreshedAt: now().toISOString() };
}
export async function getCallQueue(p: StaffPrincipal, raw: unknown = {}) {
  return withTx(async tx => loadQueueBatch(tx, await freshPrincipal(tx, p), raw));
}
export async function getCallCard(p: StaffPrincipal, id: string) {
  z.uuid().parse(id);
  return withTx(async tx => {
    const actor = await freshPrincipal(tx, p); await enrolmentInScope(tx, actor, id);
    const rows = await tx.select(selection).from(enrolments).innerJoin(students, eq(students.id, enrolments.studentId)).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId)).where(eq(enrolments.id, id));
    if (!rows.length) throw fail.notFound();
    return (await hydrate(tx, rows, await loadLedgers(tx, [id])))[0];
  });
}
