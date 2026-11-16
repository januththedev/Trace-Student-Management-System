import { z } from "zod";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { intakeInput, saveIntake } from "@/server/services/directory";
export const POST = route(async (req, ctx) => { const p=await requireStaff(req); const {id}=await ctx.params;
 const input=await parseBody(req, z.preprocess(raw=>raw&&typeof raw==="object"&&!Array.isArray(raw)?{...raw,programmeId:id}:raw,intakeInput));
 return json(await saveIntake(p, {...input, programmeId:id}, idempotencyKey(req), ctx.requestId)); });
