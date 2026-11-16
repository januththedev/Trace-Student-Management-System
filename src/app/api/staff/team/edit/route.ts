import { editStaff, editStaffSchema } from "@/server/services/governance";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";

export const POST = route(async req => json(await editStaff(await requireStaff(req), await parseBody(req, editStaffSchema), idempotencyKey(req))));
