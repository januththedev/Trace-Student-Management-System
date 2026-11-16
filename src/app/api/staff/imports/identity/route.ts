import { z } from "zod";
import { requireStaff } from "@/server/auth/staff";
import { json, route } from "@/server/http";
import { listIdentities } from "@/server/services/imports/identity-resolution";

export const GET = route(async (req) => {
  const p = await requireStaff(req);
  const status = z.enum(["open", "resolved", "all"]).catch("open").parse(new URL(req.url).searchParams.get("status") ?? "open");
  return json({ items: await listIdentities(p, status) });
});
