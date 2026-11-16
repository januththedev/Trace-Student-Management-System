export type NicFormat = "OLD" | "NEW";

export function normalizeNic(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isValidNicFormat(n: string): boolean {
  const value = normalizeNic(n);

  if (/^\d{9}[VX]$/.test(value)) {
    const dayOfYear = Number.parseInt(value.slice(2, 5), 10);
    return (dayOfYear >= 1 && dayOfYear <= 366) || (dayOfYear >= 501 && dayOfYear <= 866);
  }

  if (/^\d{12}$/.test(value)) {
    const birthYear = Number.parseInt(value.slice(0, 4), 10);
    return birthYear >= 1900 && birthYear <= 2099;
  }

  return false;
}

export function maskNic(n: string): string {
  if (n.length <= 3) return n;
  return "\u2022".repeat(n.length - 3) + n.slice(-3);
}

export function detectNicFormat(n: string): NicFormat | null {
  if (!isValidNicFormat(n)) return null;
  const value = normalizeNic(n);
  return value.endsWith("V") || value.endsWith("X") ? "OLD" : "NEW";
}
