import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, isNull, and } from "drizzle-orm";
import { resetDb, closeDb, makeProgramme, makeIntake, makeStudent, makeEnrolment, makeStaff, principalOf } from "./helpers";
import { db } from "@/db/client";
import { auditEvents, chargeAdjustments, enrolments, feePlanItems, instalments, paymentAllocations, paymentEvents, staffAccounts, staffScopes } from "@/db/schema";
import { applyFeePlan, feePlanCandidates, previewFeePlan } from "@/server/services/fee-plan-application";
import { createFeePlanVersion, grantExemption } from "@/server/services/enrolments";
import { loadLedger } from "@/server/services/ledger";

beforeEach(async () => { process.env.T2T_FAKE_NOW = "2026-11-16T06:00:00Z"; await resetDb(); });
afterAll(closeDb);

async function setup(amountMinor = 6000) {
  const programme = await makeProgramme(), intake = await makeIntake(programme.id);
  const student = await makeStudent();
  const old = await makeEnrolment(student.id, intake.id, [{ amountMinor: 10000, dueDate: "2026-12-01" }]);
  const staff = await makeStaff("SUPER_ADMIN"), p = principalOf(staff);
  const version = await createFeePlanVersion(p, { intakeId: intake.id, items: [{ periodLabel: "Instalment 1", component: "TUITION", amountMinor, dueDate: "2026-12-01" }] });
  return { programme, intake, old, staff, p, version };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function preview(x: Setup, ids = [x.old.enrolment.id]) { return previewFeePlan(x.p, { versionId: x.version.versionId, enrolmentIds: ids }); }
function input(x: Setup, rows: Awaited<ReturnType<typeof previewFeePlan>>["rows"]) {
  return { versionId: x.version.versionId, reason: "Approved template amount change", selections: rows.map(row => ({ enrolmentId: row.enrolmentId, previewHash: row.previewHash })) };
}

describe("fee plan impact and explicit application", () => {
  it("previews without mutation and applies only selected enrolments, retaining stable IDs and original charges", async () => {
    const x = await setup(12000);
    const other = await makeStudent(); const untouched = await makeEnrolment(other.id, x.intake.id, [{ amountMinor: 10000, dueDate: "2026-12-01" }]);
    const r = await preview(x);
    expect(r.rows[0].lines[0]).toMatchObject({ deltaMinor: 2000, netBeforeMinor: 10000, netAfterMinor: 12000 });
    expect(await db().select().from(chargeAdjustments)).toHaveLength(0);
    await applyFeePlan(x.p, input(x, r.rows), randomUUID());
    const [inst] = await db().select().from(instalments).where(eq(instalments.id, x.old.instalments[0].id));
    expect(inst.originalChargeMinor).toBe(10000); expect(inst.feePlanItemId).toBe(x.old.instalments[0].feePlanItemId);
    expect((await loadLedger(db(), x.old.enrolment.id)).summary.netObligationMinor).toBe(12000);
    expect((await loadLedger(db(), untouched.enrolment.id)).summary.netObligationMinor).toBe(10000);
    const [changed] = await db().select().from(enrolments).where(eq(enrolments.id, x.old.enrolment.id));
    expect(changed.feePlanVersionId).toBe(x.version.versionId);
    expect((await db().select().from(chargeAdjustments))[0].kind).toBe("FEE_CHANGE");
    expect((await db().select().from(auditEvents)).filter(a => a.action === "feeplan.apply")).toHaveLength(1);
  });
  it("releases paid reduction to credit and keeps payment-event attribution through replacement allocations", async () => {
    const x = await setup();
    const [payment] = await db().insert(paymentEvents).values({ enrolmentId: x.old.enrolment.id, kind: "HISTORICAL_IMPORT", amountMinor: 9000, effectiveDate: "2026-11-16", actorId: x.p.id }).returning();
    const [allocation] = await db().insert(paymentAllocations).values({ enrolmentId: x.old.enrolment.id, instalmentId: x.old.instalments[0].id, paymentEventId: payment.id, amountMinor: 9000, source: "HISTORICAL_IMPORT" }).returning();
    const r = await preview(x); expect(r.rows[0].lines[0].releasedToCreditMinor).toBe(3000);
    await applyFeePlan(x.p, input(x, r.rows), randomUUID());
    const ledger = await loadLedger(db(), x.old.enrolment.id);
    expect(ledger.summary).toMatchObject({ netObligationMinor: 6000, approvedAllocatedMinor: 6000, creditMinor: 3000, collectedMinor: 9000 });
    const [reversed] = await db().select().from(paymentAllocations).where(eq(paymentAllocations.id, allocation.id)); expect(reversed.reversedAt).not.toBeNull();
    const [active] = await db().select().from(paymentAllocations).where(and(eq(paymentAllocations.enrolmentId, x.old.enrolment.id), isNull(paymentAllocations.reversedAt)));
    expect(active.paymentEventId).toBe(payment.id); expect(active.amountMinor).toBe(6000);
  });
  it("preserves bespoke adjustments and active exemptions", async () => {
    const x = await setup(12000);
    await db().insert(chargeAdjustments).values({ enrolmentId: x.old.enrolment.id, instalmentId: x.old.instalments[0].id, amountMinor: -500, kind: "MANUAL", reason: "Individual agreement", effectiveDate: "2026-11-16" });
    await grantExemption(x.p, { enrolmentId: x.old.enrolment.id, expectedEnrolmentVersion: 1, type: "DISCOUNT", basis: "FIXED", value: 1000, reason: "Individual discount", effectiveFrom: "2026-11-01", instalmentIds: [x.old.instalments[0].id] }, randomUUID());
    const r = await preview(x); expect(r.rows[0].lines[0]).toMatchObject({ deltaMinor: 2000, netBeforeMinor: 8500, netAfterMinor: 10500 });
    await applyFeePlan(x.p, input(x, r.rows), randomUUID()); expect((await loadLedger(db(), x.old.enrolment.id)).summary.netObligationMinor).toBe(10500);
  });
  it("rejects a reduction below active exemptions without clamping or writing", async () => {
    const x = await setup(1000);
    await grantExemption(x.p, { enrolmentId: x.old.enrolment.id, expectedEnrolmentVersion: 1, type: "DISCOUNT", basis: "FIXED", value: 5000, reason: "Existing agreement", effectiveFrom: "2026-11-01", instalmentIds: [x.old.instalments[0].id] }, randomUUID());
    const r = await preview(x); expect(r.rows[0].blocked).toContain("exemptions");
    await expect(applyFeePlan(x.p, input(x, r.rows), randomUUID())).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db().select().from(chargeAdjustments)).toHaveLength(0);
  });
  it.each(["dueDate", "component", "periodLabel", "sequence"] as const)("explicitly blocks changed %s mapping", async field => {
    const x = await setup();
    const values = { dueDate: "2027-01-01", component: "OTHER", periodLabel: "Renamed", sequence: 2 };
    await db().update(feePlanItems).set({ [field]: values[field] }).where(eq(feePlanItems.versionId, x.version.versionId));
    const r = await preview(x); expect(r.rows[0].blocked).toContain("automatic mapping");
    await expect(applyFeePlan(x.p, input(x, r.rows), randomUUID())).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("rejects stale financial previews and rolls back the entire selected batch", async () => {
    const x = await setup(); const st = await makeStudent(); const other = await makeEnrolment(st.id, x.intake.id, [{ amountMinor: 10000, dueDate: "2026-12-01" }]);
    const r = await preview(x, [x.old.enrolment.id, other.enrolment.id]);
    await db().insert(chargeAdjustments).values({ enrolmentId: other.enrolment.id, instalmentId: other.instalments[0].id, amountMinor: 500, kind: "MANUAL", reason: "Changed after preview", effectiveDate: "2026-11-16" });
    await expect(applyFeePlan(x.p, input(x, r.rows), randomUUID())).rejects.toMatchObject({ code: "STALE" });
    expect((await loadLedger(db(), x.old.enrolment.id)).summary.netObligationMinor).toBe(10000);
    expect((await db().select().from(chargeAdjustments)).filter(a => a.kind === "FEE_CHANGE")).toHaveLength(0);
  });
  it("rejects changed template terms after preview", async () => {
    const x = await setup(); const r = await preview(x);
    await db().update(feePlanItems).set({ amountMinor: 7000 }).where(eq(feePlanItems.versionId, x.version.versionId));
    await expect(applyFeePlan(x.p, input(x, r.rows), randomUUID())).rejects.toMatchObject({ code: "STALE" });
  });
  it("authorizes scopes and capabilities freshly including before idempotent replay", async () => {
    const x = await setup(); const a = await makeStaff("ADMIN", { capabilities: ["fees.adjust"], scopes: [{ programmeId: x.programme.id }] });
    const p = principalOf(a, [{ programmeId: x.programme.id }]); const r = await previewFeePlan(p, { versionId: x.version.versionId, enrolmentIds: [x.old.enrolment.id] });
    const key = randomUUID(); await applyFeePlan(p, input(x, r.rows), key);
    await db().delete(staffScopes).where(eq(staffScopes.staffId, a.id));
    await expect(applyFeePlan(p, input(x, r.rows), key)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().update(staffAccounts).set({ capabilities: [] }).where(eq(staffAccounts.id, a.id));
    await expect(feePlanCandidates(p, x.version.versionId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("does not reveal enrolments from another intake", async () => {
    const x = await setup(); const intake = await makeIntake(x.programme.id), st = await makeStudent(); const other = await makeEnrolment(st.id, intake.id, [{ amountMinor: 10000, dueDate: "2026-12-01" }]);
    await expect(preview(x, [other.enrolment.id])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("replays identically without double adjustment and rejects payload mismatch", async () => {
    const x = await setup(); const r = await preview(x); const data = input(x, r.rows), key = randomUUID();
    const first = await applyFeePlan(x.p, data, key); expect(await applyFeePlan(x.p, data, key)).toEqual(first);
    expect(await db().select().from(chargeAdjustments)).toHaveLength(1);
    await expect(applyFeePlan(x.p, { ...data, reason: "Different reason" }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });
  it("serializes concurrent applications so only one can use the preview", async () => {
    const x = await setup(); const r = await preview(x), data = input(x, r.rows);
    const results = await Promise.allSettled([applyFeePlan(x.p, data, randomUUID()), applyFeePlan(x.p, data, randomUUID())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("STALE");
    expect(await db().select().from(chargeAdjustments)).toHaveLength(1);
  });
  it("uses the last explicitly applied template for later deltas without accumulating duplicate reductions", async () => {
    const x = await setup(6000); const first = await preview(x);
    await applyFeePlan(x.p, input(x, first.rows), randomUUID());
    const next = await createFeePlanVersion(x.p, { intakeId: x.intake.id, items: [{ periodLabel: "Instalment 1", component: "TUITION", amountMinor: 7000, dueDate: "2026-12-01" }] });
    const r = await previewFeePlan(x.p, { versionId: next.versionId, enrolmentIds: [x.old.enrolment.id] });
    expect(r.rows[0].lines[0]).toMatchObject({ acceptedTemplateMinor: 6000, deltaMinor: 1000, netAfterMinor: 7000 });
    await applyFeePlan(x.p, { ...input(x, r.rows), versionId: next.versionId }, randomUUID());
    expect((await loadLedger(db(), x.old.enrolment.id)).summary.netObligationMinor).toBe(7000);
    expect((await db().select().from(instalments))[0].originalChargeMinor).toBe(10000);
  });
  it("rejects a preview when a newer current template supersedes it", async () => {
    const x = await setup(); const r = await preview(x);
    await createFeePlanVersion(x.p, { intakeId: x.intake.id, items: [{ periodLabel: "Instalment 1", amountMinor: 9000, dueDate: "2026-12-01" }] });
    await expect(applyFeePlan(x.p, input(x, r.rows), randomUUID())).rejects.toMatchObject({ code: "STALE" });
    expect(await db().select().from(chargeAdjustments)).toHaveLength(0);
  });
  it("blocks extra or missing target items rather than regenerating the existing schedule", async () => {
    const x = await setup();
    await db().insert(feePlanItems).values({ versionId: x.version.versionId, sequence: 2, periodLabel: "New instalment", amountMinor: 3000, dueDate: "2027-01-01" });
    const r = await preview(x); expect(r.rows[0].blocked).toContain("missing or extra");
    await expect(applyFeePlan(x.p, input(x, r.rows), randomUUID())).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db().select().from(instalments)).toHaveLength(1);
  });
});
describe("fee plan version retry safety", () => {
  it("replays concurrent and subsequent creation retries without duplicating versions or audit", async () => {
    const x = await setup();
    const payload = { intakeId: x.intake.id, items: [{ periodLabel: "Instalment 1", component: "TUITION", amountMinor: 7000, dueDate: "2026-12-01" }] };
    const key = randomUUID();
    const [first, concurrent] = await Promise.all([createFeePlanVersion(x.p, payload, undefined, key), createFeePlanVersion(x.p, payload, undefined, key)]);
    expect(concurrent).toEqual(first);
    expect(await createFeePlanVersion(x.p, payload, undefined, key)).toEqual(first);
    await expect(createFeePlanVersion(x.p, { ...payload, notes: "different payload" }, undefined, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    const versions = await db().select().from(feePlanItems).where(eq(feePlanItems.versionId, first.versionId));
    expect(versions).toHaveLength(1);
    expect((await db().select().from(auditEvents)).filter(event => event.action === "feeplan.version")).toHaveLength(2);
  });
  it("rechecks the current fee capability before creating a version or replaying a result", async () => {
    const x = await setup();
    const payload = { intakeId: x.intake.id, items: [{ periodLabel: "Instalment 1", amountMinor: 7000, dueDate: "2026-12-01" }] };
    const key = randomUUID();
    await createFeePlanVersion(x.p, payload, undefined, key);
    await db().update(staffAccounts).set({ role: "ADMIN", capabilities: [] }).where(eq(staffAccounts.id, x.staff.id));
    await expect(createFeePlanVersion(x.p, payload, undefined, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createFeePlanVersion(x.p, payload, undefined, key)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(auditEvents)).filter(event => event.action === "feeplan.version")).toHaveLength(2);
  });
});
