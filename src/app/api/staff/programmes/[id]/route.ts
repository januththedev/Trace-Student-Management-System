import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { programmeDetail, programmeInput, saveProgramme } from "@/server/services/directory";
export const GET = route(async (req, ctx) => json(await programmeDetail(db(), await requireStaff(req), (await ctx.params).id)));
export const PATCH = route(async (req, ctx) => { const p=await requireStaff(req); const {id}=await ctx.params;
 return json(await saveProgramme(p, {...await parseBody(req, programmeInput.omit({id:true})), id}, idempotencyKey(req), ctx.requestId)); });
