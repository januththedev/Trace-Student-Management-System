import { requireStaff } from "@/server/auth/staff";
import { route, json, parseBody, idempotencyKey } from "@/server/http";
import { feedbackListSchema, feedbackSchema, listFeedback, submitFeedback } from "@/server/services/support/feedback";

export const GET = route(async req => {
  const p = await requireStaff(req);
  return json(await listFeedback(p, feedbackListSchema.parse(Object.fromEntries(req.nextUrl.searchParams))));
});
export const POST = route(async (req, { requestId }) => {
  const p = await requireStaff(req);
  return json(await submitFeedback(p, await parseBody(req, feedbackSchema), idempotencyKey(req), requestId), { status: 201 });
});
