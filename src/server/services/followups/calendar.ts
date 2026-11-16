import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { withTx, type DbOrTx } from "@/db/client";
import { businessHolidays } from "@/db/schema";
import { addDays, businessDate, colomboInstant, now, weekday } from "@/lib/time";
import { requireSuper, type StaffPrincipal } from "@/server/auth/policy";
import { audit } from "@/server/audit";
import { fail } from "@/server/http";
import { daySchema, freshPrincipal, reasonSchema, replay } from "./shared";

/** Explicit working-day policy; holidays always come from business_holidays. */
export function workingWeekdays(): number[] {
  return z.array(z.number().int().min(0).max(6)).min(1).parse((process.env.T2T_BUSINESS_WEEKDAYS ?? "1,2,3,4,5").split(",").map(Number));
}
export async function isBusinessDay(tx: DbOrTx, day: string): Promise<boolean> {
  daySchema.parse(day);
  const [holiday] = await tx.select().from(businessHolidays).where(eq(businessHolidays.day, day));
  return workingWeekdays().includes(weekday(day)) && !holiday;
}
export async function nextBusinessDay(tx: DbOrTx, day: string): Promise<string> {
  daySchema.parse(day);
  let candidate = day;
  for (let n = 0; n < 370; n++) {
    candidate = addDays(candidate, 1);
    if (await isBusinessDay(tx, candidate)) return candidate;
  }
  throw fail.conflict("No business day is configured in the next year.");
}
export async function inContactWindow(tx: DbOrTx, at = now()): Promise<boolean> {
  const day = businessDate(at);
  return await isBusinessDay(tx, day) && at >= colomboInstant(day, 9) && at < colomboInstant(day, 17);
}
export async function nextContactAt(tx: DbOrTx, at = now()): Promise<Date> {
  const day = businessDate(at);
  if (await isBusinessDay(tx, day) && at < colomboInstant(day, 17)) return at < colomboInstant(day, 9) ? colomboInstant(day, 9) : at;
  return colomboInstant(await nextBusinessDay(tx, day), 9);
}
export const holidaySchema = z.object({ day: daySchema, label: reasonSchema, expectedLabel: z.string().nullable() });
export async function listHolidays(p: StaffPrincipal) {
  return withTx(async tx => { requireSuper(await freshPrincipal(tx, p)); return tx.select().from(businessHolidays).orderBy(businessHolidays.day); });
}
/** expectedLabel provides optimistic concurrency on the schema's unversioned calendar rows. */
export async function saveHoliday(p: StaffPrincipal, raw: unknown, key: string, remove = false) {
  const input = holidaySchema.parse(raw);
  return withTx(async tx => {
    const actor = await freshPrincipal(tx, p); requireSuper(actor);
    return replay(tx, `holiday:${p.id}`, key, { ...input, remove }, async () => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`holiday:${input.day}`}, 0))`);
      const [old] = await tx.select().from(businessHolidays).where(eq(businessHolidays.day, input.day)).for("update");
      if ((old?.label ?? null) !== input.expectedLabel) throw fail.stale("The holiday changed. Refresh and try again.");
      if (remove) await tx.delete(businessHolidays).where(eq(businessHolidays.day, input.day));
      else await tx.insert(businessHolidays).values({ day: input.day, label: input.label, createdBy: p.id }).onConflictDoUpdate({ target: businessHolidays.day, set: { label: input.label } });
      await audit(tx, { actorType: "STAFF", actorId: p.id, action: remove ? "HOLIDAY_REMOVED" : "HOLIDAY_SAVED", entityType: "business_holiday", entityId: input.day, before: old, after: remove ? null : input });
      return { day: input.day, removed: remove };
    });
  });
}
