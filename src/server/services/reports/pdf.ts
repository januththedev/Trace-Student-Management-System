import "server-only";
import "regenerator-runtime/runtime.js";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import { formatMinor } from "@/lib/money";
import { formatInstant } from "@/lib/time";
import type { ReportColumn, ReportData } from "./exports";

const TITLES: Record<ReportData["report"], string> = {
  dashboard: "Command centre", students: "Student directory", outstanding: "Outstanding balances",
  ageing: "Outstanding and ageing", credits: "Unapplied credits", receipts: "Receipts by approval date",
  "transfer-receipts": "Receipts by transfer date", allocations: "Instalment allocations", exemptions: "Exemptions",
  "programme-totals": "Programme and intake totals", "review-throughput": "Review throughput",
  "follow-up-outcomes": "Follow-up outcomes", "collection-rate": "Collection rate",
};
const ink = rgb(0.06, 0.18, 0.2), accent = rgb(0.05, 0.45, 0.5), muted = rgb(0.36, 0.44, 0.46);
const line = rgb(0.85, 0.9, 0.88), soft = rgb(0.95, 0.97, 0.96);
let fontBytes: Promise<Buffer[]> | undefined;
const loadFonts = () => fontBytes ??= Promise.all([
  readFile(join(process.cwd(), "src/server/services/reports/fonts/NotoSansSinhala.ttf")),
  readFile(join(process.cwd(), "src/server/services/reports/fonts/NotoSansTamil.ttf")),
]).catch(error => { fontBytes = undefined; throw error; });

function label(column: ReportColumn) {
  return column.header.replace(/_minor$/, " (LKR)").replace(/_/g, " ").replace(/\bnic\b/gi, "NIC");
}

