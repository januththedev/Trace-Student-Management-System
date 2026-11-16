import { z } from "zod";
import { requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { applyFeePlan, feeApplyInput, feePlanCandidates, feePreviewInput, previewFeePlan } from "@/server/services/fee-plan-application";

export const GET = route(async req => {
  const p = await requireStaff();
  const q = z.object({ versionId: z.string().uuid(), after: z.string().uuid().optional() }).parse(Object.fromEntries(req.nextUrl.searchParams));
  return json(await feePlanCandidates(p, q.versionId, q.after));
});
export const POST = route(async (req, ctx) => {
  const p = await requireStaff(req);
  const input = await parseBody(req, z.discriminatedUnion("action", [feePreviewInput.extend({ action: z.literal("preview") }), feeApplyInput.extend({ action: z.literal("apply") })]));
  if (input.action === "preview") return json(await previewFeePlan(p, input));
  return json(await applyFeePlan(p, input, idempotencyKey(req), ctx.requestId));
});
