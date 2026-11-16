import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { contactInput, editStudent, studentDetail } from "@/server/services/directory";
export const GET = route(async (req, ctx) => json(await studentDetail(db(), await requireStaff(req), (await ctx.params).id)));
export const PATCH = route(async (req, ctx) => {
 const p = await requireStaff(req); const { id } = await ctx.params;
 const input = await parseBody(req, contactInput.omit({studentId:true}));
 return json(await editStudent(p, {...input, studentId:id}, idempotencyKey(req), ctx.requestId));
});
