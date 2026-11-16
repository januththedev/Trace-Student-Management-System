import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { json, parseBody, route } from "@/server/http";
import { admissionDirectory } from "@/server/services/directory";
import { createAdmission, admissionInput } from "@/server/services/enrolments";
export const GET = route(async req=>json(await admissionDirectory(db(),await requireStaff(req),req.nextUrl.searchParams.get("state")??undefined)));
export const POST = route(async (req,ctx)=>{ const a=await createAdmission(await requireStaff(req),await parseBody(req,admissionInput),ctx.requestId); return json({id:a.id,version:a.version}); });
