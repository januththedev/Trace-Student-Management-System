import { requireStudent } from "@/server/auth/student";
import { route, json, parseBody, idempotencyKey } from "@/server/http";
import { finalizeSubmission, studentDashboard, submitInput } from "@/server/services/submissions";

export const GET = route(async () => {
  const p = await requireStudent();
  return json(await studentDashboard(p));
});

/** Finalize: validates the uploaded object server-side and commits the submission. */
export const POST = route(async (req) => {
  const p = await requireStudent(req);
  const key = idempotencyKey(req);
  const r = await finalizeSubmission(p, await parseBody(req, submitInput), key);
  return json({ submissionId: r.submission.id, status: r.submission.status, warnings: r.warnings, replayed: r.replayed }, { status: r.replayed ? 200 : 201 });
});
