import { requireStaff } from "@/server/auth/staff";
import { route, json, parseBody, idempotencyKey } from "@/server/http";
import { updateFeedback, updateFeedbackSchema } from "@/server/services/support/feedback";

export const PATCH = route(async (req, { params, requestId }) => {
  const p = await requireStaff(req);
  const { id } = await params;
  return json(await updateFeedback(p, id, await parseBody(req, updateFeedbackSchema), idempotencyKey(req), requestId));
});
