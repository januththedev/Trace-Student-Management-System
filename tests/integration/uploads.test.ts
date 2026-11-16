import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, test } from "vitest";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStaff, makeStudent, pinNow, principalOf, resetDb, unpinNow } from "./helpers";
import { db } from "@/db/client";
import { auditEvents, paymentSubmissions, receiptAssets, uploadIntents } from "@/db/schema";
import { suggestInstalment } from "@/domain/finance";
import type { StudentPrincipal } from "@/server/auth/student";
import { loadLedger } from "@/server/services/ledger";
import { rejectSubmission } from "@/server/services/review";
import { cleanupOrphanUploads, createUploadIntent, finalizeSubmission, MAX_BYTES, studentAsset, studentDashboard, submitInput, uploadToIntent } from "@/server/services/submissions";
import { objectStore } from "@/server/storage";

process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = path.resolve("tests/e2e/.artifacts/storage-uploads");

beforeEach(async () => { await resetDb(); pinNow("2026-11-15T06:00:00Z"); });
afterAll(async () => { unpinNow(); await closeDb(); });

async function fixture() {
  const programme = await makeProgramme(), student = await makeStudent();
  const intake = await makeIntake(programme.id);
  const plan = await makeEnrolment(student.id, intake.id, [
    { amountMinor: 100_000, dueDate: "2026-12-20", label: "December" },
    { amountMinor: 100_000, dueDate: "2027-01-20", label: "January" },
  ]);
  const p: StudentPrincipal = { kind: "student", studentId: student.id, enrolmentId: plan.enrolment.id, intakeId: intake.id, programmeId: programme.id, sessionId: randomUUID(), csrfSecret: "synthetic" };
  return { p, ...plan };
}
const png = () => readFile(path.resolve("fixtures/receipts/receipt-1.png"));
async function upload(p: StudentPrincipal, bytes: Buffer, mime: "image/png" | "image/jpeg" | "application/pdf" = "image/png") {
  const intent = await createUploadIntent(p, { mime, sizeBytes: bytes.length });
  await uploadToIntent(p, intent.intentId, bytes);
  return intent.intentId;
}
function input(intentId: string, targetInstalmentId: string, extra = {}) {
  return submitInput.parse({ intentId, targetInstalmentId, claimedMinor: 100_000, transferDate: "2026-11-14", ...extra });
}

test.each(["PNG", "PDF"])("valid %s finalizes asset and submission, persists in history and re-reads original bytes", async (kind) => {
  const f = await fixture();
  const doc = await PDFDocument.create(); doc.addPage();
  const bytes = kind === "PNG" ? await png() : Buffer.from(await doc.save());
  const intentId = await upload(f.p, bytes, kind === "PNG" ? "image/png" : "application/pdf");
  const result = await finalizeSubmission(f.p, input(intentId, f.instalments[0].id), randomUUID());
  expect(result.submission.status).toBe("PENDING_REVIEW");
  const [asset] = await db().select().from(receiptAssets).where(eq(receiptAssets.id, result.submission.assetId!));
  expect(asset).toMatchObject({ uploadIntentId: intentId, validation: "CLEAN", sizeBytes: bytes.length });
  expect((await studentAsset(f.p, result.submission.id, "original")).bytes.equals(bytes)).toBe(true);
  const reread = await studentDashboard(f.p);
  expect(reread.submissions).toContainEqual(expect.objectContaining({ id: result.submission.id, status: "PENDING_REVIEW" }));
  expect(reread.ledger.summary).toMatchObject({ pendingClaimedMinor: 100_000, approvedAllocatedMinor: 0, outstandingMinor: 200_000 });
  expect(await db().select().from(auditEvents).where(eq(auditEvents.entityId, result.submission.id))).toHaveLength(1);
});

test("oversized declarations and uploaded bodies are rejected without submission", async () => {
  const f = await fixture();
  await expect(createUploadIntent(f.p, { mime: "image/png", sizeBytes: MAX_BYTES() + 1 })).rejects.toMatchObject({ code: "VALIDATION" });
  const intent = await createUploadIntent(f.p, { mime: "image/png", sizeBytes: 100 });
  await expect(uploadToIntent(f.p, intent.intentId, Buffer.alloc(MAX_BYTES() + 1))).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await db().select().from(paymentSubmissions)).toHaveLength(0);
});

test.each(["MIME mismatch", "corrupt PNG", "SVG", "encrypted PDF"])("%s fails server finalization and removes invalid object", async (kind) => {
  const f = await fixture();
  let bytes = await png();
  let mime: "image/png" | "image/jpeg" | "application/pdf" = "image/png";
  const code = { "MIME mismatch": "MIME_MISMATCH", "corrupt PNG": "CORRUPT", SVG: "UNSUPPORTED_TYPE", "encrypted PDF": "ENCRYPTED_PDF" }[kind];
  if (kind === "MIME mismatch") mime = "image/jpeg";
  if (kind === "corrupt PNG") bytes = bytes.subarray(0, 40);
  if (kind === "SVG") bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  if (kind === "encrypted PDF") {
    const doc = await PDFDocument.create(); doc.addPage();
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: PDFName.of("Standard"), V: 1, R: 2, Length: 40, O: PDFHexString.of("00".repeat(32)), U: PDFHexString.of("00".repeat(32)), P: -4 }));
    bytes = Buffer.from(await doc.save({ useObjectStreams: false })); mime = "application/pdf";
  }
  const intentId = await upload(f.p, bytes, mime);
  const [intent] = await db().select().from(uploadIntents).where(eq(uploadIntents.id, intentId));
  await expect(finalizeSubmission(f.p, input(intentId, f.instalments[0].id), randomUUID())).rejects.toMatchObject({ code: "VALIDATION", details: { code } });
  expect(await objectStore().exists(intent.objectKey)).toBe(false);
  expect(await db().select().from(paymentSubmissions)).toHaveLength(0);
  expect(await db().select().from(receiptAssets)).toHaveLength(0);
});

