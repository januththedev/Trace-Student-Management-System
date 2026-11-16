import { z } from "zod";
import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { enrolmentInScope } from "@/server/auth/policy";
import { route, json, parseBody, idempotencyKey, fail } from "@/server/http";
import {
  approveInput, approveSubmission, claimLease, correctApproval, correctionInput, previewApproval, previewCorrection,
  rejectInput, rejectSubmission, releaseLease, reviewContext, undoDecision, undoInput,
} from "@/server/services/review";
import { assetBytes } from "@/server/services/submissions";

type Ctx = { params: Promise<{ id: string; action: string }> };
const uuid = (s: string) => { if (!/^[0-9a-f-]{36}$/i.test(s)) throw fail.notFound(); return s; };

/** GET: context | preview | evidence | correction-preview */
export const GET = route<Ctx>(async (req, ctx) => {
  const p = await requireStaff();
  const { id: raw, action } = await ctx.params;
  const id = uuid(raw);
  const sp = new URL(req.url).searchParams;
  switch (action) {
    case "context":
      return json(await reviewContext(db(), p, id));
    case "preview": {
      const confirmed = sp.get("confirmed");
      const r = await previewApproval(db(), p, id, { confirmedMinor: confirmed ? z.coerce.number().int().positive().parse(confirmed) : undefined, spillOver: sp.get("spill") === "1" });
      return json({ amountMinor: r.amountMinor, plan: r.plan });
    }
    case "correction-preview":
      return json(await previewCorrection(db(), p, id));
    case "evidence": {
      const variant = sp.get("v") === "original" ? "original" : "preview";
      const { bytes, mime } = await assetBytes(db(), id, variant, async (enrolmentId) => { await enrolmentInScope(db(), p, enrolmentId); return true; });
      return new Response(new Uint8Array(bytes), { headers: {
        "Content-Type": mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "Referrer-Policy": "no-referrer",
      } });
    }
    default:
      throw fail.notFound();
  }
});

/** POST: approve | reject | undo | correct | lease */
export const POST = route<Ctx>(async (req, ctx) => {
  const p = await requireStaff(req);
  const { id: raw, action } = await ctx.params;
  const id = uuid(raw);
  const { requestId } = ctx;
  switch (action) {
    case "approve": {
      const body = await parseBody(req, approveInput.omit({ submissionId: true }));
      return json(await approveSubmission(p, { ...body, submissionId: id }, idempotencyKey(req), requestId));
    }
    case "reject": {
      const body = await parseBody(req, rejectInput.omit({ submissionId: true }));
      return json(await rejectSubmission(p, { ...body, submissionId: id }, idempotencyKey(req), requestId));
    }
    case "undo": {
      const body = await parseBody(req, undoInput.omit({ submissionId: true }));
      return json(await undoDecision(p, { ...body, submissionId: id }, requestId));
    }
    case "correct": {
      const body = await parseBody(req, correctionInput.omit({ submissionId: true }));
      return json(await correctApproval(p, { ...body, submissionId: id }, requestId));
    }
    case "lease":
      return json(await claimLease(p, id));
    case "release":
      await releaseLease(p, id);
      return json({ ok: true });
    default:
      throw fail.notFound();
  }
});
