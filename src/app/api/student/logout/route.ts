import { z } from "zod";
import { endStudentSession } from "@/server/auth/student";
import { route, json, parseBody } from "@/server/http";

/** Logout ends the session; `forgetDevice` also revokes the remembered-device token. */
export const POST = route(async (req) => {
  const { forgetDevice } = await parseBody(req, z.object({ forgetDevice: z.boolean().default(false) }));
  await endStudentSession({ forgetDevice });
  return json({ ok: true }, { headers: { "Clear-Site-Data": forgetDevice ? '"cache", "storage"' : '"cache"' } });
});
