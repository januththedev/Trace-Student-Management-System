import "server-only";
import { and, eq, notInArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { followUpTasks, paymentPromises } from "@/db/schema";
import { businessDate, now } from "@/lib/time";
import { audit } from "@/server/audit";
import { loadLedger } from "@/server/services/ledger";
import { reconcileCollectionTasks } from "./tasks";

/** Called in the financial mutation transaction after approval, reversal, waiver or withdrawal. */
export async function recomputePromises(tx: DbOrTx, enrolmentId: string) {
  // Use the same instalment-before-promise lock order as call saves and financial services.
  const ledger = await loadLedger(tx, enrolmentId, { lock: true });
  const promises = await tx.select().from(paymentPromises).where(and(eq(paymentPromises.enrolmentId, enrolmentId), notInArray(paymentPromises.state, ["SUPERSEDED", "CANCELLED"]))).for("update");
  for (const promise of promises) {
    const targets = ledger.instalments.filter(i => promise.targetInstalmentIds.includes(i.id));
    const allocated = targets.reduce((s, i) => s + i.allocatedMinor, 0);
    const fulfilledMinor = Math.min(promise.amountMinor, Math.max(0, allocated - promise.baselineAllocatedMinor));
    const waived = targets.length > 0 && targets.every(i => i.remainingMinor === 0) && targets.some(i => i.exemptionsMinor > 0 || i.adjustmentsMinor < 0);
    const state = fulfilledMinor >= promise.amountMinor ? "FULFILLED" : waived ? "CANCELLED" : businessDate() > promise.promisedDate ? "BROKEN" : fulfilledMinor > 0 ? "PARTIALLY_FULFILLED" : "OPEN";
    const stateReason = state === "CANCELLED" ? "Target debt eliminated by waiver or withdrawal; not cash fulfilment." : state === "BROKEN" ? "Unmet remainder after the promised Colombo day." : null;
    if (state === promise.state && fulfilledMinor === promise.fulfilledMinor) continue;
    await tx.update(paymentPromises).set({ state, stateReason, fulfilledMinor, updatedAt: now(), version: promise.version + 1 }).where(eq(paymentPromises.id, promise.id));
    if (state === "FULFILLED" || state === "CANCELLED") {
      await tx.update(followUpTasks).set({ state: state === "FULFILLED" ? "DONE" : "CANCELLED", closedAt: now(), closeReason: state === "FULFILLED" ? "Payment promise fulfilled by approved allocations." : stateReason, updatedAt: now(), version: sql`${followUpTasks.version} + 1` }).where(and(eq(followUpTasks.state, "OPEN"), sql`${followUpTasks.id} in (select follow_up_task_id from call_attempts where promise_id = ${promise.id}::uuid)`));
    }
    await audit(tx, { actorType: "SYSTEM", action: "PROMISE_RECOMPUTED", entityType: "payment_promise", entityId: promise.id, before: { state: promise.state, fulfilledMinor: promise.fulfilledMinor }, after: { state, fulfilledMinor }, reason: stateReason });
  }
  await reconcileCollectionTasks(tx, [enrolmentId], new Map([[enrolmentId, ledger]]));
}
