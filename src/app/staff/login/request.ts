"use client";

// Keep a request key after a network interruption so retrying the same action is safe.
const pending = new Map<string, string>();
export async function postStaff<T = { ok: boolean }>(url: string, body: unknown): Promise<T> {
  const payload = JSON.stringify(body);
  const signature = `${url}:${payload}`;
  const key = pending.get(signature) ?? crypto.randomUUID();
  pending.set(signature, key);
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-csrf-token": csrf, "Idempotency-Key": key }, body: payload });
  } catch { throw new Error("Connection interrupted. Check your connection and try again."); }
  const result = await response.json();
  pending.delete(signature);
  if (!response.ok) throw new Error(result.error?.message ?? "The action could not be completed. Please try again.");
  return result as T;
}
