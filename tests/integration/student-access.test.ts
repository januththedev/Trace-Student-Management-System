import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStudent, pinNow, resetDb, unpinNow } from "./helpers";
import { db } from "@/db/client";
import { auditEvents, enrolments, intakes, programmes, rememberedDevices, studentSessions, students } from "@/db/schema";
import { hashToken, newToken } from "@/lib/crypto";
import { maskNic } from "@/lib/nic";
import { audit } from "@/server/audit";
import { matchByDevice, matchEnrolment, revokeDeviceToken, type StudentPrincipal } from "@/server/auth/student";
import { createUploadIntent, finalizeSubmission, studentAsset, submitInput, uploadToIntent } from "@/server/services/submissions";

process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = path.resolve("tests/e2e/.artifacts/storage-student-access");

beforeEach(async () => { await resetDb(); pinNow("2026-11-15T06:00:00Z"); });
afterAll(async () => { unpinNow(); await closeDb(); });

async function fixture(nic = "199912345678") {
  const programme = await makeProgramme();
  const intake = await makeIntake(programme.id);
  const student = await makeStudent({ nic });
  const plan = await makeEnrolment(student.id, intake.id, [{ amountMinor: 100_000, dueDate: "2026-11-01" }]);
  const principal: StudentPrincipal = { kind: "student", sessionId: randomUUID(), studentId: student.id, enrolmentId: plan.enrolment.id, intakeId: intake.id, programmeId: programme.id, csrfSecret: "synthetic" };
  return { programme, intake, student, ...plan, principal };
}

test.each(["991234567V", "199912345678"])("matching NIC %s and intake enters immediately, normalizing whitespace and letter case", async (nic) => {
  const f = await fixture(nic);
  expect(await matchEnrolment(` ${nic.toLowerCase()} `, f.intake.id)).toMatchObject({ studentId: f.student.id, enrolmentId: f.enrolment.id, maskedNic: maskNic(f.student.nic) });
});

test.each(["invalid format", "unknown NIC", "inactive student", "withdrawn enrolment", "trashed intake", "trashed programme", "wrong intake", "inactive intake", "inactive programme"])("%s has the same neutral null outcome", async (variant) => {
  const f = await fixture();
  let nic = f.student.nic, intakeId = f.intake.id;
  if (variant === "invalid format") nic = "not-an-nic";
  if (variant === "unknown NIC") nic = "200012345679";
  if (variant === "inactive student") await db().update(students).set({ status: "INACTIVE" }).where(eq(students.id, f.student.id));
  if (variant === "withdrawn enrolment") await db().update(enrolments).set({ status: "WITHDRAWN" }).where(eq(enrolments.id, f.enrolment.id));
  if (variant === "trashed intake") await db().update(intakes).set({ trashedAt: new Date() }).where(eq(intakes.id, f.intake.id));
  if (variant === "trashed programme") await db().update(programmes).set({ trashedAt: new Date() }).where(eq(programmes.id, f.programme.id));
  if (variant === "wrong intake") intakeId = (await makeIntake(f.programme.id)).id;
  if (variant === "inactive intake") await db().update(intakes).set({ status: "ARCHIVED" }).where(eq(intakes.id, f.intake.id));
  if (variant === "inactive programme") await db().update(programmes).set({ status: "ARCHIVED" }).where(eq(programmes.id, f.programme.id));
  expect(await matchEnrolment(nic, intakeId)).toBeNull();
});

test.each(["991234567V", "991234567X"])("old NIC %s is not equivalent to its apparent new-format counterpart", async (oldNic) => {
  const f = await fixture(oldNic);
  expect(await matchEnrolment("199912304567", f.intake.id)).toBeNull();
  expect(await matchEnrolment(oldNic, f.intake.id)).not.toBeNull();
});

