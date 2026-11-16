import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditEvents, enrolments, feePlanVersions, identityResolutions, instalments, intakes, programmes, students } from "@/db/schema";
import { db, withTx } from "@/db/client";
import {
  closeDb, fakeNic, makeIntake, makeProgramme, makeStaff, makeStudent,
  pinNow, principalOf, resetDb, unpinNow,
} from "./helpers";
import { STUDENT_IMPORT_HEADERS, importStudents } from "@/server/services/imports/students-import";
import { listIdentities, previewIdentity, resolveIdentity } from "@/server/services/imports/identity-resolution";
import { toCsv } from "@/lib/csv";

beforeEach(async () => {
  await resetDb();
  pinNow("2026-06-15T12:00:00+05:30");
});

afterAll(async () => {
  unpinNow();
  await closeDb();
});

type Row = Partial<Record<(typeof STUDENT_IMPORT_HEADERS)[number], string | number>>;

function csv(rows: Row[]): string {
  return toCsv([...STUDENT_IMPORT_HEADERS], rows.map((r) => STUDENT_IMPORT_HEADERS.map((h) => r[h] ?? "")));
}

function row(over: Row): Row {
  return {
    full_name: "Import Student",
    nic: "123",
    programme_code: "PA",
    intake_code: "IA",
    instalment_sequence: 1,
    period_label: "Term 1",
    amount: "1000.00",
    due_date: "2026-06-01",
    ...over,
  };
}

async function fixture() {
  const programme = await makeProgramme({ code: "PA", name: "Programme A" });
  const intake = await makeIntake(programme.id, { code: "IA", label: "Intake A" });
  const superRow = await makeStaff("SUPER_ADMIN");
  const admin = await makeStaff("ADMIN", { capabilities: ["imports.run"], scopes: [{ programmeId: programme.id }] });
  const su = principalOf(superRow);
  const ad = principalOf(admin, [{ programmeId: programme.id }]);
  return { programme, intake, su, ad };
}

/** Commit an import whose single row has an invalid NIC, returning the staged resolution row. */
async function stageIdentityRow(batchKey: string, over: Row = {}) {
  const { su, staged, programme, intake, ad } = await (async () => {
    const f = await fixture();
    const r = await importStudents(f.su, csv([row({ student_ref: `IMP-${batchKey}`, ...over })]), { batchKey, dryRun: false });
    expect(r.committed).toBe(true);
    expect(r.identityResolutionsCreated).toBe(1);
    const [staged] = await db().select().from(identityResolutions);
    expect(staged.resolvedAt).toBeNull();
    return { ...f, staged };
  })();
  return { programme, intake, su, ad, staged };
}

