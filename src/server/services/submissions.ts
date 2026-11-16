import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withTx, isUniqueViolation, type DbOrTx } from "@/db/client";
import {
  enrolments, instalments, intakes, notifications, paymentSubmissions, programmes, receiptAssets, reviewActions, students, uploadIntents,
} from "@/db/schema";
import { suggestInstalment } from "@/domain/finance";
import { makePreview, validateReceiptFile } from "@/lib/files/validate";
import { businessDate, daysBetween, isBizDate, now } from "@/lib/time";
import { audit } from "@/server/audit";
import type { StudentPrincipal } from "@/server/auth/student";
import { AppError, fail } from "@/server/http";
import { objectStore } from "@/server/storage";
import { readReceiptAssetBytes } from "@/server/storage/receipt-archive";
import { MalwareScanError, scanReceipt } from "@/server/malware";
import { loadLedger } from "./ledger";

export const MAX_BYTES = () => Number(process.env.RECEIPT_MAX_BYTES ?? 10 * 1024 * 1024);
const INTENT_TTL_MS = 30 * 60 * 1000;
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"] as const;

/* ------------------------------------------------------------ student views */

export async function studentDashboard(p: StudentPrincipal) {
  const [info] = await db().select({ student: students, programme: programmes, intake: intakes, enrolment: enrolments })
    .from(enrolments).innerJoin(students, eq(students.id, enrolments.studentId)).innerJoin(intakes, eq(intakes.id, enrolments.intakeId)).innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(eq(enrolments.id, p.enrolmentId));
  const ledger = await loadLedger(db(), p.enrolmentId);
  const subs = await db().select({ s: paymentSubmissions, period: instalments.periodLabel }).from(paymentSubmissions)
    .innerJoin(instalments, eq(instalments.id, paymentSubmissions.targetInstalmentId))
    .where(eq(paymentSubmissions.enrolmentId, p.enrolmentId)).orderBy(desc(paymentSubmissions.submittedAt)).limit(100);
  const decisions = subs.length ? await db().select({ submissionId: reviewActions.submissionId, kind: reviewActions.kind, reason: reviewActions.reason, confirmedMinor: reviewActions.confirmedMinor, createdAt: reviewActions.createdAt })
    .from(reviewActions).where(inArray(reviewActions.submissionId, subs.map((x) => x.s.id))).orderBy(desc(reviewActions.createdAt)) : [];
  const notes = await db().select().from(notifications).where(and(eq(notifications.recipientType, "STUDENT"), eq(notifications.recipientId, p.enrolmentId))).orderBy(desc(notifications.createdAt)).limit(20);
  return {
    student: { name: info.student.fullName, ref: info.student.ref, nicMasked: info.student.nicMasked },
    programme: { name: info.programme.name, code: info.programme.code, bannerPath: info.intake.bannerPath ?? info.programme.bannerPath, logoPath: info.programme.logoPath },
    intake: { label: info.intake.label },
    enrolmentStatus: info.enrolment.status,
    ledger,
    suggested: suggestInstalment(ledger.instalments),
    submissions: subs.map(({ s, period }) => ({
      id: s.id, periodLabel: period, targetInstalmentId: s.targetInstalmentId, claimedMinor: s.claimedMinor, transferDate: s.transferDate,
      bankReference: s.bankReference, status: s.status, submittedAt: s.submittedAt, supersedesSubmissionId: s.supersedesSubmissionId,
      hasAsset: !!s.assetId,
      // Student-visible decision info only: reasons for rejections, never private staff notes.
      decisions: decisions.filter((d) => d.submissionId === s.id).map((d) => ({ kind: d.kind, reason: d.kind === "REJECT" ? d.reason : null, confirmedMinor: d.kind === "APPROVE" ? d.confirmedMinor : null, at: d.createdAt })),
    })),
    notifications: notes.map((n) => ({ id: n.id, title: n.title, body: n.body, createdAt: n.createdAt, read: !!n.readAt })),
  };
}

