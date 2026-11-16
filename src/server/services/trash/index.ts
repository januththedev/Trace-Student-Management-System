import "server-only";
import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { withTx } from "@/db/client";
import { enrolments, intakes, programmes, staffAccounts, studentSessions } from "@/db/schema";
import { now } from "@/lib/time";
import { audit } from "@/server/audit";
import type { StaffPrincipal } from "@/server/auth/policy";
import { revokeAllStaffSessions } from "@/server/auth/staff";
import { fail } from "@/server/http";
import { invalidateInvitations } from "../governance";
import { assertSuperAdminInvariant, freshSuper, lockGovernance } from "../governance/invariant";
import { once } from "../governance/idempotency";

export const RETENTION_MS = 30 * 86400000;
export const trashSchema = z.object({
  kind: z.enum(["programme", "intake", "staff"]), id: z.uuid(), version: z.number().int().positive(),
  action: z.enum(["trash", "restore", "restore-as-admin"]), reason: z.string().trim().min(1).max(1000),
});
export type TrashKind = z.output<typeof trashSchema>["kind"];
export const trashTables = { programme: programmes, intake: intakes, staff: staffAccounts } as const;

export async function mutateTrash(actor: StaffPrincipal, input: z.input<typeof trashSchema>, key: string) {
  const v = trashSchema.parse(input);
  if (v.action === "restore-as-admin" && v.kind !== "staff") throw fail.validation("Restore as Admin applies only to staff.");
  return withTx(async tx => {
    // Global lock precedes every staff lock, including authorizer reads.
    await lockGovernance(tx);
    await freshSuper(tx, actor);
    return once(tx, `trash:${actor.id}`, key, v, async () => {
      const table = trashTables[v.kind];
      const [row] = await tx.select().from(table).where(eq(table.id, v.id)).for("update");
      if (!row) throw fail.notFound();
      if (row.version !== v.version) throw fail.stale("This record changed. Refresh and try again.");
      const t = now();
      const isTrash = v.action === "trash";
      if (isTrash && row.trashedAt) throw fail.conflict("This record is already in Trash.");
      if (!isTrash && (!row.trashedAt || !row.purgeAfter || row.purgeAfter <= t || row.purgeStatus === "PURGED")) throw fail.conflict("The restore deadline has passed or this record is not in Trash.");
      if (isTrash) {
        await tx.update(table).set({ trashedAt: t, trashedBy: actor.id, trashReason: v.reason, purgeAfter: new Date(t.getTime() + RETENTION_MS), purgeStatus: "PENDING", version: row.version + 1, updatedAt: t }).where(eq(table.id, v.id));
      } else {
        await tx.update(table).set({ trashedAt: null, trashedBy: null, trashReason: null, purgeAfter: null, purgeStatus: "NONE", version: row.version + 1, updatedAt: t }).where(eq(table.id, v.id));
      }
      if (v.kind === "staff") {
        const [a] = await tx.select().from(staffAccounts).where(eq(staffAccounts.id, v.id));
        await tx.update(staffAccounts).set({ status: isTrash ? "DEACTIVATED" : "ACTIVE", role: v.action === "restore-as-admin" ? "ADMIN" : a.role, authVersion: a.authVersion + 1 }).where(eq(staffAccounts.id, a.id));
        await revokeAllStaffSessions(tx, a.id);
        await invalidateInvitations(tx, a);
        await assertSuperAdminInvariant(tx);
      } else if (isTrash) {
        const ids = tx.select({ id: enrolments.id }).from(enrolments).innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
          .where(v.kind === "intake" ? eq(intakes.id, v.id) : eq(intakes.programmeId, v.id));
        await tx.update(studentSessions).set({ revokedAt: t, revokeReason: `${v.kind} trashed` }).where(and(inArray(studentSessions.enrolmentId, ids), isNull(studentSessions.revokedAt)));
      }
      await audit(tx, { actorType: "STAFF", actorId: actor.id, action: `${v.kind}.${v.action}`, entityType: v.kind, entityId: v.id,
        programmeId: v.kind === "programme" ? v.id : v.kind === "intake" && "programmeId" in row ? row.programmeId : null,
        intakeId: v.kind === "intake" ? v.id : null,
        before: { trashedAt: row.trashedAt, version: row.version }, after: { trashedAt: isTrash ? t : null, version: row.version + 1, ...(v.action === "restore-as-admin" ? { role: "ADMIN" } : {}) }, reason: v.reason });
      return { id: v.id, version: row.version + 1, action: v.action };
    });
  });
}

export async function listTrash(actor: StaffPrincipal) {
  return withTx(async tx => {
    await freshSuper(tx, actor);
    const t = now();
    const result = [];
    for (const kind of ["programme", "intake", "staff"] as const) {
      const table = trashTables[kind];
      const rows = await tx.select().from(table).where(isNotNull(table.trashedAt)).orderBy(table.purgeAfter);
      for (const r of rows) result.push({ kind, id: r.id, label: "name" in r ? r.name : r.label, version: r.version, reason: r.trashReason,
        role: "role" in r ? r.role : null, purgeAfter: r.purgeAfter?.toISOString() ?? null, purgeStatus: r.purgeStatus,
        remainingSeconds: Math.max(0, Math.ceil(((r.purgeAfter?.getTime() ?? 0) - t.getTime()) / 1000)),
        canRestore: !!r.purgeAfter && r.purgeAfter > t && r.purgeStatus !== "PURGED" });
    }
    const liveProgrammes = await tx.select({ id: programmes.id, label: programmes.name, version: programmes.version }).from(programmes).where(isNull(programmes.trashedAt));
    const liveIntakes = await tx.select({ id: intakes.id, label: intakes.label, version: intakes.version }).from(intakes).where(isNull(intakes.trashedAt));
    const jobs = await tx.query.jobRuns.findMany({ where: (j, { eq }) => eq(j.job, "retention.purge"), orderBy: (j, { desc }) => [desc(j.startedAt)], limit: 10 });
    return { serverNow: t.toISOString(), records: result, candidates: [...liveProgrammes.map(p => ({ ...p, kind: "programme" as const })), ...liveIntakes.map(i => ({ ...i, kind: "intake" as const }))], jobs: jobs.map(j => ({ id: j.id, status: j.status, processed: j.processed, error: j.error, startedAt: j.startedAt.toISOString() })) };
  });
}
