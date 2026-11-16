import { requireStudent } from "@/server/auth/student";
import { route, json } from "@/server/http";
import { markNotificationsRead } from "@/server/services/submissions";

export const POST = route(async (req) => {
  const p = await requireStudent(req);
  await markNotificationsRead(p);
  return json({ ok: true });
});