/* ---------------------------------------------------------- upload pipeline */

export const intentInput = z.object({ mime: z.enum(ALLOWED_MIME), sizeBytes: z.number().int().positive() });

/** Step 1: intent bound to the session's enrolment, size/type limits, expiry, random key. */
export async function createUploadIntent(p: StudentPrincipal, input: z.infer<typeof intentInput>) {
  if (input.sizeBytes > MAX_BYTES()) throw fail.validation(`Files must be ${Math.round(MAX_BYTES() / 1048576)} MB or smaller.`);
  const key = `receipts/${p.enrolmentId}/${randomBytes(18).toString("hex")}`;
  const [intent] = await db().insert(uploadIntents).values({
    enrolmentId: p.enrolmentId, objectKey: key, maxBytes: MAX_BYTES(), declaredMime: input.mime === "image/jpg" ? "image/jpeg" : input.mime,
    expiresAt: new Date(now().getTime() + INTENT_TTL_MS),
  }).returning();
  return { intentId: intent.id, expiresAt: intent.expiresAt, maxBytes: intent.maxBytes };
}

/** Step 2: private object upload. Ownership re-resolved from the session, never from the client. */
export async function uploadToIntent(p: StudentPrincipal, intentId: string, body: Buffer) {
  return withTx(async tx => {
  const [intent] = await tx.select().from(uploadIntents).where(and(eq(uploadIntents.id, intentId), eq(uploadIntents.enrolmentId, p.enrolmentId))).for("update");
  if (!intent) throw fail.notFound();
  if (intent.status !== "PENDING" || intent.expiresAt < now()) throw fail.conflict("This upload link has expired. Please choose the file again.");
  if (body.length === 0) throw fail.validation("The file is empty.");
  if (body.length > intent.maxBytes) throw fail.validation(`Files must be ${Math.round(intent.maxBytes / 1048576)} MB or smaller.`);
  await objectStore().put(intent.objectKey, body, intent.declaredMime);
  await tx.update(uploadIntents).set({ uploadedAt: now() }).where(eq(uploadIntents.id, intent.id));
  return { ok: true };
  });
}

export const submitInput = z.object({
  intentId: z.string().uuid(),
  targetInstalmentId: z.string().uuid(),
  claimedMinor: z.number().int().positive().max(1_000_000_000_00),
  transferDate: z.string().refine(isBizDate, "Enter a valid date."),
  bankReference: z.string().trim().max(80).optional().transform((v) => v || null),
  studentNote: z.string().trim().max(500).optional().transform((v) => v || null),
  supersedesSubmissionId: z.string().uuid().optional(),
});

/**
 * Step 3: finalize. Validates the stored bytes server-side (magic bytes, decode, limits),
 * generates a sanitized preview, creates the asset + submission in one transaction.
 * Idempotent per (enrolment, Idempotency-Key): retries return the same submission.
 */
