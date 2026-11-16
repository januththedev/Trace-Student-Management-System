import { z } from "zod";
import { db } from "@/db/client";
import { requireStaff } from "@/server/auth/staff";
import { json, parseBody, route } from "@/server/http";
import { searchStudents } from "@/server/services/directory";

const exactNicSearchInput = z.object({ nic: z.string().trim().min(1).max(20) });

export const POST = route(async req => json(await searchStudents(db(), await requireStaff(req), await parseBody(req, exactNicSearchInput))));
