/** Money helpers. All amounts are integer minor units (LKR cents). Never binary floats for arithmetic. */
export type Minor = number;
export const CURRENCY = "LKR" as const;

export function assertMinor(n: number, label = "amount"): Minor {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} must be a safe integer of minor units`);
  return n;
}

/** Parse a user-entered major-unit string like "4,000.50" into minor units without float math. */
export function parseMajorToMinor(input: string): Minor | null {
  const s = input.replace(/[,\s]/g, "").replace(/^LKR/i, "");
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const v = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(v);
}

export function formatMinor(minor: Minor, opts: { currency?: boolean } = {}): string {
  assertMinor(minor);
  const neg = minor < 0;
  const abs = BigInt(Math.abs(minor));
  const majorStr = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `${majorStr}.${(abs % 100n).toString().padStart(2, "0")}`;
  return `${neg ? "-" : ""}${opts.currency === false ? "" : "LKR "}${body}`;
}

/** Major units as a plain string for inputs/CSV, e.g. 400050 -> "4000.50". */
export function minorToMajorString(minor: Minor): string {
  assertMinor(minor);
  const neg = minor < 0;
  const abs = BigInt(Math.abs(minor));
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export const sumMinor = (xs: readonly Minor[]): Minor => assertMinor(xs.reduce((a, b) => a + b, 0), "sum");

/** basisPoints of amount, rounded half-up on integers (deterministic). */
export function percentOf(amount: Minor, basisPoints: number): Minor {
  assertMinor(amount);
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) throw new RangeError("basis points 0..10000");
  return Number((BigInt(amount) * BigInt(basisPoints) + 5000n) / 10000n);
}
