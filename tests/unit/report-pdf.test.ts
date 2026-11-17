import { describe, expect, it } from "vitest";
import { renderReportPdf } from "@/server/services/reports/pdf";
import type { ReportData } from "@/server/services/reports/exports";
import { readPdf } from "../pdf-text";

function fixture(rows: Record<string, unknown>[]): ReportData {
  return {
    report: "students", filename: "test.pdf", generatedAt: "2026-06-15T06:30:00Z", businessDate: "2026-06-15",
    rowCount: rows.length, fullIdentifiers: false, filters: { from: "2026-06-01", to: "2026-06-15", asOf: "2026-06-15", programmeId: undefined, intakeId: undefined },
    table: { columns: [
      { key: "ref", header: "student_ref", definition: "Reference" },
      { key: "name", header: "student_name", definition: "Full name" },
      { key: "amount", header: "outstanding_minor", definition: "LKR minor units (1 LKR = 100)" },
    ], rows },
  };
}

describe("printable reports", () => {
  it("prints an explicit empty state, filters, currency and page count", async () => {
    const pages = await readPdf(await renderReportPdf(fixture([])));
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain("No records match these filters.");
    expect(pages[0].text).toContain("2026-06-15");
    expect(pages[0].text).toContain("Currency: LKR");
    expect(pages[0].text).toContain("Page 1 of 1");
  });

  it("paginates all records, repeats headers and renders signed integer-safe money", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => ({ ref: `ROW-${String(i).padStart(3, "0")}`, name: `Student ${i}`, amount: i === 0 ? -123_456 : 9_876_543 }));
    const pages = await readPdf(await renderReportPdf(fixture(rows)));
    expect(pages.length).toBeGreaterThan(1);
    const text = pages.map(p => p.text).join(" ");
    for (const row of rows) expect(text).toContain(row.ref);
    expect(text).toContain("-1,234.56");
    expect(text).toContain("98,765.43");
    for (const page of pages) {
      expect(page.text).toContain("student ref");
      for (const item of page.items) {
        expect(item.transform[4]).toBeGreaterThanOrEqual(30);
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(page.width - 30);
        expect(item.transform[5]).toBeGreaterThanOrEqual(18);
        expect(item.transform[5]).toBeLessThan(page.height - 15);
      }
    }
  });

  it("shapes Sinhala and Tamil names without breaking export generation", async () => {
    const pages = await readPdf(await renderReportPdf(fixture([{ ref: "MULTILINGUAL", name: "සිසිර தமிழ் José", amount: 10_001 }])));
    expect(pages[0].text).toContain("MULTILINGUAL");
    expect(pages[0].text).toContain("José");
    expect(pages[0].text).toMatch(/[\u0d80-\u0dff]/u);
    expect(pages[0].text).toMatch(/[\u0b80-\u0bff]/u);
    expect(pages[0].text).toContain("100.01");
  });

  it("continues wide tables and oversized notes without dropping fields or text", async () => {
    const data = fixture([{ ref: "LONG-ROW", name: `${"A long student name ".repeat(140)}END-OF-NAME`, amount: 100 }]);
    for (let n = 0; n < 7; n++) {
      data.table.columns.push({ key: `extra${n}`, header: `extra_${n}`, definition: "Additional field" });
      data.table.rows[0][`extra${n}`] = `VALUE-${n}`;
    }
    const pages = await readPdf(await renderReportPdf(data));
    const text = pages.map(p => p.text).join(" ");
    expect(text).toContain("END-OF-NAME");
    for (let n = 0; n < 7; n++) expect(text).toContain(`VALUE-${n}`);
    expect(pages.length).toBeGreaterThan(2);
    expect(text).toContain("Column group 2 of 2");
  });
});
