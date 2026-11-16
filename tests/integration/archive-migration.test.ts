import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, test } from "vitest";
import { db, pgCode } from "@/db/client";
import { paymentSubmissions, receiptAssets } from "@/db/schema";
import { objectStore } from "@/server/storage";
import { assetBytes, studentAsset } from "@/server/services/submissions";
import { closeDb, makeEnrolment, makeIntake, makeProgramme, makeStudent, resetDb } from "./helpers";

const run = promisify(execFile);
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = path.resolve(".agents-logs/storage-archive-delivery");
beforeEach(resetDb);
afterAll(closeDb);

async function originalAsset() {
  const programme = await makeProgramme();
  const intake = await makeIntake(programme.id);
  const student = await makeStudent();
  const { enrolment } = await makeEnrolment(student.id, intake.id, []);
  const [asset] = await db().insert(receiptAssets).values({
    enrolmentId: enrolment.id, objectKey: `receipts/${randomUUID()}.pdf`,
    sha256: "a".repeat(64), mime: "application/pdf", sizeBytes: 1000,
    validation: "CLEAN", scan: "NOT_CONFIGURED",
  }).returning();
  return asset;
}

test("new archive columns preserve original receipt metadata and require a coherent smaller archive", async () => {
  const original = await originalAsset();
  expect(original).toMatchObject({ archiveEncoding: null, archiveSizeBytes: null, archivedAt: null });
  const archivedAt = new Date("2026-11-16T00:00:00Z");
  await db().update(receiptAssets).set({
    objectKey: `${original.objectKey}.archive.gz`, archiveEncoding: "gzip",
    archiveOriginalKey: original.objectKey, archiveSizeBytes: 300,
    archiveCheckedAt: archivedAt, archivedAt,
  }).where(eq(receiptAssets.id, original.id));
  const [archived] = await db().select().from(receiptAssets).where(eq(receiptAssets.id, original.id));
  expect(archived).toMatchObject({
    sha256: original.sha256, sizeBytes: original.sizeBytes, mime: original.mime,
    archiveEncoding: "gzip", archiveSizeBytes: 300,
  });
});

test.each([
  { archiveEncoding: "gzip" },
  { archiveSizeBytes: 300 },
  { archiveOriginalDeletedAt: new Date("2026-11-16T00:00:00Z") },
  { archiveEncoding: "br", archiveOriginalKey: "old.pdf", archiveSizeBytes: 300, archivedAt: new Date() },
  { archiveEncoding: "gzip", archiveOriginalKey: "old.pdf", archiveSizeBytes: -1, archivedAt: new Date() },
  { archiveEncoding: "gzip", archiveOriginalKey: "old.pdf", archiveSizeBytes: 1000, archivedAt: new Date() },
])("database rejects incomplete or invalid archive metadata %#", async (patch) => {
  const original = await originalAsset();
  const error = await db().update(receiptAssets).set(patch).where(eq(receiptAssets.id, original.id))
    .then(() => null, (cause: unknown) => cause);
  expect(pgCode(error)).toBe("23514");
  const [unchanged] = await db().select().from(receiptAssets).where(eq(receiptAssets.id, original.id));
  expect(unchanged).toMatchObject({ objectKey: original.objectKey, archiveEncoding: null, sha256: original.sha256 });
});

test("migration CLI prefers the direct URL and explicit --url overrides both configured URLs", async () => {
  const direct = process.env.DATABASE_URL;
  if (!direct) throw new Error("Isolated migration test database is missing");
  const invalid = "postgres://unused:do-not-log-password@127.0.0.1:1/unused?connect_timeout=1";
  const directRun = await run(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: invalid, DATABASE_URL_UNPOOLED: direct }, timeout: 20_000,
  });
  expect(directRun.stdout).toContain("migrations applied");
  const explicitRun = await run(process.execPath, ["--import", "tsx", "scripts/migrate.ts", "--url", direct], {
    env: { ...process.env, DATABASE_URL: invalid, DATABASE_URL_UNPOOLED: invalid }, timeout: 20_000,
  });
  expect(explicitRun.stdout).toContain("migrations applied");
  const fallbackRun = await run(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: direct, DATABASE_URL_UNPOOLED: "" }, timeout: 20_000,
  });
  expect(fallbackRun.stdout).toContain("migrations applied");
});

