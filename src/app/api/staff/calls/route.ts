import { json, route } from "@/server/http";
import { requireStaff } from "@/server/auth/staff";
import { getCallQueue } from "@/server/services/followups/queue";

export const GET = route(async req => json(await getCallQueue(await requireStaff(req), Object.fromEntries(req.nextUrl.searchParams))));
