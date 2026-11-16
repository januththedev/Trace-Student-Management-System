import { describe, expect, it } from "vitest";
import {
  detectNicFormat,
  isValidNicFormat,
  maskNic,
  normalizeNic,
} from "@/lib/nic";

describe("normalizeNic", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeNic("  851234567V  ")).toBe("851234567V");
  });

  it("removes inner whitespace", () => {
    expect(normalizeNic("851 234\t567 V")).toBe("851234567V");
    expect(normalizeNic("1990 1234 5678")).toBe("199012345678");
  });

  it("uppercases the check letter", () => {
    expect(normalizeNic("851234567v")).toBe("851234567V");
    expect(normalizeNic("851234567x")).toBe("851234567X");
  });

  it("is idempotent", () => {
    const once = normalizeNic("  199012345678 ");
    expect(normalizeNic(once)).toBe(once);
  });
});

describe("isValidNicFormat", () => {
  it("accepts valid old-format NICs with V or X", () => {
    expect(isValidNicFormat("851234567V")).toBe(true);
    expect(isValidNicFormat("856234567X")).toBe(true);
  });

  it("accepts the day-of-year boundaries for old format", () => {
    expect(isValidNicFormat("850014567V")).toBe(true);
    expect(isValidNicFormat("853664567V")).toBe(true);
    expect(isValidNicFormat("855014567V")).toBe(true);
    expect(isValidNicFormat("858664567V")).toBe(true);
  });

  it("rejects old format day-of-year outside 1..366 and 501..866", () => {
    expect(isValidNicFormat("850004567V")).toBe(false);
    expect(isValidNicFormat("853674567V")).toBe(false);
    expect(isValidNicFormat("855004567V")).toBe(false);
    expect(isValidNicFormat("854004567V")).toBe(false);
    expect(isValidNicFormat("858674567V")).toBe(false);
  });

  it("rejects malformed old-format values", () => {
    expect(isValidNicFormat("85123456V")).toBe(false);
    expect(isValidNicFormat("8512345670")).toBe(false);
    expect(isValidNicFormat("851234567A")).toBe(false);
    expect(isValidNicFormat("851234567")).toBe(false);
    expect(isValidNicFormat("V85123456")).toBe(false);
  });

  it("accepts 12-digit new format with plausible birth years", () => {
    expect(isValidNicFormat("190001010000")).toBe(true);
    expect(isValidNicFormat("199012345678")).toBe(true);
    expect(isValidNicFormat("209912312345")).toBe(true);
  });

  it("rejects 12-digit values with implausible birth years", () => {
    expect(isValidNicFormat("189912345678")).toBe(false);
    expect(isValidNicFormat("210012345678")).toBe(false);
    expect(isValidNicFormat("000012345678")).toBe(false);
  });

  it("rejects 12-character values that are not all digits", () => {
    expect(isValidNicFormat("19901234567V")).toBe(false);
    expect(isValidNicFormat("19901234567A")).toBe(false);
    expect(isValidNicFormat("19901234567")).toBe(false);
    expect(isValidNicFormat("1990123456789")).toBe(false);
  });

  it("normalizes before validating", () => {
    expect(isValidNicFormat("  851234567v ")).toBe(true);
    expect(isValidNicFormat("1990 1234 5678")).toBe(true);
  });

  it("rejects empty and garbage input", () => {
    expect(isValidNicFormat("")).toBe(false);
    expect(isValidNicFormat("   ")).toBe(false);
    expect(isValidNicFormat("not-a-nic")).toBe(false);
  });
});

describe("maskNic", () => {
  it("keeps the last three characters of a 12-digit NIC", () => {
    expect(maskNic("199012345678")).toBe("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022678");
  });

  it("keeps the same length as the input", () => {
    const nic = "199012345678";
    expect(maskNic(nic)).toHaveLength(nic.length);
  });

  it("masks an old-format NIC while revealing the final three characters", () => {
    expect(maskNic("851234567V")).toBe("\u2022\u2022\u2022\u2022\u2022\u2022\u202267V");
  });

  it("does not leak the leading digits", () => {
    const masked = maskNic("851234567V");
    expect(masked.startsWith("851")).toBe(false);
    expect(masked.endsWith("67V")).toBe(true);
  });

  it("leaves strings of three characters or fewer unchanged", () => {
    expect(maskNic("12")).toBe("12");
    expect(maskNic("abc")).toBe("abc");
    expect(maskNic("")).toBe("");
  });
});

describe("detectNicFormat", () => {
  it("detects old and new formats", () => {
    expect(detectNicFormat("851234567V")).toBe("OLD");
    expect(detectNicFormat("856234567X")).toBe("OLD");
    expect(detectNicFormat("199012345678")).toBe("NEW");
  });

  it("normalizes before detecting", () => {
    expect(detectNicFormat(" 851234567v ")).toBe("OLD");
    expect(detectNicFormat("1990 1234 5678")).toBe("NEW");
  });

  it("returns null for invalid or unsupported values", () => {
    expect(detectNicFormat("850004567V")).toBeNull();
    expect(detectNicFormat("189912345678")).toBeNull();
    expect(detectNicFormat("851234567")).toBeNull();
    expect(detectNicFormat("")).toBeNull();
    expect(detectNicFormat("hello")).toBeNull();
  });

  it("never treats old and new formats as the same value", () => {
    expect(normalizeNic("851234567V")).not.toBe(normalizeNic("199012345678"));
    expect(detectNicFormat("851234567V")).not.toBe(detectNicFormat("199012345678"));
  });
});
