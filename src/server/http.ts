import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { randomUUID } from "node:crypto";

/** Error taxonomy (spec §14). Messages never reveal private existence. */
export type ErrorCode =
  | "VALIDATION" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT"
  | "STALE" | "THROTTLED" | "DEPENDENCY_UNAVAILABLE" | "IDEMPOTENCY_MISMATCH" | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  STALE: 409, THROTTLED: 429, DEPENDENCY_UNAVAILABLE: 503, IDEMPOTENCY_MISMATCH: 422, INTERNAL: 500,
};

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
  get status() { return STATUS[this.code]; }
}

export const fail = {
  validation: (m: string, d?: Record<string, unknown>) => new AppError("VALIDATION", m, d),
  unauth: () => new AppError("UNAUTHENTICATED", "Please sign in again."),
  forbidden: () => new AppError("FORBIDDEN", "You do not have access to this action."),
  /** Same response for missing and out-of-scope records: no existence leak. */
  notFound: () => new AppError("NOT_FOUND", "Not found."),
  conflict: (m: string, d?: Record<string, unknown>) => new AppError("CONFLICT", m, d),
  stale: (m: string, d?: Record<string, unknown>) => new AppError("STALE", m, d),
  throttled: () => new AppError("THROTTLED", "Too many attempts. Please wait and try again."),
};

export function errorBody(e: unknown, requestId: string) {
  if (e instanceof AppError) return { status: e.status, body: { error: { code: e.code, message: e.message, details: e.details, requestId } } };
  if (e instanceof ZodError) {
    return { status: 400, body: { error: { code: "VALIDATION", message: "Some fields are invalid.", details: { issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, requestId } } };
  }
  console.error(`[t2t] request ${requestId} failed`, e instanceof Error ? e.message : e);
  return { status: 500, body: { error: { code: "INTERNAL", message: "Something went wrong. Please try again.", requestId } } };
}

export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
} as const;

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return NextResponse.json(data, { status: init.status ?? 200, headers: { ...PRIVATE_HEADERS, ...init.headers } });
}

export type Handler<C> = (req: NextRequest, ctx: C & { requestId: string }) => Promise<Response>;

/** Wrap a route handler: request id, uniform errors, private no-store caching. */
export function route<C = { params: Promise<Record<string, string>> }>(h: Handler<C>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    try {
      const res = await h(req, { ...ctx, requestId });
      res.headers.set("x-request-id", requestId);
      if (!res.headers.has("Cache-Control")) res.headers.set("Cache-Control", PRIVATE_HEADERS["Cache-Control"]);
      return res;
    } catch (e) {
      const { status, body } = errorBody(e, requestId);
      return NextResponse.json(body, { status, headers: { ...PRIVATE_HEADERS, "x-request-id": requestId } });
    }
  };
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw fail.validation("Request body must be JSON."); }
  return schema.parse(raw);
}

export function idempotencyKey(req: Request): string {
  const k = req.headers.get("idempotency-key");
  if (!k || k.length < 8 || k.length > 200) throw fail.validation("Idempotency-Key header is required.");
  return k;
}
