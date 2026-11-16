import { inviteSchema, inviteStaff } from "@/server/services/governance";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";

export const POST = route(async req => json(await inviteStaff(await requireStaff(req), await parseBody(req, inviteSchema), idempotencyKey(req)), { status: 201 }));