test("migration CLI failure output does not reveal configured connection credentials", async () => {
  const result = await run(process.execPath, ["--import", "tsx", "scripts/migrate.ts", "--url"], {
    env: { ...process.env, DATABASE_URL_UNPOOLED: "postgres://unused:never-show-this-password@127.0.0.1:1/unused" },
    timeout: 20_000,
  }).then(() => null, (error: unknown) => error as { code: number; stdout: string; stderr: string });
  expect(result?.code).toBe(1);
  expect(result?.stderr).toContain("Migration failed.");
  expect(`${result?.stdout}${result?.stderr}`).not.toContain("never-show-this-password");
});

test("student and scoped staff evidence readers return exact original bytes from an archive and keep previews separate", async () => {
  const programme = await makeProgramme();
  const intake = await makeIntake(programme.id);
  const student = await makeStudent();
  const plan = await makeEnrolment(student.id, intake.id, [{ amountMinor: 1000, dueDate: "2026-10-01" }]);
  const original = Buffer.from("synthetic receipt evidence ".repeat(300));
  const compressed = gzipSync(original);
  const key = `receipts/${randomUUID()}.pdf.archive.gz`;
  const previewKey = `${key}.preview.webp`;
  const preview = Buffer.from("synthetic preview representation");
  const store = objectStore();
  try {
    await store.put(key, compressed, "application/gzip");
    await store.put(previewKey, preview, "image/webp");
    const [asset] = await db().insert(receiptAssets).values({
      enrolmentId: plan.enrolment.id, objectKey: key,
      sha256: createHash("sha256").update(original).digest("hex"), mime: "application/pdf",
      sizeBytes: original.length, archiveEncoding: "gzip", archiveOriginalKey: `${key}.original`,
      archiveSizeBytes: compressed.length, archivedAt: new Date(), archiveCheckedAt: new Date(),
      validation: "CLEAN", scan: "NOT_CONFIGURED",
    }).returning();
    const [submission] = await db().insert(paymentSubmissions).values({
      enrolmentId: plan.enrolment.id, targetInstalmentId: plan.instalments[0].id,
      assetId: asset.id, claimedMinor: 1000, transferDate: "2026-10-01", idempotencyKey: randomUUID(),
      status: "REJECTED", decidedAt: new Date("2026-10-02T00:00:00Z"),
    }).returning();
    const principal = {
      kind: "student" as const, sessionId: randomUUID(), studentId: student.id,
      enrolmentId: plan.enrolment.id, intakeId: intake.id, programmeId: programme.id, csrfSecret: "synthetic",
    };
    const studentRead = await studentAsset(principal, submission.id, "original");
    expect(studentRead.mime).toBe("application/pdf");
    expect(studentRead.bytes.equals(original)).toBe(true);
    const staffRead = await assetBytes(db(), submission.id, "original", (id) => id === plan.enrolment.id);
    expect(staffRead.bytes.equals(original)).toBe(true);
    // PDF preview requests without a preview object still return the decoded original.
    expect((await studentAsset(principal, submission.id, "preview")).bytes.equals(original)).toBe(true);
    await db().update(receiptAssets).set({ previewKey }).where(eq(receiptAssets.id, asset.id));
    expect(await studentAsset(principal, submission.id, "preview")).toEqual({ bytes: preview, mime: "image/webp" });
    await expect(assetBytes(db(), submission.id, "original", () => false)).rejects.toMatchObject({ status: 404 });
    await expect(studentAsset({ ...principal, enrolmentId: randomUUID() }, submission.id, "original")).rejects.toMatchObject({ status: 404 });
  } finally {
    await store.delete(key);
    await store.delete(previewKey);
  }
});
