import { loginSchema, loginStaff } from "@/server/services/governance/auth";
import { assertPublicOrigin } from "@/server/services/governance/public-origin";
import { setStaffCookie } from "@/server/auth/staff";
import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { clientIp } from "@/server/ratelimit";

export const POST = route(async req => {
  assertPublicOrigin(req);
  const { token } = await loginStaff(await parseBody(req, loginSchema), idempotencyKey(req), clientIp(req));
  await setStaffCookie(token);
  return json({ ok: true });
});
