import { z } from "zod";
import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { fail, json, route } from "@/server/http";
import { enrolmentDetail } from "@/server/services/enrolments";
export const GET=route(async(req,ctx)=>{ const p=await requireStaff(req);const {id}=await ctx.params;if(!z.string().uuid().safeParse(id).success)throw fail.notFound();const d=await enrolmentDetail(db(),p,id);
 return json({...d,student:{id:d.student.id,ref:d.student.ref,fullName:d.student.fullName,nicMasked:d.student.nicMasked}}); });