function resolveInput(preview: { expectedHash: string }, nic: string, over: Record<string, unknown> = {}) {
  return {
    nic,
    reason: "Corrected from the signed paper admission form.",
    expectedHash: preview.expectedHash,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2).padEnd(10, "0")}`,
    ...over,
  };
}

describe("identity resolution: authorized import", () => {
  it("imports the corrected student, enrolment and staged schedule, then marks the row resolved", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-happy");
    const corrected = fakeNic();

    const preview = await previewIdentity(su, staged.id);
    expect(preview.fullName).toBe("Import Student");
    expect(preview.nicMasked).toBe("123");
    expect(preview.ref).toBe(`IMP-batch-resolve-happy`);
    expect(preview.schedule).toHaveLength(1);
    expect(preview.intakeCode).toBe("IA");

    const raw = JSON.stringify(preview);
    expect(raw).not.toContain(corrected);
    expect(raw).not.toContain('"payload"');

    const result = await resolveIdentity(su, staged.id, resolveInput(preview, corrected, { idempotencyKey: "idem-happy" }));
    expect(result.replayed).toBe(false);
    expect(result.studentRef).toBe("IMP-batch-resolve-happy");

    const [student] = await db().select().from(students);
    expect(student.ref).toBe("IMP-batch-resolve-happy");
    expect(student.fullName).toBe("Import Student");
    expect(student.nicMasked?.endsWith(corrected.slice(-3))).toBe(true);

    const [enrolment] = await db().select().from(enrolments).where(eq(enrolments.studentId, student.id));
    const [ia] = await db().select().from(intakes).where(eq(intakes.code, "IA"));
    expect(enrolment.intakeId).toBe(ia.id);
    const [inst] = await db().select().from(instalments).where(eq(instalments.enrolmentId, enrolment.id));
    expect(inst.originalChargeMinor).toBe(100000);
    expect(inst.dueDate).toBe("2026-06-01");

    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).not.toBeNull();
    expect(afterRow.resolvedBy).toBe(su.id);
    const resolution = JSON.parse(afterRow.resolution!);
    expect(resolution.outcome).toBe("IMPORTED");
    expect(resolution.studentId).toBe(student.id);
    // Original evidence preserved untouched.
    expect(afterRow.reason).toBe("Invalid or missing NIC in import");
    expect(afterRow.source).toBe("students_import");

    const [auditRow] = await db().select().from(auditEvents).where(eq(auditEvents.action, "identity.resolve.correct"));
    expect(auditRow.actorId).toBe(su.id);
    expect(JSON.stringify(auditRow)).not.toContain(corrected);
  });

  it("rejects a stale preview without writing anything", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-stale");
    const preview = await previewIdentity(su, staged.id);

    await expect(resolveIdentity(su, staged.id, resolveInput(preview, fakeNic(), { expectedHash: "stale-hash-value-0000" })))
      .rejects.toMatchObject({ code: "STALE" });
    expect(await db().select().from(students)).toHaveLength(0);
    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).toBeNull();
  });

  it("blocks a corrected NIC that already belongs to a student and leaves the row open", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-collide");
    const existing = await makeStudent({ fullName: "Existing Person" });
    const preview = await previewIdentity(su, staged.id);

    await expect(resolveIdentity(su, staged.id, resolveInput(preview, existing.nic)))
      .rejects.toMatchObject({ code: "CONFLICT" });

    expect((await db().select().from(students)).map((s) => s.id)).toEqual([existing.id]);
    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).toBeNull();
  });

  it("blocks a corrected reference that already exists and never merges records", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-ref");
    const existing = await makeStudent({ ref: `IMP-batch-resolve-ref` });
    const preview = await previewIdentity(su, staged.id);

    await expect(resolveIdentity(su, staged.id, resolveInput(preview, fakeNic())))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db().select().from(students)).map((s) => s.id)).toEqual([existing.id]);
  });

  it("rejects an invalid corrected NIC", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-invalid");
    const preview = await previewIdentity(su, staged.id);
    await expect(resolveIdentity(su, staged.id, resolveInput(preview, "123")))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db().select().from(students)).toHaveLength(0);
  });

  it("rolls back the whole import when a later write fails", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-rollback");
    const preview = await previewIdentity(su, staged.id);
    // Legitimate DB-level failure: a test-scoped CHECK constraint rejects the fee-plan version
    // created for this resolution, after the student row was already written.
    await db().execute(sql.raw(`alter table fee_plan_versions add constraint test_rollback_ck check (notes not like '%${staged.id}%')`));
    try {
      await expect(resolveIdentity(su, staged.id, resolveInput(preview, fakeNic())))
        .rejects.toThrow();
    } finally {
      await db().execute(sql.raw(`alter table fee_plan_versions drop constraint test_rollback_ck`));
    }
    expect(await db().select().from(students)).toHaveLength(0);
    expect(await db().select().from(enrolments)).toHaveLength(0);
    expect(await db().select().from(feePlanVersions)).toHaveLength(0);
    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).toBeNull();
  });

  it("supports legacy rows without a staged schedule or reference", async () => {
    const { programme, intake, su } = await fixture();
    const [legacy] = await db().insert(identityResolutions).values({
      source: "legacy_registry",
      reason: "Registry card without identifier",
      payload: { source: "legacy_registry:1", fullName: "Legacy Person", nicMasked: null, intakeCode: "IA", programmeCode: "PA" },
      programmeId: programme.id,
    }).returning();

    const preview = await previewIdentity(su, legacy.id);
    expect(preview.schedule).toHaveLength(0);
    expect(preview.ref).toBeNull();

    await resolveIdentity(su, legacy.id, resolveInput(preview, fakeNic(), { ref: "LEGACY-1" }));
    const [student] = await db().select().from(students);
    expect(student.ref).toBe("LEGACY-1");
    const [enrolment] = await db().select().from(enrolments).where(eq(enrolments.studentId, student.id));
    expect(enrolment.intakeId).toBe(intake.id);
    expect((await db().select().from(instalments).where(eq(instalments.enrolmentId, enrolment.id)))).toHaveLength(0);
    const [version] = await db().select().from(feePlanVersions);
    expect(version.intakeId).toBe(intake.id);
  });
});

describe("identity resolution: authorization", () => {
  it("denies ADMIN the queue, preview and resolution even in scope with imports.run", async () => {
    const { su, ad, staged } = await stageIdentityRow("batch-resolve-deny");
    const preview = await previewIdentity(su, staged.id);

    await expect(listIdentities(ad)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(previewIdentity(ad, staged.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(resolveIdentity(ad, staged.id, resolveInput(preview, fakeNic())))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(students)).toHaveLength(0);
    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).toBeNull();
  });

  it("hides unknown rows behind NOT_FOUND", async () => {
    const { su } = await fixture();
    await expect(previewIdentity(su, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(resolveIdentity(su, "00000000-0000-0000-0000-000000000000", resolveInput({ expectedHash: "x".repeat(20) }, fakeNic())))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects malformed ids neutrally as NOT_FOUND", async () => {
    const { su } = await fixture();
    const dashed = "-".repeat(36);
    await expect(previewIdentity(su, dashed)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(resolveIdentity(su, dashed, resolveInput({ expectedHash: "x".repeat(20) }, fakeNic())))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(previewIdentity(su, "not-a-uuid")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("identity resolution: direct input validation", () => {
  it("Zod-parses raw mutation input and rejects nothing-good-through without writing", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-raw");
    const preview = await previewIdentity(su, staged.id);
    const nic = fakeNic();
    const good = {
      nic,
      reason: "A sufficiently long correction reason.",
      expectedHash: preview.expectedHash,
      idempotencyKey: "idem-raw-base",
    };

    await expect(resolveIdentity(su, staged.id, { ...good, reason: "short" }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(resolveIdentity(su, staged.id, { ...good, schedule: [{ sequence: 1, amount: "100.00", dueDate: "2026-13-40" }] }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(resolveIdentity(su, staged.id, {
      ...good,
      schedule: [
        { sequence: 1, amount: "100.00", dueDate: "2026-07-01" },
        { sequence: 1, amount: "200.00", dueDate: "2026-07-02" },
      ],
    })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(resolveIdentity(su, staged.id, { ...good, expectedHash: "short" }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(resolveIdentity(su, staged.id, { nic, reason: "A sufficiently long correction reason." }))
      .rejects.toMatchObject({ code: "VALIDATION" });

    expect(await db().select().from(students)).toHaveLength(0);
    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).toBeNull();
  });
});

describe("identity resolution: intake ambiguity", () => {
  it("resolves to the staged programme when the same intake code exists in several programmes", async () => {
    const { programme, intake, su } = await fixture();
    const pb = await makeProgramme({ code: "PB", name: "Programme B" });
    await makeIntake(pb.id, { code: "IA", label: "Intake A twin" });

    const [staged] = await db().insert(identityResolutions).values({
      source: "legacy_registry",
      reason: "Registry card without identifier",
      payload: { source: "legacy_registry:1", fullName: "Twin Person", nicMasked: null, intakeCode: "IA", programmeCode: "PA" },
      programmeId: programme.id,
    }).returning();

    const preview = await previewIdentity(su, staged.id);
    const result = await resolveIdentity(su, staged.id, resolveInput(preview, fakeNic(), { ref: "TWIN-1" }));
    expect(result.replayed).toBe(false);

    const [enrolment] = await db().select().from(enrolments).where(eq(enrolments.studentId, result.studentId));
    expect(enrolment.intakeId).toBe(intake.id);
    expect((await db().select().from(students))).toHaveLength(1);
  });

  it("rejects an ambiguous legacy row with no programme reference instead of picking the first match", async () => {
    const { su } = await fixture();
    const pb = await makeProgramme({ code: "PB", name: "Programme B" });
    await makeIntake(pb.id, { code: "IA", label: "Intake A twin" });

    const [staged] = await db().insert(identityResolutions).values({
      source: "legacy_registry",
      reason: "Registry card without programme or identifier",
      payload: { source: "legacy_registry:2", fullName: "Ambiguous Person", nicMasked: null, intakeCode: "IA" },
    }).returning();

    const preview = await previewIdentity(su, staged.id);
    await expect(resolveIdentity(su, staged.id, resolveInput(preview, fakeNic())))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db().select().from(students)).toHaveLength(0);
    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).toBeNull();
  });

  it("rejects a row whose staged programme was trashed", async () => {
    const { programme, su } = await fixture();
    const [staged] = await db().insert(identityResolutions).values({
      source: "legacy_registry",
      reason: "Registry card without identifier",
      payload: { source: "legacy_registry:3", fullName: "Trashed Programme Person", nicMasked: null, intakeCode: "IA", programmeCode: "PA" },
      programmeId: programme.id,
    }).returning();

    const preview = await previewIdentity(su, staged.id);
    await db().update(programmes).set({ trashedAt: new Date() }).where(eq(programmes.id, programme.id));
    await expect(resolveIdentity(su, staged.id, resolveInput(preview, fakeNic())))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db().select().from(students)).toHaveLength(0);
  });

  it("rechecks intake state after waiting for its row lock", async () => {
    const { intake, su, staged } = await stageIdentityRow("batch-resolve-intake-lock-trash");
    const preview = await previewIdentity(su, staged.id);
    let locked!: () => void;
    let release!: () => void;
    const lockAcquired = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });

    const holding = withTx(async tx => {
      await tx.select({ id: intakes.id }).from(intakes).where(eq(intakes.id, intake.id)).for("update");
      locked();
      await gate;
      await tx.update(intakes).set({ trashedAt: new Date() }).where(eq(intakes.id, intake.id));
    });
    await lockAcquired;
    const resolving = resolveIdentity(su, staged.id, resolveInput(preview, fakeNic()))
      .then(() => ({ fulfilled: true as const }), error => ({ fulfilled: false as const, error }));

    try {
      await expect.poll(async () => {
        const waiting = await db().execute<{ wait_event_type: string; query: string }>(sql`
          select wait_event_type, query
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query ilike '%from "intakes"%'
            and query ilike '%for update%'
        `);
        return waiting.some(row => row.wait_event_type === "Lock" && /intakes/i.test(row.query));
      }, { timeout: 10_000 }).toBe(true);
      release();
      await holding;
      const outcome = await resolving;
      expect(outcome.fulfilled).toBe(false);
      if (!outcome.fulfilled) expect(outcome.error).toMatchObject({ code: "VALIDATION" });
    } finally {
      release();
      await holding;
    }

    expect(await db().select().from(students)).toHaveLength(0);
    expect(await db().select().from(enrolments)).toHaveLength(0);
    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).toBeNull();
  });

  it("serializes distinct resolution rows for the same intake so both commit with distinct fee-plan versions", async () => {
    const { programme, su } = await fixture();
    const batchA = "batch-resolve-race-intake-a";
    const batchB = "batch-resolve-race-intake-b";
    await importStudents(su, csv([row({ student_ref: "IMP-race-intake-a", nic: "123" })]), { batchKey: batchA, dryRun: false });
    await importStudents(su, csv([row({ student_ref: "IMP-race-intake-b", nic: "123" })]), { batchKey: batchB, dryRun: false });
    const staged = (await db().select().from(identityResolutions)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(staged).toHaveLength(2);
    expect(programme.trashedAt).toBeNull();

    const [previewA, previewB] = await Promise.all([
      previewIdentity(su, staged[0].id),
      previewIdentity(su, staged[1].id),
    ]);

    const results = await Promise.allSettled([
      resolveIdentity(su, staged[0].id, resolveInput(previewA, fakeNic())),
      resolveIdentity(su, staged[1].id, resolveInput(previewB, fakeNic())),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);

    const versions = (await db().select().from(feePlanVersions)).map((v) => v.versionNo).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2]);
    expect(await db().select().from(students)).toHaveLength(2);
    expect(await db().select().from(enrolments)).toHaveLength(2);
  });
});

describe("identity resolution: idempotency and concurrency", () => {
  it("replays the same idempotency key without duplicating and conflicts on a second resolve", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-replay");
    const preview = await previewIdentity(su, staged.id);
    const nic = fakeNic();

    const first = await resolveIdentity(su, staged.id, resolveInput(preview, nic, { idempotencyKey: "idem-replay" }));
    expect(first.replayed).toBe(false);

    const replay = await resolveIdentity(su, staged.id, resolveInput(preview, nic, { idempotencyKey: "idem-replay" }));
    expect(replay.replayed).toBe(true);
    expect(replay.studentId).toBe(first.studentId);
    expect(await db().select().from(students)).toHaveLength(1);

    await expect(resolveIdentity(su, staged.id, resolveInput(preview, nic, { idempotencyKey: "idem-second" })))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(students)).toHaveLength(1);
  });

  it("rejects the same idempotency key for different content", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-mismatch");
    const preview = await previewIdentity(su, staged.id);
    const input = resolveInput(preview, fakeNic(), { idempotencyKey: "idem-mismatch" });
    await resolveIdentity(su, staged.id, input);
    await expect(resolveIdentity(su, staged.id, { ...input, reason: "A different correction reason entirely." }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("serializes concurrent resolvers so exactly one import commits", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-race");
    const preview = await previewIdentity(su, staged.id);
    const [a, b] = [fakeNic(), fakeNic()];

    const results = await Promise.allSettled([
      resolveIdentity(su, staged.id, resolveInput(preview, a, { idempotencyKey: "idem-race-a" })),
      resolveIdentity(su, staged.id, resolveInput(preview, b, { idempotencyKey: "idem-race-b" })),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });

    const created = await db().select().from(students);
    expect(created).toHaveLength(1);
    const suffixes = [a, b].map((n) => n.slice(-3));
    expect(suffixes.some((s) => created[0].nicMasked?.endsWith(s))).toBe(true);
    const [afterRow] = await db().select().from(identityResolutions).where(eq(identityResolutions.id, staged.id));
    expect(afterRow.resolvedAt).not.toBeNull();
  });
});

describe("identity resolution: queue listing", () => {
  it("lists open and resolved rows with sanitized fields only", async () => {
    const { su, staged } = await stageIdentityRow("batch-resolve-list");
    const open = await listIdentities(su, "open");
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(staged.id);
    const openJson = JSON.stringify(open);
    expect(openJson).not.toContain('"payload"');
    expect(openJson).not.toContain('"nicEnc"');

    const preview = await previewIdentity(su, staged.id);
    await resolveIdentity(su, staged.id, resolveInput(preview, fakeNic(), { idempotencyKey: "idem-list" }));

    expect(await listIdentities(su, "open")).toHaveLength(0);
    const resolved = await listIdentities(su, "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolvedAt).not.toBeNull();
    expect(resolved[0].resolution).toContain("IMPORTED");
    const all = await listIdentities(su, "all");
    expect(all).toHaveLength(1);
  });

  it("reports nothing for rows whose intake was trashed", async () => {
    const { programme, intake, su } = await fixture();
    const [legacy] = await db().insert(identityResolutions).values({
      source: "legacy_registry", reason: "No identifier on file",
      payload: { fullName: "Trashed Intake Person", intakeCode: "IA", programmeCode: "PA" },
      programmeId: programme.id,
    }).returning();
    const preview = await previewIdentity(su, legacy.id);
    await db().update(intakes).set({ trashedAt: new Date() }).where(eq(intakes.id, intake.id));
    await expect(resolveIdentity(su, legacy.id, resolveInput(preview, fakeNic())))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db().select().from(students)).toHaveLength(0);
  });
});
