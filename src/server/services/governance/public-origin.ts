import "server-only";
import { fail } from "@/server/http";

/** Public sign-in/invitation actions have no session CSRF secret yet. */
export function assertPublicOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (req.headers.get("sec-fetch-site") === "cross-site") throw fail.forbidden();
  if (origin) {
    // Next may expose an internal hostname in req.url behind a proxy/dev server.
    // Match the incoming Host, just like the shared staff CSRF guard.
    try { if (new URL(origin).host !== (req.headers.get("host") ?? new URL(req.url).host)) throw fail.forbidden(); }
    catch { throw fail.forbidden(); }
  }
}
