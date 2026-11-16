import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { chargeAdjustments, paymentAllocations, paymentEvents } from "@/db/schema";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStudent, pinNow, resetDb, unpinNow } from "./helpers";

const AS_OF = "2026-06-15";

function runReconciliation() {
  return spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/reconcile.ts"], {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    timeout: 90_000,
  });
}

async function fixtures() {
  const liveProgramme = await makeProgramme();
  const liveIntake = await makeIntake(liveProgramme.id);
  const active = await makeEnrolment((await makeStudent()).id, liveIntake.id, [
    { amountMinor: 100_000, dueDate: "2026-06-01" },
  ]);
  const withdrawn = await makeEnrolment((await makeStudent()).id, liveIntake.id, [
    { amountMinor: 200_000, dueDate: "2026-06-01" },
  ], { status: "WITHDRAWN", withdrawnAt: new Date(`${AS_OF}T12:00:00Z`), withdrawalEffectiveDate: AS_OF, withdrawalReason: "Synthetic reconciliation fixture" });

  const trashedIntake = await makeIntake(liveProgramme.id, { trashedAt: new Date(`${AS_OF}T12:00:00Z`) });
  const underTrashedIntake = await makeEnrolment((await makeStudent()).id, trashedIntake.id, [
    { amountMinor: 300_000, dueDate: "2026-06-01" },
  ]);
  const trashedProgramme = await makeProgramme({ trashedAt: new Date(`${AS_OF}T12:00:00Z`) });
  const trashedProgrammeIntake = await makeIntake(trashedProgramme.id);
  const underTrashedProgramme = await makeEnrolment((await makeStudent()).id, trashedProgrammeIntake.id, [
    { amountMinor: 400_000, dueDate: "2026-06-01" },
  ]);

  const [activeReceipt] = await db().insert(paymentEvents).values({ enrolmentId: active.enrolment.id, kind: "RECEIPT", amountMinor: 25_000, effectiveDate: AS_OF }).returning();
  await db().insert(paymentAllocations).values({ enrolmentId: active.enrolment.id, instalmentId: active.instalments[0].id, paymentEventId: activeReceipt.id, amountMinor: 25_000, source: "SUBMISSION" });
  await db().insert(paymentEvents).values({ enrolmentId: withdrawn.enrolment.id, kind: "RECEIPT", amountMinor: 6_000, effectiveDate: AS_OF });

  return { active, withdrawn, underTrashedIntake, underTrashedProgramme };
}

describe("read-only reconciliation CLI", () => {
  beforeEach(async () => {
    await resetDb();
    pinNow(`${AS_OF}T12:00:00+05:30`);
  });

  afterAll(async () => {
    unpinNow();
    await closeDb();
  });

  it("compares report totals only across active non-trashed enrolments while auditing all ledgers and cash history", async () => {
    await fixtures();

    const result = runReconciliation();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("All stored enrolments audited (all statuses and Trash): 4");
    expect(result.stdout).toContain("Active non-trashed enrolments compared with balance reports: 1");
    expect(result.stdout).toContain("No discrepancies found.");
  }, 120_000);

  it("reports a broken withdrawn ledger without repairing any stored financial data", async () => {
    const { withdrawn } = await fixtures();
    const [adjustment] = await db().insert(chargeAdjustments).values({
      enrolmentId: withdrawn.enrolment.id,
      instalmentId: withdrawn.instalments[0].id,
      amountMinor: -250_000,
      kind: "MANUAL",
      reason: "Synthetic invalid-ledger fixture",
      effectiveDate: AS_OF,
    }).returning();
    const beforeAllocations = await db().select().from(paymentAllocations);
    const beforeEvents = await db().select().from(paymentEvents);

    const result = runReconciliation();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`[LEDGER] enrolment ${withdrawn.enrolment.id}: instalment ${withdrawn.instalments[0].id}: net obligation -50000 < 0`);
    expect(result.stdout).toContain("No data was modified.");
    expect(await db().select().from(chargeAdjustments).where(eq(chargeAdjustments.id, adjustment.id))).toHaveLength(1);
    expect(await db().select().from(paymentAllocations)).toEqual(beforeAllocations);
    expect(await db().select().from(paymentEvents)).toEqual(beforeEvents);
  }, 120_000);
});
