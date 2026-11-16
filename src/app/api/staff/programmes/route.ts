import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { listProgrammes, programmeInput, saveProgramme } from "@/server/services/directory";
export const GET = route(async req => json(await listProgrammes(db(), await requireStaff(req))));
export const POST = route(async (req, ctx) => json(await saveProgramme(await requireStaff(req), await parseBody(req, programmeInput.omit({id:true,expectedVersion:true})), idempotencyKey(req), ctx.requestId)));
