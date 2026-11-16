import "dotenv/config";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enrolments, feePlanItems, feePlanVersions, instalments, intakes, programmes, students,
} from "@/db/schema";

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const upgradeIndexNames = [
  "perf_enrolment_active_intake_idx",
  "perf_instalment_balance_idx",
  "perf_adjustment_enrolment_idx",
  "perf_exemption_active_enrolment_idx",
  "perf_allocation_active_enrolment_idx",
  "perf_event_enrolment_balance_idx",
  "perf_pending_enrolment_idx",
  "perf_call_latest_idx",
  "perf_export_pending_idx",
  "perf_export_expiry_idx",
] as const;

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};

describe("database migrations", () => {
  let testUrl: URL;
  let databaseName = "";
  let databaseCreated = false;
  let databaseClient: Sql | undefined;
  let db: PostgresJsDatabase<Record<string, never>> | undefined;
  let journalFixtureDir: string | undefined;
  let expectedMigrationCount = 0;
  let fixture: { programmeId: string; intakeId: string; studentId: string; enrolmentId: string; instalmentId: string };

  beforeAll(async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) throw new Error("TEST_DATABASE_URL is required for migration integration tests");
    testUrl = new URL(baseUrl);

    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal;
    expect(journal.dialect).toBe("postgresql");
    expect(journal.entries.slice(0, 3).map((entry) => entry.tag)).toEqual([
      "0000_init", "0001_integrity", "0002_perf_indexes",
    ]);
    expectedMigrationCount = journal.entries.length;

    const firstTwo = journal.entries.slice(0, 2);
    expect(firstTwo.map((entry) => entry.tag)).toEqual(["0000_init", "0001_integrity"]);
    journalFixtureDir = await mkdtemp(path.join(os.tmpdir(), "t2t-migration-journal-"));
    const temporaryMeta = path.join(journalFixtureDir, "meta");
    await mkdir(temporaryMeta);
    for (const entry of firstTwo) {
      await copyFile(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(journalFixtureDir, `${entry.tag}.sql`));
    }
    await writeFile(path.join(temporaryMeta, "_journal.json"), JSON.stringify({ ...journal, entries: firstTwo }, null, 2), "utf8");

    databaseName = `t2t_upgrade_${randomUUID().replaceAll("-", "")}`;
    if (!/^t2t_upgrade_[0-9a-f]{32}$/.test(databaseName)) throw new Error("Refusing an invalid disposable upgrade database name");
    const admin = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`create database "${databaseName}"`);
      databaseCreated = true;
    } finally {
      await admin.end();
    }

    const upgradeUrl = new URL(testUrl);
    upgradeUrl.pathname = `/${databaseName}`;
    databaseClient = postgres(upgradeUrl.toString(), { max: 1, onnotice: () => {} });
    db = drizzle(databaseClient);

    // Establish a real v2 database state using the same journal-aware migrator as production.
    await migrate(db, { migrationsFolder: journalFixtureDir });
    const applied = await databaseClient.unsafe<{ count: number }[]>("select count(*)::int as count from drizzle.__drizzle_migrations");
    expect(applied[0]?.count).toBe(2);

    const [programme] = await db.insert(programmes).values({
      code: "UPGRADE-FIXTURE", name: "Migration Upgrade Fixture", description: "synthetic migration evidence",
    }).returning();
    const [intake] = await db.insert(intakes).values({
      programmeId: programme.id, code: "UPGRADE-2026", label: "Migration Batch", startDate: "2026-01-01",
    }).returning();
    const [student] = await db.insert(students).values({
      ref: "T2T-UPGRADE-FIXTURE", nicEnc: "synthetic-encrypted-nic", nicLookup: "synthetic-nic-digest",
      nicMasked: "********123", fullName: "Migration Fixture Student",
    }).returning();
    const [feePlan] = await db.insert(feePlanVersions).values({ intakeId: intake.id, versionNo: 1, isCurrent: true }).returning();
    const [item] = await db.insert(feePlanItems).values({
      versionId: feePlan.id, sequence: 1, periodLabel: "Migration instalment", amountMinor: 246800, dueDate: "2026-02-01",
    }).returning();
    const [enrolment] = await db.insert(enrolments).values({
      studentId: student.id, intakeId: intake.id, feePlanVersionId: feePlan.id,
    }).returning();
    const [instalment] = await db.insert(instalments).values({
      enrolmentId: enrolment.id, feePlanItemId: item.id, sequence: 1, periodLabel: item.periodLabel,
      originalChargeMinor: item.amountMinor, dueDate: item.dueDate,
    }).returning();
    fixture = {
      programmeId: programme.id, intakeId: intake.id, studentId: student.id,
      enrolmentId: enrolment.id, instalmentId: instalment.id,
    };
  }, 120_000);

  afterAll(async () => {
    try {
      await databaseClient?.end({ timeout: 5 });
      databaseClient = undefined;
      db = undefined;

      if (databaseCreated) {
        const baseDatabase = decodeURIComponent(testUrl.pathname.replace(/^\/+/, ""));
        if (!/^t2t_upgrade_[0-9a-f]{32}$/.test(databaseName) || databaseName === baseDatabase) {
          throw new Error("Refusing to drop a database outside the created disposable upgrade target");
        }
        const admin = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
        try {
          const matches = await admin.unsafe<{ datname: string }[]>("select datname from pg_database where datname = $1", [databaseName]);
          if (matches.length === 1 && matches[0].datname === databaseName) {
            await admin.unsafe(`drop database "${databaseName}" with (force)`);
          }
        } finally {
          await admin.end();
        }
        databaseCreated = false;
      }
    } finally {
      if (journalFixtureDir) {
        const tempRoot = path.resolve(os.tmpdir());
        const target = path.resolve(journalFixtureDir);
        if (!target.startsWith(`${tempRoot}${path.sep}`) || target === tempRoot) throw new Error("Refusing to clean a path outside the created migration-journal temp folder");
        await rm(target, { recursive: true, force: true });
        journalFixtureDir = undefined;
      }
    }
  }, 120_000);

  it("upgrades a populated 0000/0001 database through the checked-in migration chain", async () => {
    if (!db || !databaseClient) throw new Error("Disposable upgrade database was not initialized");
    await migrate(db, { migrationsFolder });

    const rows = await db.select({
      programmeId: programmes.id,
      intakeId: intakes.id,
      studentId: students.id,
      enrolmentId: enrolments.id,
      instalmentId: instalments.id,
      programmeName: programmes.name,
      intakeLabel: intakes.label,
      studentName: students.fullName,
      enrolmentStatus: enrolments.status,
      planAmountMinor: feePlanItems.amountMinor,
      instalmentAmountMinor: instalments.originalChargeMinor,
    }).from(instalments)
      .innerJoin(enrolments, eq(enrolments.id, instalments.enrolmentId))
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
      .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
      .innerJoin(feePlanItems, eq(feePlanItems.id, instalments.feePlanItemId))
      .where(eq(instalments.id, fixture.instalmentId));
    expect(rows).toEqual([{
      programmeId: fixture.programmeId,
      intakeId: fixture.intakeId,
      studentId: fixture.studentId,
      enrolmentId: fixture.enrolmentId,
      instalmentId: fixture.instalmentId,
      programmeName: "Migration Upgrade Fixture",
      intakeLabel: "Migration Batch",
      studentName: "Migration Fixture Student",
      enrolmentStatus: "ACTIVE",
      planAmountMinor: 246800,
      instalmentAmountMinor: 246800,
    }]);

    const applied = await databaseClient.unsafe<{ count: number }[]>("select count(*)::int as count from drizzle.__drizzle_migrations");
    expect(applied[0]?.count).toBe(expectedMigrationCount);

    const indexes = await databaseClient.unsafe<{ indexname: string }[]>(
      "select indexname from pg_indexes where schemaname = 'public' and indexname = any($1)",
      [[...upgradeIndexNames]],
    );
    expect(indexes.map((index) => index.indexname).sort()).toEqual([...upgradeIndexNames].sort());
  }, 120_000);
});
