import { z } from "zod";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { resolveIdentity, resolveIdentitySchema } from "@/server/services/imports/identity-resolution";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const p = await requireStaff(req);
  const { id } = await ctx.params;
  const body = await parseBody(req, resolveIdentitySchema.extend({ expectedHash: z.string().min(16).max(200) }));
  return json(await resolveIdentity(p, id, { ...body, idempotencyKey: idempotencyKey(req) }));
});
