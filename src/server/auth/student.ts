import "server-only";
import { cookies } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { enrolments, intakes, programmes, rememberedDevices, studentSessions, students } from "@/db/schema";
import { hashToken, newToken, nicLookup, safeEqual } from "@/lib/crypto";
import { isValidNicFormat, maskNic, normalizeNic } from "@/lib/nic";
import { now } from "@/lib/time";
import { fail } from "@/server/http";

export const STUDENT_COOKIE = "t2t_student";
export const DEVICE_COOKIE = "t2t_device";
export const NEUTRAL_ENTRY_MESSAGE = "We could not find an eligible enrolment.";
const DEVICE_DAYS = 30;

const idleMin = () => Math.min(240, Math.max(5, Number(process.env.STUDENT_IDLE_MINUTES ?? 30)));
const absMin = () => Math.min(1440, Math.max(30, Number(process.env.STUDENT_ABSOLUTE_MINUTES ?? 720)));

export interface StudentPrincipal {
  kind: "student";
  sessionId: string;
  studentId: string;
  enrolmentId: string;
  intakeId: string;
  programmeId: string;
  csrfSecret: string;
}

/** Eligibility: active student + ACTIVE enrolment + live, active intake and programme. */
async function eligibleEnrolment(tx: DbOrTx, studentId: string, intakeId: string) {
  const [row] = await tx.select({ enrolmentId: enrolments.id, programmeId: intakes.programmeId })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      eq(enrolments.studentId, studentId), eq(enrolments.intakeId, intakeId), eq(enrolments.status, "ACTIVE"),
      eq(students.status, "ACTIVE"), eq(intakes.status, "ACTIVE"), eq(programmes.status, "ACTIVE"),
      isNull(intakes.trashedAt), isNull(programmes.trashedAt),
    ));
  return row ?? null;
}

/** Match NIC + intake. Returns null for every failure mode (invalid/unknown/inactive/mismatch). */
export async function matchEnrolment(rawNic: string, intakeId: string) {
  const nic = normalizeNic(rawNic);
  if (!isValidNicFormat(nic) || !/^[0-9a-f-]{36}$/i.test(intakeId)) return null;
  const [s] = await db().select({ id: students.id }).from(students).where(eq(students.nicLookup, nicLookup(nic)));
  if (!s) return null;
  const e = await eligibleEnrolment(db(), s.id, intakeId);
  return e ? { studentId: s.id, intakeId, ...e, maskedNic: maskNic(nic) } : null;
}

export async function matchByDevice(deviceToken: string | undefined, intakeId: string) {
  if (!deviceToken || !/^[0-9a-f-]{36}$/i.test(intakeId)) return null;
  const [d] = await db().select().from(rememberedDevices).where(and(
    eq(rememberedDevices.tokenHash, hashToken(deviceToken, "device")), isNull(rememberedDevices.revokedAt), gt(rememberedDevices.expiresAt, now()),
  ));
  if (!d) return null;
  const e = await eligibleEnrolment(db(), d.studentId, intakeId);
  return e ? { studentId: d.studentId, intakeId, ...e, maskedNic: d.maskedNic, deviceId: d.id } : null;
}

export async function startStudentSession(m: { studentId: string; enrolmentId: string }) {
  // A new match replaces any open session in this browser (one session = one enrolment).
  const prior = (await cookies()).get(STUDENT_COOKIE)?.value;
  if (prior) await db().update(studentSessions).set({ revokedAt: now(), revokeReason: "replaced" }).where(and(eq(studentSessions.tokenHash, hashToken(prior, "student-session")), isNull(studentSessions.revokedAt)));
  const token = newToken();
  const t = now();
  await db().insert(studentSessions).values({
    tokenHash: hashToken(token, "student-session"), studentId: m.studentId, enrolmentId: m.enrolmentId, csrfSecret: newToken(24),
    idleExpiresAt: new Date(t.getTime() + idleMin() * 60_000), absoluteExpiresAt: new Date(t.getTime() + absMin() * 60_000),
  });
  (await cookies()).set(STUDENT_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: absMin() * 60 });
}

