import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Read the actual generated PDF, including embedded-font text and page geometry. */
export async function readPdf(bytes: Uint8Array) {
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const document = await loading.promise;
  try {
    const pages = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const content = await page.getTextContent();
      const items = content.items.filter(item => "str" in item);
      pages.push({ text: items.map(item => item.str).join(" "), items, width: page.view[2], height: page.view[3] });
    }
    return pages;
  } finally { await loading.destroy(); }
}
