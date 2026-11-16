import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { fail, json, parseBody, route } from "@/server/http";
import { searchStudents, studentSearchInput } from "@/server/services/directory";
export const GET = route(async req => {
  const p = await requireStaff(req);
  const searchParams = req.nextUrl.searchParams;
  if (searchParams.has("nic")) throw fail.validation("Use the private exact NIC search field.");
  return json(await searchStudents(db(), p, Object.fromEntries(searchParams)));
});
// Exact NIC searches only travel in a private POST body.
export const POST = route(async req => json(await searchStudents(db(), await requireStaff(req), await parseBody(req, studentSearchInput))));
