import "server-only";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import { withTx } from "@/db/client";
import { supportFeedback, supportReplies } from "@/db/support-schema";
import { staffAccounts } from "@/db/schema";
import { freshPrincipal } from "@/server/auth/fresh";
import { isSuper, requireSuper, type StaffPrincipal } from "@/server/auth/policy";
import { audit, notify } from "@/server/audit";
import { fail } from "@/server/http";
import { once } from "@/server/services/governance/idempotency";
import { now } from "@/lib/time";

export const feedbackSchema = z.object({
  category: z.enum(["BUG", "IMPROVEMENT", "QUESTION"]),
  area: z.enum(["GENERAL", "STUDENTS", "ADMISSIONS", "PROGRAMMES", "RECEIPTS", "CALLS", "REPORTS", "IMPORTS", "TEAM", "TRASH", "STORAGE", "SUPPORT"]),
  title: z.string().trim().min(5).max(120),
  message: z.string().trim().min(10).max(3000),
});
export const updateFeedbackSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(["OPEN", "IN_REVIEW", "PLANNED", "RESOLVED", "CLOSED"]),
  reply: z.string().trim().min(1).max(2000).optional(),
});
export const feedbackListSchema = z.object({
  view: z.enum(["mine", "all"]).default("mine"),
  cursor: z.string().max(200).optional(),
  status: z.enum(["OPEN", "IN_REVIEW", "PLANNED", "RESOLVED", "CLOSED"]).optional(),
});

export async function submitFeedback(p0: StaffPrincipal, input: z.input<typeof feedbackSchema>, key: string, requestId?: string) {
  const value = feedbackSchema.parse(input);
  return withTx(async tx => {
    const p = await freshPrincipal(tx, p0);
    return once(tx, `support-submit:${p.id}`, key, value, async () => {
      const [ticket] = await tx.insert(supportFeedback).values({ ...value, authorId: p.id }).returning();
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "support.feedback.created", entityType: "support_feedback", entityId: ticket.id,
        after: { category: value.category, area: value.area, status: ticket.status }, requestId });
      return { id: ticket.id, status: ticket.status, version: ticket.version };
    });
  });
}

export async function listFeedback(p0: StaffPrincipal, input: z.input<typeof feedbackListSchema> = {}) {
  const value = feedbackListSchema.parse(input);
  let cursor: { createdAt: string; id: string } | undefined;
  if (value.cursor) {
    try { cursor = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).parse(JSON.parse(Buffer.from(value.cursor, "base64url").toString("utf8"))); }
    catch { throw fail.validation("This feedback page link is invalid. Refresh the list."); }
  }
  return withTx(async tx => {
    const p = await freshPrincipal(tx, p0);
    if (value.view === "all") requireSuper(p);
    const conditions = [value.view === "mine" ? eq(supportFeedback.authorId, p.id) : undefined,
      value.status ? eq(supportFeedback.status, value.status) : undefined,
      cursor ? or(lt(supportFeedback.createdAt, new Date(cursor.createdAt)), and(eq(supportFeedback.createdAt, new Date(cursor.createdAt)), lt(supportFeedback.id, cursor.id))) : undefined];
    const rows = await tx.select({ ticket: supportFeedback, authorName: staffAccounts.name }).from(supportFeedback)
      .innerJoin(staffAccounts, eq(staffAccounts.id, supportFeedback.authorId))
      .where(and(...conditions)).orderBy(desc(supportFeedback.createdAt), desc(supportFeedback.id)).limit(51);
    const visible = rows.slice(0, 50);
    const replies = visible.length ? await tx.select({ reply: supportReplies, authorName: staffAccounts.name }).from(supportReplies)
      .innerJoin(staffAccounts, eq(staffAccounts.id, supportReplies.authorId))
      .where(inArray(supportReplies.feedbackId, visible.map(r => r.ticket.id))).orderBy(supportReplies.createdAt) : [];
    return { items: visible.map(({ ticket, authorName }) => ({ ...ticket, authorName, createdAt: ticket.createdAt.toISOString(), updatedAt: ticket.updatedAt.toISOString(),
      replies: replies.filter(r => r.reply.feedbackId === ticket.id).map(r => ({ ...r.reply, createdAt: r.reply.createdAt.toISOString(), authorName: r.authorName })) })),
      nextCursor: rows.length > 50 ? Buffer.from(JSON.stringify({ createdAt: visible.at(-1)!.ticket.createdAt.toISOString(), id: visible.at(-1)!.ticket.id })).toString("base64url") : null, canManage: isSuper(p) };
  });
}

export async function updateFeedback(p0: StaffPrincipal, id: string, input: z.input<typeof updateFeedbackSchema>, key: string, requestId?: string) {
  z.string().uuid().parse(id);
  const value = updateFeedbackSchema.parse(input);
  return withTx(async tx => {
    const p = await freshPrincipal(tx, p0);
    requireSuper(p);
    const [ticket] = await tx.select().from(supportFeedback).where(eq(supportFeedback.id, id)).for("update");
    if (!ticket) throw fail.notFound();
    return once(tx, `support-update:${p.id}:${id}`, key, value, async () => {
      if (ticket.version !== value.expectedVersion) throw fail.stale("This feedback changed. Refresh it before replying.");
      await tx.update(supportFeedback).set({ status: value.status, version: ticket.version + 1, updatedAt: now() }).where(eq(supportFeedback.id, id));
      if (value.reply) await tx.insert(supportReplies).values({ feedbackId: id, authorId: p.id, message: value.reply });
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: "support.feedback.updated", entityType: "support_feedback", entityId: id,
        before: { status: ticket.status, version: ticket.version }, after: { status: value.status, version: ticket.version + 1, replied: Boolean(value.reply) }, requestId });
      await notify(tx, { recipientType: "STAFF", recipientId: ticket.authorId, event: "support.feedback.updated", title: "Your feedback has an update",
        body: "Open Help & support to read the response.", dedupeKey: `support:${id}:${ticket.version + 1}` });
      return { id, status: value.status, version: ticket.version + 1 };
    });
  });
}
