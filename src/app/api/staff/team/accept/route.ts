import { acceptInvitation, acceptSchema } from "@/server/services/governance";
import { assertPublicOrigin } from "@/server/services/governance/public-origin";
import { idempotencyKey, json, parseBody, route } from "@/server/http";

export const POST = route(async req => {
  assertPublicOrigin(req);
  return json(await acceptInvitation(await parseBody(req, acceptSchema), idempotencyKey(req)));
});
