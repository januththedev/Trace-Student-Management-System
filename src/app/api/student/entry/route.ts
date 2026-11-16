import { z } from "zod";
import { db } from "@/db/client";
import { audit } from "@/server/audit";
import { NEUTRAL_ENTRY_MESSAGE, matchEnrolment, rememberDevice, startStudentSession } from "@/server/auth/student";
import { route, json, parseBody, fail } from "@/server/http";
import { STUDENT_ENTRY_LIMITS, clientIp, hit } from "@/server/ratelimit";
import { normalizeNic } from "@/lib/nic";

const body = z.object({ nic: z.string().max(40), intakeId: z.string().max(40), remember: z.boolean().default(false) });

/**
 * NIC + course/intake entry. No OTP/password by requirement. Every failure returns the same
 * neutral message/status so the response never reveals whether an NIC exists.
 */
export const POST = route(async (req, { requestId }) => {
  const input = await parseBody(req, body);
  const ip = clientIp(req);
  const byIp = await hit("entry-ip", ip, STUDENT_ENTRY_LIMITS.perIp.limit, STUDENT_ENTRY_LIMITS.perIp.windowSec);
  const byId = await hit("entry-id", `${normalizeNic(input.nic)}|${input.intakeId}`, STUDENT_ENTRY_LIMITS.perIdentity.limit, STUDENT_ENTRY_LIMITS.perIdentity.windowSec);
  if (!byIp.allowed || !byId.allowed) throw fail.throttled();

  const m = await matchEnrolment(input.nic, input.intakeId);
  await audit(db(), { actorType: "STUDENT", actorId: m?.studentId ?? null, action: m ? "student.entry.ok" : "student.entry.fail", entityType: "student_entry", intakeId: /^[0-9a-f-]{36}$/i.test(input.intakeId) ? input.intakeId : null, requestId });
  if (!m) return json({ ok: false, message: NEUTRAL_ENTRY_MESSAGE }, { status: 404 });
  await startStudentSession(m);
  if (input.remember) await rememberDevice(m.studentId, m.intakeId, m.maskedNic);
  return json({ ok: true });
});
