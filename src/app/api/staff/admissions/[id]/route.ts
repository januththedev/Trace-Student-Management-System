import { z } from "zod";
import { requireStaff } from "@/server/auth/staff";
import { fail, json, parseBody, route } from "@/server/http";
import { decideAdmission, decisionInput } from "@/server/services/enrolments";
export const POST = route(async (req,ctx)=>{const p=await requireStaff(req);const {id}=await ctx.params;if(!z.string().uuid().safeParse(id).success)throw fail.notFound();
 const r=await decideAdmission(p,{...await parseBody(req,decisionInput.omit({admissionId:true})),admissionId:id},ctx.requestId);
 return json({enrolmentId:r.enrolmentId,replayed:r.replayed}); });
