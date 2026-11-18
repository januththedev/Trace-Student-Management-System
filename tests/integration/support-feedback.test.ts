import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, notifications, staffAccounts } from "@/db/schema";
import { supportFeedback, supportReplies } from "@/db/support-schema";
import { listFeedback, submitFeedback, updateFeedback } from "@/server/services/support/feedback";
import { closeDb, makeStaff, principalOf, resetDb } from "./helpers";

const body = { category: "IMPROVEMENT" as const, area: "GENERAL" as const, title: "Simpler daily tasks", message: "Please make the daily review steps easier to find." };
beforeEach(resetDb);
afterAll(closeDb);
async function staff() { return principalOf(await makeStaff("ADMIN")); }
async function owner() { return principalOf(await makeStaff("SUPER_ADMIN")); }

describe("staff support feedback", () => {
  it("persists feedback idempotently without storing message text in audit or replay data", async () => {
    const p = await staff();
    const first = await submitFeedback(p, body, "feedback-retry-key");
    expect(await submitFeedback(p, body, "feedback-retry-key")).toEqual(first);
    expect(await db().select().from(supportFeedback)).toHaveLength(1);
    const events = await db().select().from(auditEvents).where(eq(auditEvents.entityId, first.id));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(body.message);
    await expect(submitFeedback(p, { ...body, title: "Different suggestion" }, "feedback-retry-key")).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });
  it("lets admins see only their own feedback and restricts the team inbox to current Super Admins", async () => {
    const a = await staff(), b = await staff(), s = await owner();
    const one = await submitFeedback(a, body, "feedback-owner-a");
    const two = await submitFeedback(b, { ...body, title: "Another suggestion" }, "feedback-owner-b");
    expect((await listFeedback(a)).items.map(t => t.id)).toEqual([one.id]);
    expect((await listFeedback(b)).items.map(t => t.id)).toEqual([two.id]);
    await expect(listFeedback(a, { view: "all" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listFeedback(s, { view: "all" })).items).toHaveLength(2);
    await db().update(staffAccounts).set({ role: "ADMIN" }).where(eq(staffAccounts.id, s.id));
    await expect(listFeedback(s, { view: "all" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects deactivated and stale principals, including replay attempts", async () => {
    const p = await staff();
    await submitFeedback(p, body, "revoked-feedback-key");
    await db().update(staffAccounts).set({ authVersion: p.authVersion + 1 }).where(eq(staffAccounts.id, p.id));
    await expect(submitFeedback(p, body, "revoked-feedback-key")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(listFeedback(p)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await db().update(staffAccounts).set({ authVersion: p.authVersion, status: "DEACTIVATED" }).where(eq(staffAccounts.id, p.id));
    await expect(listFeedback(p)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("saves a versioned response once, retains replies and notifies only the author", async () => {
    const p = await staff(), s = await owner();
    const ticket = await submitFeedback(p, body, "reply-ticket-key");
    const reply = { expectedVersion: 1, status: "IN_REVIEW" as const, reply: "We are reviewing the daily task labels." };
    await expect(updateFeedback(p, ticket.id, reply, "forbidden-reply-key")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const first = await updateFeedback(s, ticket.id, reply, "support-reply-key");
    expect(await updateFeedback(s, ticket.id, reply, "support-reply-key")).toEqual(first);
    await expect(updateFeedback(s, ticket.id, reply, "stale-reply-key")).rejects.toMatchObject({ code: "STALE" });
    expect(await db().select().from(supportReplies)).toHaveLength(1);
    const notes = await db().select().from(notifications);
    expect(notes).toHaveLength(1); expect(notes[0].recipientId).toBe(p.id);
    await updateFeedback(s, ticket.id, { expectedVersion: 2, status: "PLANNED", reply: "This change is planned." }, "second-support-reply");
    const result = (await listFeedback(p)).items[0];
    expect(result.status).toBe("PLANNED"); expect(result.version).toBe(3); expect(result.replies).toHaveLength(2);
    const history = await db().select().from(auditEvents).where(eq(auditEvents.entityId, ticket.id));
    expect(JSON.stringify(history)).not.toContain(reply.reply);
  });
  it("validates content, update versions, statuses and cursors", async () => {
    const p = await staff(), s = await owner();
    await expect(submitFeedback(p, { ...body, title: "x" }, "bad-title-key")).rejects.toThrow();
    await expect(submitFeedback(p, { ...body, message: "x" }, "bad-message-key")).rejects.toThrow();
    await expect(listFeedback(p, { cursor: "broken" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateFeedback(s, "00000000-0000-4000-8000-000000000001", { expectedVersion: 1, status: "OPEN" }, "missing-ticket-key")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db().select().from(supportFeedback)).toHaveLength(0);
  });
  it("paginates equal timestamps without skipping or duplicating tickets", async () => {
    const p = await staff();
    // PostgreSQL normally retains microseconds that JavaScript dates cannot round-trip.
    // The support schema rounds to milliseconds, preserving exact cursor boundaries.
    await db().insert(supportFeedback).values(Array.from({ length: 55 }, (_, i) => ({ authorId: p.id, ...body, title: `Suggestion ${i}`, createdAt: sql`'2026-11-01T00:00:00.123456Z'::timestamptz` })));
    const a = await listFeedback(p); expect(a.items).toHaveLength(50); expect(a.nextCursor).toBeTruthy();
    const b = await listFeedback(p, { cursor: a.nextCursor! }); expect(b.items).toHaveLength(5); expect(b.nextCursor).toBeNull();
    expect(new Set([...a.items, ...b.items].map(t => t.id)).size).toBe(55);
    const count = await db().execute<{ count: number }>(sql`select count(*)::int as count from support_feedback`);
    expect(count[0].count).toBe(55);
  });
});
