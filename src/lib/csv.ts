export function neutralizeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);

  const s = typeof v === "string" ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

function quoteField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(
  headers: string[],
  rows: unknown[][],
  opts?: { preamble?: string[] },
): string {
  const lines: string[] = [];

  if (opts?.preamble) {
    for (const line of opts.preamble) lines.push(`# ${line}`);
  }

  lines.push(headers.map((header) => quoteField(neutralizeCell(header))).join(","));

  for (const row of rows) {
    lines.push(row.map((cell) => quoteField(neutralizeCell(cell))).join(","));
  }

  return `${lines.join("\r\n")}\r\n`;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += text[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