test("future transfer dates are rejected in Colombo business time", async () => {
  const f = await fixture();
  pinNow("2026-12-31T18:00:00Z"); // 23:30 Colombo, still December 31.
  const intentId = await upload(f.p, await png());
  await expect(finalizeSubmission(f.p, input(intentId, f.instalments[0].id, { transferDate: "2027-01-01" }), randomUUID())).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await db().select().from(paymentSubmissions)).toHaveLength(0);
});

test("simultaneous and subsequent retries with one idempotency key create one submission and asset", async () => {
  const f = await fixture(), key = randomUUID();
  const intentId = await upload(f.p, await png());
  const data = input(intentId, f.instalments[0].id);
  const results = await Promise.all([finalizeSubmission(f.p, data, key), finalizeSubmission(f.p, data, key)]);
  const replay = await finalizeSubmission(f.p, data, key);
  expect(new Set([...results, replay].map((r) => r.submission.id)).size).toBe(1);
  expect(replay.replayed).toBe(true);
  expect(await db().select().from(paymentSubmissions)).toHaveLength(1);
  expect(await db().select().from(receiptAssets)).toHaveLength(1);
});

test("rejected evidence is immutable and concurrent replacements permit only one linked successor", async () => {
  const f = await fixture();
  const original = await finalizeSubmission(f.p, input(await upload(f.p, await png()), f.instalments[0].id), randomUUID());
  const staff = principalOf(await makeStaff("SUPER_ADMIN"));
  await rejectSubmission(staff, { submissionId: original.submission.id, expectedVersion: 1, reason: "The reference is not readable." }, randomUUID());
  const intents = await Promise.all([upload(f.p, await png()), upload(f.p, await png())]);
  const results = await Promise.allSettled(intents.map((id) => finalizeSubmission(f.p, input(id, f.instalments[0].id, { supersedesSubmissionId: original.submission.id }), randomUUID())));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ code: "CONFLICT" });
  expect(await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.supersedesSubmissionId, original.submission.id))).toHaveLength(1);
  expect((await studentAsset(f.p, original.submission.id, "original")).bytes.equals(await png())).toBe(true);
  expect((await db().select().from(paymentSubmissions).where(eq(paymentSubmissions.id, original.submission.id)))[0].status).toBe("REJECTED");
});

test("orphan cleanup observes grace and never deletes an attached receipt even if its intent is pending", async () => {
  const f = await fixture(), bytes = await png();
  const abandoned = await upload(f.p, bytes);
  const attached = await upload(f.p, bytes);
  const finalized = await finalizeSubmission(f.p, input(attached, f.instalments[0].id), randomUUID());
  const rows = await db().select().from(uploadIntents);
  const abandonedKey = rows.find((r) => r.id === abandoned)!.objectKey;
  const attachedKey = rows.find((r) => r.id === attached)!.objectKey;
  await db().update(uploadIntents).set({ status: "PENDING" }).where(eq(uploadIntents.id, attached));
  pinNow("2026-11-16T06:29:00Z");
  expect((await cleanupOrphanUploads()).cleaned).toBe(0);
  expect(await objectStore().exists(abandonedKey)).toBe(true);
  pinNow("2026-11-16T06:31:00Z");
  expect(await cleanupOrphanUploads()).toEqual({ scanned: 2, cleaned: 1 });
  expect(await objectStore().exists(abandonedKey)).toBe(false);
  expect(await objectStore().exists(attachedKey)).toBe(true);
  expect((await studentAsset(f.p, finalized.submission.id, "original")).bytes.equals(bytes)).toBe(true);
  expect((await cleanupOrphanUploads()).cleaned).toBe(0);
});

test("earliest unpaid suggestion crosses December to January without hiding pending evidence or advance choices", async () => {
  const f = await fixture();
  pinNow("2027-01-01T06:00:00Z");
  await finalizeSubmission(f.p, input(await upload(f.p, await png()), f.instalments[0].id, { transferDate: "2026-12-31" }), randomUUID());
  const ledger = await loadLedger(db(), f.p.enrolmentId);
  expect(suggestInstalment([...ledger.instalments].reverse())).toMatchObject({ id: f.instalments[0].id, hasPendingEvidence: true, remainingMinor: 100_000, state: "OVERDUE" });
  const advance = await finalizeSubmission(f.p, input(await upload(f.p, await png()), f.instalments[1].id, { transferDate: "2027-01-01" }), randomUUID());
  expect(advance.submission.targetInstalmentId).toBe(f.instalments[1].id);
  expect(await db().select().from(paymentSubmissions).where(and(eq(paymentSubmissions.enrolmentId, f.p.enrolmentId), eq(paymentSubmissions.status, "PENDING_REVIEW")))).toHaveLength(2);
});