test("one student's two programmes cannot share evidence, upload intents or target instalments", async () => {
  const a = await fixture();
  const otherProgramme = await makeProgramme();
  const otherIntake = await makeIntake(otherProgramme.id);
  const b = await makeEnrolment(a.student.id, otherIntake.id, [{ amountMinor: 200_000, dueDate: "2026-11-01" }]);
  const other: StudentPrincipal = { ...a.principal, enrolmentId: b.enrolment.id, intakeId: otherIntake.id, programmeId: otherProgramme.id };
  const bytes = await readFile(path.resolve("fixtures/receipts/receipt-1.png"));
  const upload = async (p: StudentPrincipal) => {
    const intent = await createUploadIntent(p, { mime: "image/png", sizeBytes: bytes.length });
    await uploadToIntent(p, intent.intentId, bytes);
    return intent.intentId;
  };
  const foreignIntent = await upload(other);
  const foreign = await finalizeSubmission(other, submitInput.parse({ intentId: foreignIntent, targetInstalmentId: b.instalments[0].id, claimedMinor: 100_000, transferDate: "2026-11-14" }), randomUUID());
  for (const variant of ["preview", "original"] as const) await expect(studentAsset(a.principal, foreign.submission.id, variant)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(uploadToIntent(a.principal, foreignIntent, bytes)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(finalizeSubmission(a.principal, submitInput.parse({ intentId: foreignIntent, targetInstalmentId: a.instalments[0].id, claimedMinor: 100_000, transferDate: "2026-11-14" }), randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  const ownIntent = await upload(a.principal);
  await expect(finalizeSubmission(a.principal, submitInput.parse({ intentId: ownIntent, targetInstalmentId: b.instalments[0].id, claimedMinor: 100_000, transferDate: "2026-11-14" }), randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("device credential stores only a hash and masked NIC; no session/device/audit column contains raw NIC", async () => {
  const f = await fixture();
  const token = newToken();
  const [device] = await db().insert(rememberedDevices).values({ studentId: f.student.id, lastIntakeId: f.intake.id, maskedNic: maskNic(f.student.nic), tokenHash: hashToken(token, "device"), expiresAt: new Date("2026-12-01T00:00:00Z") }).returning();
  await db().insert(studentSessions).values({ studentId: f.student.id, enrolmentId: f.enrolment.id, tokenHash: hashToken(newToken(), "student-session"), csrfSecret: newToken(), idleExpiresAt: new Date("2026-11-15T07:00:00Z"), absoluteExpiresAt: new Date("2026-11-15T18:00:00Z") });
  await audit(db(), { actorType: "STUDENT", actorId: f.student.id, action: "student.entry.ok", entityType: "student_entry", after: { nic: f.student.nic, maskedNic: maskNic(f.student.nic) } });
  expect(await matchByDevice(token, f.intake.id)).toMatchObject({ deviceId: device.id, enrolmentId: f.enrolment.id, maskedNic: maskNic(f.student.nic) });
  for (const table of [rememberedDevices, studentSessions, auditEvents]) {
    const rows = await db().select().from(table);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(f.student.nic);
    expect(JSON.stringify(rows)).not.toContain(token);
  }
  await revokeDeviceToken(token);
  expect(await matchByDevice(token, f.intake.id)).toBeNull();
});

test("expired, unknown, missing and newly ineligible device credentials fail", async () => {
  const f = await fixture();
  const token = newToken();
  const [device] = await db().insert(rememberedDevices).values({ studentId: f.student.id, maskedNic: maskNic(f.student.nic), tokenHash: hashToken(token, "device"), expiresAt: new Date("2026-11-15T06:00:00Z") }).returning();
  expect(await matchByDevice(token, f.intake.id)).toBeNull();
  expect(await matchByDevice(newToken(), f.intake.id)).toBeNull();
  expect(await matchByDevice(undefined, f.intake.id)).toBeNull();
  await db().update(rememberedDevices).set({ expiresAt: new Date("2026-12-01T00:00:00Z") }).where(eq(rememberedDevices.id, device.id));
  expect(await matchByDevice(token, f.intake.id)).not.toBeNull();
  await db().update(enrolments).set({ status: "WITHDRAWN" }).where(eq(enrolments.id, f.enrolment.id));
  expect(await matchByDevice(token, f.intake.id)).toBeNull();
});
