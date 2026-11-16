import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { requireStaff } from "@/server/auth/staff";
import { leaseTask, leaseTaskSchema } from "@/server/services/followups/tasks";

export const POST = route(async (req, ctx) => json(await leaseTask(await requireStaff(req), (await ctx.params).id, await parseBody(req, leaseTaskSchema), idempotencyKey(req))));
