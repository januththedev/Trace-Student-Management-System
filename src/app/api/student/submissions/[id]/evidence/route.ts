import { requireStudent } from "@/server/auth/student";
import { route, fail } from "@/server/http";
import { studentAsset } from "@/server/services/submissions";

/** Authenticated evidence delivery; ownership resolved from the session on every request. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const p = await requireStudent();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail.notFound();
  const variant = new URL(req.url).searchParams.get("v") === "original" ? "original" : "preview";
  const { bytes, mime } = await studentAsset(p, id, variant);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Referrer-Policy": "no-referrer",
      "Content-Disposition": mime === "application/pdf" ? "inline; filename=receipt.pdf" : "inline",
    },
  });
});
