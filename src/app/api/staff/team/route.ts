import { listTeam } from "@/server/services/governance";
import { requireStaff } from "@/server/auth/staff";
import { json, route } from "@/server/http";

export const GET = route(async req => json(await listTeam(await requireStaff(req))));
