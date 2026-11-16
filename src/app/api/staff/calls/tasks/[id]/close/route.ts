import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { requireStaff } from "@/server/auth/staff";
import { closeTask, closeTaskSchema } from "@/server/services/followups/tasks";

export const POST = route(async (req, ctx) => json(await closeTask(await requireStaff(req), (await ctx.params).id, await parseBody(req, closeTaskSchema), idempotencyKey(req))));
