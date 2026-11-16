import { requireStaff } from "@/server/auth/staff";
import { json, route } from "@/server/http";
import { previewIdentity } from "@/server/services/imports/identity-resolution";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const p = await requireStaff(req);
  const { id } = await ctx.params;
  return json(await previewIdentity(p, id));
});
