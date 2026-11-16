/** Business time helpers. Business dates are Asia/Colombo calendar dates (YYYY-MM-DD strings). */
export const BUSINESS_TZ = "Asia/Colombo";
export type BizDate = string; // YYYY-MM-DD

const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's (or `at`'s) business date in Colombo. Tests may pin it via T2T_FAKE_NOW. */
export function businessDate(at: Date = now()): BizDate {
  return fmt.format(at);
}

/** Current instant; overridable in tests through process.env.T2T_FAKE_NOW (ISO string). */
export function now(): Date {
  const f = typeof process !== "undefined" ? process.env.T2T_FAKE_NOW : undefined;
  return f ? new Date(f) : new Date();
}

export function isBizDate(s: string): s is BizDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(d: BizDate, n: number): BizDate {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** b - a in whole days. */
export function daysBetween(a: BizDate, b: BizDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** UTC instant for a Colombo wall-clock time (Colombo has no DST: fixed +05:30). */
export function colomboInstant(d: BizDate, hh = 0, mm = 0): Date {
  return new Date(`${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);
}

/** 0=Sun..6=Sat */
export function weekday(d: BizDate): number {
  return new Date(`${d}T00:00:00Z`).getUTCDay();
}

export function formatBizDate(d: BizDate): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatInstant(at: Date | string): string {
  return new Date(at).toLocaleString("en-GB", { timeZone: BUSINESS_TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
