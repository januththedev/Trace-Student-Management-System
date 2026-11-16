import { requireStudent } from "@/server/auth/student";
import { route, json, fail } from "@/server/http";
import { MAX_BYTES, uploadToIntent } from "@/server/services/submissions";

/** Read the request body as a stream, aborting as soon as it exceeds `cap` bytes. */
async function readCapped(req: Request, cap: number): Promise<Buffer> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw fail.validation("The file is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** Private object upload for an intent bound to the session's enrolment. */
export const PUT = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const p = await requireStudent(req);
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail.notFound();
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES()) throw fail.validation("The file is too large.");
  const buf = await readCapped(req, MAX_BYTES());
  return json(await uploadToIntent(p, id, buf));
});
