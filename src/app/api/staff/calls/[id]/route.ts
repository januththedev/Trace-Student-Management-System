import { json, route } from "@/server/http";
import { requireStaff } from "@/server/auth/staff";
import { getCallCard } from "@/server/services/followups/queue";

export const GET = route(async (req, ctx) => json(await getCallCard(await requireStaff(req), (await ctx.params).id)));
