import { requireStudent } from "@/server/auth/student";
import { route, json, parseBody } from "@/server/http";
import { createUploadIntent, intentInput } from "@/server/services/submissions";

export const POST = route(async (req) => {
  const p = await requireStudent(req);
  return json(await createUploadIntent(p, await parseBody(req, intentInput)));
});
