import "server-only";
import type { Tx } from "@/db/client";
import { recomputePromises } from "./followups/promises";

/**
 * Called inside every financial transaction after allocations/exemptions/withdrawals change,
 * so dependent projections (promise fulfilment, follow-up eligibility) are recomputed atomically.
 */
export async function afterLedgerChange(tx: Tx, enrolmentId: string): Promise<void> {
  await recomputePromises(tx, enrolmentId);
}
