import { z } from "zod";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { refreshStorageUsageForStaff } from "@/server/services/storage-usage";

export const POST = route(async (req, ctx) => {
  const p = await requireStaff(req);
  await parseBody(req, z.object({}).strict());
  return json(await refreshStorageUsageForStaff(p, idempotencyKey(req), ctx.requestId));
});
