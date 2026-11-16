import { z } from "zod";
import { requireStaff } from "@/server/auth/staff";
import { requireCap } from "@/server/auth/policy";
import { idempotencyKey, json, parseBody, PRIVATE_HEADERS, route } from "@/server/http";
import { importStudents, studentsImportTemplate } from "@/server/services/imports/students-import";
export const GET=route(async req=>{requireCap(await requireStaff(req),"imports.run");return new Response(studentsImportTemplate(),{headers:{...PRIVATE_HEADERS,"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="t2t-students-template.csv"'}});});
export const POST=route(async(req,ctx)=>{const p=await requireStaff(req);const v=await parseBody(req,z.object({csv:z.string().min(1).max(5_000_000),dryRun:z.boolean()}));
 return json(await importStudents(p,v.csv,{batchKey:idempotencyKey(req),dryRun:v.dryRun,requestId:ctx.requestId}));});
