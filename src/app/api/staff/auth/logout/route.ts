import { logoutStaff } from "@/server/services/governance/auth";
import { clearStaffCookie, requireStaff } from "@/server/auth/staff";
import { idempotencyKey, json, route } from "@/server/http";

export const POST = route(async req => {
  const result = await logoutStaff(await requireStaff(req), idempotencyKey(req));
  await clearStaffCookie();
  return json(result);
});