export async function finalizeSubmission(p: StudentPrincipal, input: z.infer<typeof submitInput>, idemKey: string) {
  const existing = await db().select().from(paymentSubmissions).where(and(eq(paymentSubmissions.enrolmentId, p.enrolmentId), eq(paymentSubmissions.idempotencyKey, idemKey)));
  if (existing[0]) return replayOrMismatch(existing[0], input);

  const today = businessDate();
  if (input.transferDate > today) throw fail.validation("The transfer date cannot be in the future.");

  const [intent] = await db().select().from(uploadIntents).where(and(eq(uploadIntents.id, input.intentId), eq(uploadIntents.enrolmentId, p.enrolmentId)));
  if (!intent) throw fail.notFound();
  if (intent.status === "FINALIZED") throw fail.conflict("This file was already submitted.");
  if (intent.status !== "PENDING" || intent.expiresAt < now() || !intent.uploadedAt) throw fail.conflict("The file upload is incomplete or expired. Please upload it again.");

  const bytes = await objectStore().get(intent.objectKey);
  if (!bytes) throw fail.conflict("The uploaded file could not be found. Please upload it again.");
  let scan: "NOT_CONFIGURED" | "CLEAN" | "INFECTED";
  try { scan = await scanReceipt(bytes); }
  catch (error) {
    if (error instanceof MalwareScanError) throw new AppError("DEPENDENCY_UNAVAILABLE", "Receipt safety checks are unavailable. Please retry this submission shortly.");
    throw error;
  }
  if (scan === "INFECTED") {
    await withTx(async tx => {
      const [locked] = await tx.select().from(uploadIntents).where(eq(uploadIntents.id, intent.id)).for("update");
      if (!locked || locked.status !== "PENDING") throw fail.conflict("This file was already processed.");
      const current = await objectStore().get(intent.objectKey);
      if (!current || createHash("sha256").update(current).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw fail.conflict("The uploaded file changed during safety checks. Please retry the submission.");
      await objectStore().delete(intent.objectKey);
      await tx.update(uploadIntents).set({ status: "CLEANED" }).where(eq(uploadIntents.id, intent.id));
      await audit(tx, { actorType: "STUDENT", actorId: p.studentId, action: "receipt.malware_rejected", entityType: "upload_intent", entityId: intent.id, intakeId: p.intakeId, programmeId: p.programmeId, after: { scan: "INFECTED" } });
    });
    throw fail.validation("The receipt failed the file safety check. Please choose a different file.");
  }
  const v = await validateReceiptFile(bytes, intent.declaredMime, { maxBytes: intent.maxBytes });
  if (!v.ok) {
    await withTx(async tx => {
      const [locked] = await tx.select().from(uploadIntents).where(eq(uploadIntents.id, intent.id)).for("update");
      if (!locked || locked.status !== "PENDING") throw fail.conflict("This file was already processed.");
      const current = await objectStore().get(intent.objectKey);
      if (!current || createHash("sha256").update(current).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw fail.conflict("The uploaded file changed during safety checks. Please retry the submission.");
      await objectStore().delete(intent.objectKey);
      await tx.update(uploadIntents).set({ status: "CLEANED" }).where(eq(uploadIntents.id, intent.id));
      await audit(tx, { actorType: "STUDENT", actorId: p.studentId, action: "receipt.validation_rejected", entityType: "upload_intent", entityId: intent.id, intakeId: p.intakeId, programmeId: p.programmeId, after: { code: v.code } });
    });
    throw fail.validation(v.message, { code: v.code });
  }
  const preview = await makePreview(bytes, v.kind);
  const previewKey = preview ? `${intent.objectKey}.preview.webp` : null;

  const flags: string[] = [];
  if (daysBetween(input.transferDate, today) > 90) flags.push("OLD_TRANSFER");

  try {
    return await withTx(async (tx) => {
      // Lock the enrolment row: serializes submissions/replacements for this enrolment.
      const [enr] = await tx.select().from(enrolments).where(eq(enrolments.id, p.enrolmentId)).for("update");
      if (!enr || enr.status !== "ACTIVE") throw fail.forbidden();
      // Upload PUT uses this same lock. Never attach bytes different from those
      // scanned/decoded above, or allow another PUT after finalization.
      const [currentIntent] = await tx.select().from(uploadIntents).where(eq(uploadIntents.id, intent.id)).for("update");
      if (!currentIntent || currentIntent.status !== "PENDING") {
        const [replay] = await tx.select().from(paymentSubmissions).where(and(eq(paymentSubmissions.enrolmentId, p.enrolmentId), eq(paymentSubmissions.idempotencyKey, idemKey)));
        if (replay) return replayOrMismatch(replay, input);
        throw fail.conflict("This file was already submitted.");
      }
      const currentBytes = await objectStore().get(intent.objectKey);
      if (!currentBytes || createHash("sha256").update(currentBytes).digest("hex") !== v.sha256) throw fail.conflict("The uploaded file changed during safety checks. Please retry the submission.");
      if (preview && previewKey) await objectStore().put(previewKey, preview, "image/webp");
      const ledger = await loadLedger(tx, p.enrolmentId);
      const target = ledger.instalments.find((i) => i.id === input.targetInstalmentId);
      if (!target) throw fail.notFound();
      if (target.remainingMinor <= 0) throw fail.validation("This instalment is already settled. Choose another instalment.");
      if (input.claimedMinor > Math.max(ledger.summary.outstandingMinor, target.remainingMinor) * 2) flags.push("UNUSUAL_AMOUNT");
      if (input.supersedesSubmissionId) {
        const [old] = await tx.select().from(paymentSubmissions).where(and(eq(paymentSubmissions.id, input.supersedesSubmissionId), eq(paymentSubmissions.enrolmentId, p.enrolmentId))).for("update");
        if (!old) throw fail.notFound();
        if (old.status !== "REJECTED") throw fail.conflict("Only a rejected receipt can be replaced.");
      }
      // Duplicate evidence checks (flag for humans; never auto-reject).
      const sameHash = await tx.select({ enrolmentId: receiptAssets.enrolmentId }).from(receiptAssets).where(eq(receiptAssets.sha256, v.sha256)).limit(5);
      if (sameHash.some((r) => r.enrolmentId === p.enrolmentId)) flags.push("DUPLICATE_FILE");
      else if (sameHash.length) flags.push("DUPLICATE_FILE_ELSEWHERE");
      if (input.bankReference) {
        const sameRef = await tx.select({ enrolmentId: paymentSubmissions.enrolmentId }).from(paymentSubmissions)
          .where(and(sql`lower(${paymentSubmissions.bankReference}) = ${input.bankReference.toLowerCase()}`, ne(paymentSubmissions.status, "REJECTED"))).limit(5);
        if (sameRef.some((r) => r.enrolmentId === p.enrolmentId)) flags.push("DUPLICATE_REFERENCE");
        else if (sameRef.length) flags.push("DUPLICATE_REFERENCE_ELSEWHERE");
      }
      const [asset] = await tx.insert(receiptAssets).values({
        enrolmentId: p.enrolmentId, uploadIntentId: intent.id, objectKey: intent.objectKey, previewKey, sha256: v.sha256, mime: v.mime,
        sizeBytes: bytes.length, width: v.width ?? null, height: v.height ?? null, pages: v.pages ?? null,
        validation: "CLEAN", scan,
      }).returning();
      await tx.update(uploadIntents).set({ status: "FINALIZED" }).where(eq(uploadIntents.id, intent.id));
      const [submission] = await tx.insert(paymentSubmissions).values({
        enrolmentId: p.enrolmentId, targetInstalmentId: target.id, assetId: asset.id, claimedMinor: input.claimedMinor, transferDate: input.transferDate,
        bankReference: input.bankReference, studentNote: input.studentNote, supersedesSubmissionId: input.supersedesSubmissionId ?? null,
        idempotencyKey: idemKey, flags: [...new Set(flags)],
      }).returning();
      await audit(tx, { actorType: "STUDENT", actorId: p.studentId, action: "receipt.submit", entityType: "payment_submission", entityId: submission.id, intakeId: p.intakeId, programmeId: p.programmeId, after: { claimedMinor: input.claimedMinor, transferDate: input.transferDate } });
      return { submission, replayed: false, warnings: submission.flags };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const [again] = await db().select().from(paymentSubmissions).where(and(eq(paymentSubmissions.enrolmentId, p.enrolmentId), eq(paymentSubmissions.idempotencyKey, idemKey)));
      if (again) return replayOrMismatch(again, input);
      throw fail.conflict("A replacement for this receipt was already submitted.");
    }
    throw e;
  }
}

/** Same key + same payload => original result; same key + different payload => IDEMPOTENCY_MISMATCH. */
async function replayOrMismatch(sub: typeof paymentSubmissions.$inferSelect, input: z.infer<typeof submitInput>) {
  let intentId: string | null = null;
  if (sub.assetId) {
    const [a] = await db().select({ intentId: receiptAssets.uploadIntentId }).from(receiptAssets).where(eq(receiptAssets.id, sub.assetId));
    intentId = a?.intentId ?? null;
  }
  const same = sub.targetInstalmentId === input.targetInstalmentId && sub.claimedMinor === input.claimedMinor && sub.transferDate === input.transferDate
    && (sub.bankReference ?? null) === (input.bankReference ?? null) && (sub.studentNote ?? null) === (input.studentNote ?? null)
    && (sub.supersedesSubmissionId ?? null) === (input.supersedesSubmissionId ?? null) && (intentId === null || intentId === input.intentId);
  if (!same) throw new AppError("IDEMPOTENCY_MISMATCH", "This request key was already used with different data.");
  return { submission: sub, replayed: true, warnings: sub.flags };
}

/** Authorized evidence bytes for a student (own enrolment only). */
export async function studentAsset(p: StudentPrincipal, submissionId: string, variant: "preview" | "original") {
  return assetBytes(db(), submissionId, variant, (enrolmentId) => enrolmentId === p.enrolmentId);
}

export async function assetBytes(tx: DbOrTx, submissionId: string, variant: "preview" | "original", allow: (enrolmentId: string) => boolean | Promise<boolean>) {
  const [row] = await tx.select({ s: paymentSubmissions, a: receiptAssets }).from(paymentSubmissions).innerJoin(receiptAssets, eq(receiptAssets.id, paymentSubmissions.assetId)).where(eq(paymentSubmissions.id, submissionId));
  if (!row || !(await allow(row.s.enrolmentId))) throw fail.notFound();
  if (row.a.validation !== "CLEAN" || !["NOT_CONFIGURED", "CLEAN"].includes(row.a.scan)) throw fail.conflict("The receipt file is not ready (file safety check).");
  const preview = variant === "preview" && row.a.previewKey;
  let bytes = preview ? await objectStore().get(preview) : await readReceiptAssetBytes(row.a);
  if (!bytes && !preview && !row.a.archiveEncoding) {
    // A long-running request can straddle retirement of the original physical
    // object. Re-read the durable archive reference before reporting absence.
    const [current] = await tx.select().from(receiptAssets).where(eq(receiptAssets.id, row.a.id));
    if (current?.archiveEncoding) bytes = await readReceiptAssetBytes(current);
  }
  if (!bytes) throw fail.notFound();
  return { bytes, mime: variant === "preview" && row.a.previewKey ? "image/webp" : row.a.mime };
}

/** Background: clean abandoned uploads after the grace period, never touching attached evidence. */
export async function cleanupOrphanUploads(limit = 200) {
  const cutoff = new Date(now().getTime() - ORPHAN_GRACE_MS);
  const rows = await db().select().from(uploadIntents).where(and(eq(uploadIntents.status, "PENDING"), lt(uploadIntents.expiresAt, cutoff))).limit(limit);
  let cleaned = 0;
  for (const r of rows) {
    const attached = await db().select({ id: receiptAssets.id }).from(receiptAssets).where(eq(receiptAssets.objectKey, r.objectKey));
    if (attached.length) { await db().update(uploadIntents).set({ status: "FINALIZED" }).where(eq(uploadIntents.id, r.id)); continue; }
    await objectStore().delete(r.objectKey);
    const upd = await db().update(uploadIntents).set({ status: "CLEANED" }).where(and(eq(uploadIntents.id, r.id), eq(uploadIntents.status, "PENDING"))).returning();
    cleaned += upd.length;
  }
  return { scanned: rows.length, cleaned };
}

export async function markNotificationsRead(p: StudentPrincipal) {
  await db().update(notifications).set({ readAt: now() }).where(and(eq(notifications.recipientType, "STUDENT"), eq(notifications.recipientId, p.enrolmentId), isNull(notifications.readAt)));
}