export async function rememberDevice(studentId: string, intakeId: string, maskedNic: string) {
  const jar = await cookies();
  const existing = jar.get(DEVICE_COOKIE)?.value;
  if (existing) await revokeDeviceToken(existing);
  const token = newToken();
  await db().insert(rememberedDevices).values({
    tokenHash: hashToken(token, "device"), studentId, lastIntakeId: intakeId, maskedNic,
    expiresAt: new Date(now().getTime() + DEVICE_DAYS * 86400_000),
  });
  jar.set(DEVICE_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: DEVICE_DAYS * 86400 });
}

export async function revokeDeviceToken(token: string) {
  await db().update(rememberedDevices).set({ revokedAt: now() }).where(and(eq(rememberedDevices.tokenHash, hashToken(token, "device")), isNull(rememberedDevices.revokedAt)));
}

/** Masked suggestion for the entry page; reads only the HttpOnly device cookie. */
export async function deviceSuggestion(): Promise<{ maskedNic: string; lastIntakeId: string | null } | null> {
  const token = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (!token) return null;
  const [d] = await db().select({ maskedNic: rememberedDevices.maskedNic, lastIntakeId: rememberedDevices.lastIntakeId }).from(rememberedDevices)
    .where(and(eq(rememberedDevices.tokenHash, hashToken(token, "device")), isNull(rememberedDevices.revokedAt), gt(rememberedDevices.expiresAt, now())));
  return d ?? null;
}

/**
 * Resolve the student session on every protected request and re-check eligibility so
 * withdrawal / deactivation / Trash invalidate access immediately.
 */
export async function currentStudent(): Promise<StudentPrincipal | null> {
  const token = (await cookies()).get(STUDENT_COOKIE)?.value;
  if (!token) return null;
  const t = now();
  const [s] = await db().select().from(studentSessions).where(and(
    eq(studentSessions.tokenHash, hashToken(token, "student-session")), isNull(studentSessions.revokedAt),
    gt(studentSessions.idleExpiresAt, t), gt(studentSessions.absoluteExpiresAt, t),
  ));
  if (!s) return null;
  const [e] = await db().select({ intakeId: enrolments.intakeId }).from(enrolments).where(eq(enrolments.id, s.enrolmentId));
  const ok = e ? await eligibleEnrolment(db(), s.studentId, e.intakeId) : null;
  if (!ok || ok.enrolmentId !== s.enrolmentId) {
    await db().update(studentSessions).set({ revokedAt: t, revokeReason: "ineligible" }).where(eq(studentSessions.id, s.id));
    return null;
  }
  if (t.getTime() - s.lastSeenAt.getTime() > 30_000) {
    await db().update(studentSessions).set({ lastSeenAt: t, idleExpiresAt: new Date(Math.min(t.getTime() + idleMin() * 60_000, s.absoluteExpiresAt.getTime())) }).where(eq(studentSessions.id, s.id));
  }
  return { kind: "student", sessionId: s.id, studentId: s.studentId, enrolmentId: s.enrolmentId, intakeId: e!.intakeId, programmeId: ok.programmeId, csrfSecret: s.csrfSecret };
}

export async function requireStudent(req?: Request): Promise<StudentPrincipal> {
  const p = await currentStudent();
  if (!p) throw fail.unauth();
  if (req && !["GET", "HEAD"].includes(req.method)) {
    if (!safeEqual(req.headers.get("x-csrf-token") ?? "", p.csrfSecret)) throw fail.forbidden();
  }
  return p;
}

export async function endStudentSession(opts: { forgetDevice: boolean }) {
  const jar = await cookies();
  const token = jar.get(STUDENT_COOKIE)?.value;
  if (token) await db().update(studentSessions).set({ revokedAt: now(), revokeReason: "logout" }).where(eq(studentSessions.tokenHash, hashToken(token, "student-session")));
  jar.delete(STUDENT_COOKIE);
  if (opts.forgetDevice) {
    const d = jar.get(DEVICE_COOKIE)?.value;
    if (d) await revokeDeviceToken(d);
    jar.delete(DEVICE_COOKIE);
  }
}
