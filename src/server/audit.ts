import "server-only";
import type { DbOrTx } from "@/db/client";
import { auditEvents, notifications, outboxEvents } from "@/db/schema";

const SENSITIVE = /nic|password|token|secret|hash/i;

/** Redact sensitive keys before persisting change details. */
export function redact(o: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!o) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (SENSITIVE.test(k) && !/masked/i.test(k)) out[k] = "[redacted]";
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === "object" && !(x instanceof Date) ? redact(x as Record<string, unknown>) : x));
    else if (v && typeof v === "object") out[k] = redact(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

export interface AuditInput {
  actorType: "STAFF" | "STUDENT" | "SYSTEM";
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  programmeId?: string | null;
  intakeId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  requestId?: string | null;
}

/** Append-only audit record; call inside the same transaction as the business change. */
export async function audit(tx: DbOrTx, a: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    actorType: a.actorType, actorId: a.actorId ?? null, action: a.action, entityType: a.entityType,
    entityId: a.entityId ?? null, programmeId: a.programmeId ?? null, intakeId: a.intakeId ?? null,
    before: redact(a.before), after: redact(a.after), reason: a.reason ?? null, requestId: a.requestId ?? null,
  });
}

/** In-portal notification + outbox event, written in the business transaction. Idempotent by dedupeKey. */
export async function notify(tx: DbOrTx, n: {
  recipientType: "STAFF" | "STUDENT"; recipientId: string; event: string; title: string; body: string; dedupeKey: string;
}): Promise<void> {
  await tx.insert(notifications).values(n).onConflictDoNothing({ target: notifications.dedupeKey });
  await tx.insert(outboxEvents).values({
    channel: "portal", event: n.event, dedupeKey: `outbox:${n.dedupeKey}`,
    payload: { recipientType: n.recipientType, recipientId: n.recipientId, title: n.title },
  }).onConflictDoNothing({ target: outboxEvents.dedupeKey });
}
