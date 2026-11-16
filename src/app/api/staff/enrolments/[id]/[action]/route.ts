import { z } from "zod";
import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { enrolmentInScope, requireCap } from "@/server/auth/policy";
import { fail, idempotencyKey, json, parseBody, route } from "@/server/http";
import { awardInput, creditInput, withdrawalInput, previewExemption, grantExemption, revokeExemption, applyCredit, previewWithdrawal, withdrawEnrolment } from "@/server/services/enrolments";
import { correctionInput, previewCorrection, correctApproval } from "@/server/services/review";
import { exemptionAwards, paymentSubmissions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
export const POST=route(async(req,ctx)=>{
 const p=await requireStaff(req); const {id,action}=await ctx.params; if(!z.string().uuid().safeParse(id).success)throw fail.notFound(); await enrolmentInScope(db(),p,id);
 if(action==="exemption-preview" || action==="exemptions") { const input={...await parseBody(req,z.preprocess(raw=>raw&&typeof raw==="object"&&!Array.isArray(raw)?{...raw,enrolmentId:id}:raw,awardInput)),enrolmentId:id};
  return json(action==="exemption-preview" ? await previewExemption(db(),p,input) : await grantExemption(p,input,idempotencyKey(req),ctx.requestId)); }
 if(action==="credit") return json(await applyCredit(p,{...await parseBody(req,z.preprocess(raw=>raw&&typeof raw==="object"&&!Array.isArray(raw)?{...raw,enrolmentId:id}:raw,creditInput.safeExtend({expectedEnrolmentVersion:z.number().int().positive()}))),enrolmentId:id},idempotencyKey(req),ctx.requestId));
 if(action==="withdrawal-preview" || action==="withdrawal") { const input={...await parseBody(req,withdrawalInput.omit({enrolmentId:true})),enrolmentId:id};
  return json(action==="withdrawal-preview" ? await previewWithdrawal(db(),p,id,input.effectiveDate) : await withdrawEnrolment(p,input,idempotencyKey(req),ctx.requestId)); }
 if(action==="revoke-exemption") { requireCap(p,"exemptions.manage"); const input=await parseBody(req,z.object({awardId:z.string().uuid(),reason:z.string().trim().min(3).max(1000),expectedEnrolmentVersion:z.number().int().positive()}));
  const [a]=await db().select({id:exemptionAwards.id}).from(exemptionAwards).where(and(eq(exemptionAwards.id,input.awardId),eq(exemptionAwards.enrolmentId,id))); if(!a) throw fail.notFound();
  return json(await revokeExemption(p,input,ctx.requestId)); }
 if(action==="correction-preview" || action==="correction") { requireCap(p,"review.correction");
  const input=await parseBody(req,correctionInput); const [s]=await db().select({id:paymentSubmissions.id}).from(paymentSubmissions).where(and(eq(paymentSubmissions.id,input.submissionId),eq(paymentSubmissions.enrolmentId,id))); if(!s) throw fail.notFound();
  return json(action==="correction-preview" ? await previewCorrection(db(),p,input.submissionId) : await correctApproval(p,input,ctx.requestId)); }
 throw fail.notFound();
});