function value(column: ReportColumn, row: Record<string, unknown>): string {
  const v = row[column.key];
  if (v == null || v === "") return "-";
  if (typeof v === "number" && (column.definition.startsWith("LKR minor units") || column.key === "value" && row.unit === "money")) {
    return formatMinor(v, { currency: false });
  }
  if (column.key === "value" && typeof v === "number" && row.basis === "FIXED") return formatMinor(v);
  if (column.key === "value" && typeof v === "number" && row.basis === "PERCENT") return `${formatMinor(v, { currency: false })}%`;
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/** A4, readable type, repeating headers; wide tables continue with repeated identity columns. */
export async function renderReportPdf(report: ReportData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [sinhala, tamil] = await loadFonts();
  // Full static fonts preserve all shaped glyph outlines in PDF readers.
  const regular = await pdf.embedFont(sinhala);
  const tamilFont = await pdf.embedFont(tamil);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(`T2T - ${TITLES[report.report]}`);
  pdf.setAuthor("T2T Student Operations");
  pdf.setCreator("T2T Student Operations");
  pdf.setCreationDate(new Date(report.generatedAt));

  // Shape complete script runs so Sinhala/Tamil vowel signs remain attached.
  function runs(text: string) {
    return text.split(/([\u0b80-\u0bff]+)/u).filter(Boolean).map(text => ({ text, font: /[\u0b80-\u0bff]/u.test(text) ? tamilFont : regular }));
  }
  const width = (text: string, size: number) => runs(text).reduce((total, run) => total + run.font.widthOfTextAtSize(run.text, size), 0);
  function draw(page: PDFPage, text: string, x: number, y: number, size = 9, color = ink) {
    for (const run of runs(text)) { page.drawText(run.text, { x, y, size, font: run.font, color }); x += run.font.widthOfTextAtSize(run.text, size); }
  }
  function wrap(text: string, maxWidth: number, size = 9) {
    const lines: string[] = [];
    let current = "";
    // Grapheme boundaries avoid splitting a combining sequence inside a long name.
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const word of text.split(/\s+/)) {
      if (width(current ? `${current} ${word}` : word, size) <= maxWidth) { current = current ? `${current} ${word}` : word; continue; }
      if (current) { lines.push(current); current = ""; }
      for (const { segment } of segmenter.segment(word)) {
        if (current && width(current + segment, size) > maxWidth) { lines.push(current); current = ""; }
        current += segment;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : ["-"];
  }

  const columns = report.table.columns;
  const bands: ReportColumn[][] = [];
  // Limit to seven business columns per sheet rather than shrinking type to fit.
  if (columns.length <= 7) bands.push(columns);
  else {
    bands.push(columns.slice(0, 7));
    for (let start = 7; start < columns.length; start += 5) bands.push([...columns.slice(0, 2), ...columns.slice(start, start + 5)]);
  }
  const pageWidth = 841.89, pageHeight = 595.28, margin = 32, bottom = 58;
  const contentWidth = pageWidth - margin * 2;
  const title = TITLES[report.report];
  for (const [bandIndex, band] of bands.entries()) {
    const numberWidth = 30, cellWidth = (contentWidth - numberWidth) / band.length;
    const headers = band.map(c => wrap(label(c), cellWidth - 14));
    const headerHeight = Math.max(...headers.map(h => h.length)) * 13 + 16;
    let page: PDFPage, y = 0;
    function newPage() {
      page = pdf.addPage([pageWidth, pageHeight]);
      page.drawRectangle({ x: 0, y: pageHeight - 6, width: pageWidth, height: 6, color: accent });
      page.drawText("T2T / REPORTS", { x: margin, y: pageHeight - 33, size: 9, font: bold, color: accent });
      page.drawText(title, { x: margin, y: pageHeight - 62, size: 21, font: bold, color: ink });
      draw(page, `From ${report.filters.from} to ${report.filters.to} | As of ${report.filters.asOf} | Asia/Colombo`, margin, pageHeight - 82, 9, muted);
      draw(page, `Generated ${formatInstant(report.generatedAt)} | ${report.rowCount} records | ${report.fullIdentifiers ? "Full NIC - authorized, audited" : "NIC masked"}`, margin, pageHeight - 98, 8, muted);
      draw(page, `Programme: ${report.filters.programmeId ?? "all in your scope"} | Intake: ${report.filters.intakeId ?? "all in your scope"}`, margin, pageHeight - 114, 8, muted);
      draw(page, `Currency: LKR (major units, 2 decimals) | ${bands.length > 1 ? `Column group ${bandIndex + 1} of ${bands.length}; first two columns repeat` : "All columns"}`, margin, pageHeight - 130, 8, muted);
      y = pageHeight - 146;
      page.drawRectangle({ x: margin, y: y - headerHeight, width: contentWidth, height: headerHeight, color: ink });
      draw(page, "#", margin + 8, y - 19, 9, rgb(1, 1, 1));
      headers.forEach((lines, col) => lines.forEach((text, i) => draw(page, text, margin + numberWidth + col * cellWidth + 7, y - 18 - i * 13, 9, rgb(1, 1, 1))));
      y -= headerHeight;
    }
    newPage();
    if (!report.table.rows.length) { draw(page!, "No records match these filters.", margin + 12, y - 30, 11, muted); }
    for (const [rowIndex, row] of report.table.rows.entries()) {
      const cells = band.map(c => wrap(value(c, row), cellWidth - 14));
      const lineCount = Math.max(...cells.map(c => c.length));
      // Very long notes continue onto another page; no row or text is discarded.
      let offset = 0;
      while (offset < lineCount) {
        if (y - 30 < bottom) newPage();
        const available = Math.max(1, Math.floor((y - bottom - 16) / 14));
        const count = Math.min(lineCount - offset, available);
        const height = count * 14 + 16;
        if (rowIndex % 2 === 0) page!.drawRectangle({ x: margin, y: y - height, width: contentWidth, height, color: soft });
        draw(page!, `${rowIndex + 1}${offset ? "+" : ""}`, margin + 7, y - 18, 8, muted);
        cells.forEach((lines, col) => lines.slice(offset, offset + count).forEach((text, i) => {
          const numeric = typeof row[band[col].key] === "number";
          const x = margin + numberWidth + col * cellWidth + (numeric ? cellWidth - 7 - width(text, 9) : 7);
          draw(page!, text, x, y - 18 - i * 14);
        }));
        y -= height;
        page!.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: line });
        offset += count;
        if (offset < lineCount) newPage();
      }
    }
  }
  for (const [i, page] of pdf.getPages().entries()) {
    page.drawLine({ start: { x: margin, y: 45 }, end: { x: pageWidth - margin, y: 45 }, thickness: 0.5, color: line });
    draw(page, "Approved receipts are collections, not accrual revenue. Credit is not a new collection; waivers are not cash.", margin, 31, 7, muted);
    draw(page, `T2T Student Operations | Private report | Page ${i + 1} of ${pdf.getPageCount()}`, margin, 19, 7, muted);
  }
  return pdf.save();
}
