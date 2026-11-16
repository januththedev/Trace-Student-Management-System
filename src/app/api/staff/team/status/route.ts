import { changeStaffStatus, statusSchema } from "@/server/services/governance";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";

export const POST = route(async req => json(await changeStaffStatus(await requireStaff(req), await parseBody(req, statusSchema), idempotencyKey(req))));
