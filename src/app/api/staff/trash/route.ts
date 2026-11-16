import { listTrash, mutateTrash, trashSchema } from "@/server/services/trash";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";

export const GET = route(async req => json(await listTrash(await requireStaff(req))));
export const POST = route(async req => json(await mutateTrash(await requireStaff(req), await parseBody(req, trashSchema), idempotencyKey(req))));
