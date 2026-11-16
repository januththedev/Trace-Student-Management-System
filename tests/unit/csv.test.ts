import { describe, expect, it } from "vitest";
import { neutralizeCell, parseCsv, toCsv } from "@/lib/csv";

describe("neutralizeCell", () => {
  it("leaves ordinary text unchanged", () => {
    expect(neutralizeCell("Alice")).toBe("Alice");
    expect(neutralizeCell("safe,comma")).toBe("safe,comma");
    expect(neutralizeCell("")).toBe("");
  });

  it("prefixes a single quote for formula-like strings", () => {
    expect(neutralizeCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(neutralizeCell("+1")).toBe("'+1");
    expect(neutralizeCell("-1")).toBe("'-1");
    expect(neutralizeCell("@cmd")).toBe("'@cmd");
    expect(neutralizeCell("\tvalue")).toBe("'\tvalue");
    expect(neutralizeCell("\rvalue")).toBe("'\rvalue");
    expect(neutralizeCell("=")).toBe("'=");
  });

  it("keeps negative numbers passed as numbers unchanged", () => {
    expect(neutralizeCell(-100)).toBe("-100");
    expect(neutralizeCell(-0.5)).toBe("-0.5");
    expect(neutralizeCell(42)).toBe("42");
    expect(neutralizeCell(0)).toBe("0");
  });

  it("neutralizes a negative-looking value supplied as a string", () => {
    expect(neutralizeCell("-100")).toBe("'-100");
  });

  it("does not neutralize leading whitespace before a formula", () => {
    expect(neutralizeCell("  =1+1")).toBe("  =1+1");
  });

  it("converts other primitive types", () => {
    expect(neutralizeCell(true)).toBe("true");
    expect(neutralizeCell(false)).toBe("false");
    expect(neutralizeCell(BigInt(10))).toBe("10");
  });

  it("renders nullish values as empty strings", () => {
    expect(neutralizeCell(null)).toBe("");
    expect(neutralizeCell(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("writes headers and rows with CRLF line endings and a trailing CRLF", () => {
    const csv = toCsv(["Name", "Course"], [["Alice", "Math"], ["Bob", "Science"]]);
    expect(csv).toBe("Name,Course\r\nAlice,Math\r\nBob,Science\r\n");
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    const csv = toCsv(
      ["Name", "Note"],
      [
        ["Alice", "Hello, world"],
        ["Bob", 'He said "hi"'],
        ["Carol", "line1\nline2"],
        ["Dave", "line1\r\nline2"],
      ],
    );
    expect(csv).toBe(
      'Name,Note\r\nAlice,"Hello, world"\r\nBob,"He said ""hi"""\r\nCarol,"line1\nline2"\r\nDave,"line1\r\nline2"\r\n',
    );
  });

  it("neutralizes formula injection in cells before writing", () => {
    const csv = toCsv(["Value"], [["=1+1"], ["@cmd"], ["+SUM(A1)"]]);
    expect(csv).toBe("Value\r\n'=1+1\r\n'@cmd\r\n'+SUM(A1)\r\n");
  });

  it("quotes a neutralized value that also contains a comma", () => {
    const csv = toCsv(["Value"], [["=A1,B1"]]);
    expect(csv).toBe('Value\r\n"\'=A1,B1"\r\n');
  });

  it("does not neutralize negative numbers supplied as numbers", () => {
    const csv = toCsv(["Amount"], [[-100], ["-100"]]);
    expect(csv).toBe("Amount\r\n-100\r\n'-100\r\n");
  });

  it("renders nullish cells as empty fields", () => {
    const csv = toCsv(["A", "B", "C"], [["x", null, undefined]]);
    expect(csv).toBe("A,B,C\r\nx,,\r\n");
  });

  it("writes preamble lines as comment rows above the header", () => {
    const csv = toCsv(["Name"], [["Alice"]], {
      preamble: ["T2T export", "generated 2026-11-15T10:00:00Z"],
    });
    expect(csv).toBe(
      "# T2T export\r\n# generated 2026-11-15T10:00:00Z\r\nName\r\nAlice\r\n",
    );
  });

  it("writes only the header when there are no rows", () => {
    expect(toCsv(["A", "B"], [])).toBe("A,B\r\n");
  });

  it("quotes headers containing special characters", () => {
    expect(toCsv(["Full, name", 'Quote "x"'], [])).toBe('"Full, name","Quote ""x"""\r\n');
  });
});

describe("parseCsv", () => {
  it("parses simple CRLF rows", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses LF and mixed line endings", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv("a,b\r\nc,d\ne,f\rg,h")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("strips a leading BOM", () => {
    expect(parseCsv("\uFEFFa,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses quoted fields containing commas", () => {
    expect(parseCsv('Alice,"Hello, world"\r\n')).toEqual([["Alice", "Hello, world"]]);
  });

  it("parses escaped quotes", () => {
    expect(parseCsv('"He said ""hi""",ok')).toEqual([['He said "hi"', "ok"]]);
    expect(parseCsv('"a""b""c"')).toEqual([['a"b"c']]);
  });

  it("preserves newlines inside quoted fields", () => {
    expect(parseCsv('a,"line1\nline2",b')).toEqual([["a", "line1\nline2", "b"]]);
    expect(parseCsv('a,"line1\r\nline2",b')).toEqual([["a", "line1\r\nline2", "b"]]);
  });

  it("parses empty quoted fields", () => {
    expect(parseCsv('a,"",b')).toEqual([["a", "", "b"]]);
  });

  it("does not emit a trailing empty row for a final newline", () => {
    expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]]);
    expect(parseCsv("a,b\r\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("returns an empty array for empty or BOM-only input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\uFEFF")).toEqual([]);
  });

  it("preserves genuinely empty trailing fields", () => {
    expect(parseCsv("a,b,")).toEqual([["a", "b", ""]]);
    expect(parseCsv(",,")).toEqual([["", "", ""]]);
  });

  it("round-trips a safely quoted export", () => {
    const rows = [
      ["Alice", "Hello, world"],
      ["Bob", 'He said "hi"'],
      ["Carol", "line1\nline2"],
    ];
    const csv = toCsv(["Name", "Note"], rows);
    expect(parseCsv(csv)).toEqual([["Name", "Note"], ...rows]);
  });
});
