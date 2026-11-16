import { idempotencyKey, json, parseBody, route } from "@/server/http";
import { requireStaff } from "@/server/auth/staff";
import { holidaySchema, listHolidays, saveHoliday } from "@/server/services/followups/calendar";

export const GET = route(async req => json(await listHolidays(await requireStaff(req))));
export const POST = route(async req => json(await saveHoliday(await requireStaff(req), await parseBody(req, holidaySchema), idempotencyKey(req))));
export const PUT = POST;
export const DELETE = route(async req => json(await saveHoliday(await requireStaff(req), await parseBody(req, holidaySchema), idempotencyKey(req), true)));
