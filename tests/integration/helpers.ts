/**
 * Integration-test helpers. Runs against the REAL PostgreSQL in TEST_DATABASE_URL (wiped per test file).
 * Factories create synthetic data only.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import path from "node:path";
import postgres from "postgres";
import { expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for integration tests");
/**
 * Each test FILE gets its own database (t2t_test_<file>) so parallel runs by several agents/CI
 * jobs never truncate each other's data. Created and migrated on first use.
 */
const testFile = path.basename(expect.getState().testPath ?? "shared").replace(/\.test\.ts$/, "");
const dbName = `t2t_test_${testFile.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`.slice(0, 60);
const adminUrl = new URL(process.env.TEST_DATABASE_URL);
const fileUrl = new URL(process.env.TEST_DATABASE_URL);
fileUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = fileUrl.toString();
let ensured = false;

async function ensureDatabase() {
  if (ensured) return;
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`create database "${dbName}"`); } catch (e) { if ((e as { code?: string }).code !== "42P04") throw e; }
  await admin.end();
  const c = postgres(fileUrl.toString(), { max: 1, onnotice: () => {} });
  await migrate(drizzle(c), { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  await c.end();
  ensured = true;
}

import { sql } from "drizzle-orm";
import { db, closeDb } from "@/db/client";
import {
  enrolments, feePlanItems, feePlanVersions, instalments, intakes, programmes, staffAccounts, staffScopes, students,
} from "@/db/schema";
import { encryptNic, nicLookup } from "@/lib/crypto";
import type { StaffPrincipal, Capability } from "@/server/auth/policy";

export async function resetDb() {
  await ensureDatabase();
  const rows = await db().execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = rows.map((r) => `"${r.tablename}"`).filter((n) => n !== '"governance_lock"');
  // Append-only triggers block DELETE but not TRUNCATE.
  await db().execute(sql.raw(`truncate ${names.join(", ")} restart identity cascade`));
  await db().execute(sql`update governance_lock set bootstrapped_at = null`);
}

export { closeDb };

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function makeProgramme(over: Partial<typeof programmes.$inferInsert> = {}) {
  const [p] = await db().insert(programmes).values({ code: `P${uniq()}`, name: `Programme ${uniq()}`, ...over }).returning();
  return p;
}

export async function makeIntake(programmeId: string, over: Partial<typeof intakes.$inferInsert> = {}) {
  const [i] = await db().insert(intakes).values({ programmeId, code: `I${uniq()}`, label: `Batch ${uniq()}`, startDate: "2026-01-01", ...over }).returning();
  return i;
}

/** Generates a syntactically valid synthetic NEW-format NIC (12 digits). */
export function fakeNic(): string {
  const year = 1990 + Math.floor(Math.random() * 15);
  const day = String(1 + Math.floor(Math.random() * 365)).padStart(3, "0");
  return `${year}${day}${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;
}

export async function makeStudent(over: Partial<typeof students.$inferInsert> & { nic?: string } = {}) {
  const nic = over.nic ?? fakeNic();
  const rest = { ...over }; delete rest.nic;
  const [s] = await db().insert(students).values({
    ref: `T2T-${uniq().toUpperCase()}`, fullName: "Test Student", phone: "+94770000000",
    nicEnc: encryptNic(nic), nicLookup: nicLookup(nic), nicMasked: `•••••••••${nic.slice(-3)}`, ...rest,
  }).returning();
  return { ...s, nic };
}

export interface ScheduleItem { amountMinor: number; dueDate: string; label?: string }

/** Enrolment with explicit instalments (sequence = array order). */
export async function makeEnrolment(studentId: string, intakeId: string, schedule: ScheduleItem[], over: Partial<typeof enrolments.$inferInsert> = {}) {
  const [fv] = await db().insert(feePlanVersions).values({ intakeId, versionNo: 1 + Math.floor(Math.random() * 1e6), isCurrent: false }).returning();
  const items = schedule.length ? await db().insert(feePlanItems).values(schedule.map((s, i) => ({ versionId: fv.id, sequence: i + 1, periodLabel: s.label ?? `Instalment ${i + 1}`, amountMinor: s.amountMinor, dueDate: s.dueDate }))).returning() : [];
  const [e] = await db().insert(enrolments).values({ studentId, intakeId, feePlanVersionId: fv.id, ...over }).returning();
  const inst = schedule.length ? await db().insert(instalments).values(schedule.map((s, i) => ({
    enrolmentId: e.id, feePlanItemId: items[i].id, sequence: i + 1, periodLabel: s.label ?? `Instalment ${i + 1}`, originalChargeMinor: s.amountMinor, dueDate: s.dueDate,
  }))).returning() : [];
  return { enrolment: e, instalments: inst.sort((a, b) => a.sequence - b.sequence) };
}

export async function makeStaff(role: "SUPER_ADMIN" | "ADMIN", opts: { capabilities?: Capability[]; scopes?: { programmeId: string; intakeId?: string | null }[]; email?: string } = {}) {
  const [a] = await db().insert(staffAccounts).values({ email: opts.email ?? `staff-${uniq()}@example.test`, name: `${role} ${uniq()}`, role, capabilities: opts.capabilities ?? [] }).returning();
  if (opts.scopes?.length) await db().insert(staffScopes).values(opts.scopes.map((s) => ({ staffId: a.id, programmeId: s.programmeId, intakeId: s.intakeId ?? null })));
  return a;
}

/** Build an in-memory principal for service-level tests (bypasses cookies). */
export function principalOf(a: typeof staffAccounts.$inferSelect, scopes: { programmeId: string; intakeId?: string | null }[] = []): StaffPrincipal {
  return {
    kind: "staff", id: a.id, name: a.name, email: a.email, role: a.role,
    capabilities: new Set(a.capabilities as Capability[]), scopes: scopes.map((s) => ({ programmeId: s.programmeId, intakeId: s.intakeId ?? null })),
    authVersion: a.authVersion, sessionId: randomUUID(), csrfSecret: "test",
  };
}

/** Pin "now" for date-sensitive logic. */
export function pinNow(iso: string) { process.env.T2T_FAKE_NOW = iso; }
export function unpinNow() { delete process.env.T2T_FAKE_NOW; }
