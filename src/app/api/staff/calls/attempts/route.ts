import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { requireStaff } from "@/server/auth/staff";
import { attemptSchema, recordCallAttempt } from "@/server/services/followups/attempts";

export const POST = route(async req => json(await recordCallAttempt(await requireStaff(req), await parseBody(req, attemptSchema), idempotencyKey(req))));
