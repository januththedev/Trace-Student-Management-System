"use client";
/** Browser fetch helper: CSRF header from <meta name="csrf-token">, Idempotency-Key, no caching, typed errors. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) { super(message); }
}

export function newIdemKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function csrf(): string {
  return typeof document === "undefined" ? "" : document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
}

export async function api<T>(url: string, init: { method?: string; body?: unknown; idempotencyKey?: string; raw?: BodyInit; contentType?: string } = {}): Promise<T> {
  if (typeof navigator !== "undefined" && !navigator.onLine && init.method && init.method !== "GET") {
    throw new ApiError(0, "OFFLINE", "You are offline. This action needs a connection and was not queued.");
  }
  const headers: Record<string, string> = { "x-csrf-token": csrf() };
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  let body: BodyInit | undefined;
  if (init.raw !== undefined) { body = init.raw; headers["Content-Type"] = init.contentType ?? "application/octet-stream"; }
  else if (init.body !== undefined) { body = JSON.stringify(init.body); headers["Content-Type"] = "application/json"; }
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? "GET", headers, body, cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "NETWORK", "Network problem. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null)?.error;
    if (res.status === 401) throw new ApiError(401, "UNAUTHENTICATED", e?.message ?? "Your session has ended. Please sign in again.");
    throw new ApiError(res.status, e?.code ?? "ERROR", e?.message ?? "Something went wrong.", e?.details);
  }
  return data as T;
}
