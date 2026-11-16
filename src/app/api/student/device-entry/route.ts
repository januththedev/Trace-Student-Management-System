import { cookies } from "next/headers";
import { z } from "zod";
import { DEVICE_COOKIE, NEUTRAL_ENTRY_MESSAGE, matchByDevice, startStudentSession } from "@/server/auth/student";
import { route, json, parseBody, fail } from "@/server/http";
import { STUDENT_ENTRY_LIMITS, clientIp, hit } from "@/server/ratelimit";

/** Re-entry using the remembered (HttpOnly, revocable) device token + a public course selection. */
export const POST = route(async (req) => {
  const { intakeId } = await parseBody(req, z.object({ intakeId: z.string().max(40) }));
  const byIp = await hit("entry-ip", clientIp(req), STUDENT_ENTRY_LIMITS.perIp.limit, STUDENT_ENTRY_LIMITS.perIp.windowSec);
  if (!byIp.allowed) throw fail.throttled();
  const m = await matchByDevice((await cookies()).get(DEVICE_COOKIE)?.value, intakeId);
  if (!m) return json({ ok: false, message: NEUTRAL_ENTRY_MESSAGE }, { status: 404 });
  await startStudentSession(m);
  return json({ ok: true });
});
