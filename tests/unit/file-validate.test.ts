import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { makePreview, validateReceiptFile } from "@/lib/files/validate";

async function makeImagePng(width = 100, height = 80): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 80, b: 160 } },
  })
    .png()
    .toBuffer();
}

async function makeImageJpeg(width = 96, height = 72): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function makeImageWebp(width = 72, height = 64): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 140, b: 90 } },
  })
    .webp()
    .toBuffer();
}

async function makePdf(pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    doc.addPage([612, 792]);
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("validateReceiptFile", () => {
  it("accepts a valid PNG and reports dimensions and sha256", async () => {
    const buf = await makeImagePng();
    const result = await validateReceiptFile(buf, "image/png");
    expect(result).toMatchObject({
      ok: true,
      kind: "image",
      mime: "image/png",
      width: 100,
      height: 80,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.sha256).toBe(sha256(buf));
  });

  it("accepts a valid JPEG", async () => {
    const buf = await makeImageJpeg();
    const result = await validateReceiptFile(buf, "image/jpeg");
    expect(result).toMatchObject({ ok: true, kind: "image", mime: "image/jpeg", width: 96, height: 72 });
  });

  it("normalizes image/jpg declared mime to image/jpeg", async () => {
    const buf = await makeImageJpeg();
    const result = await validateReceiptFile(buf, "image/jpg");
    expect(result).toMatchObject({ ok: true, mime: "image/jpeg" });
  });

  it("accepts a valid WebP", async () => {
    const buf = await makeImageWebp();
    const result = await validateReceiptFile(buf, "image/webp");
    expect(result).toMatchObject({ ok: true, kind: "image", mime: "image/webp", width: 72, height: 64 });
  });

  it("accepts a minimal PDF and counts pages", async () => {
    const buf = await makePdf(2);
    const result = await validateReceiptFile(buf, "application/pdf");
    expect(result).toMatchObject({ ok: true, kind: "pdf", mime: "application/pdf", pages: 2 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.width).toBeUndefined();
    expect(result.sha256).toBe(sha256(buf));
  });

  it("rejects an empty buffer with EMPTY", async () => {
    const result = await validateReceiptFile(Buffer.alloc(0), "image/png");
    expect(result).toMatchObject({ ok: false, code: "EMPTY" });
  });

  it("rejects an oversized buffer with TOO_LARGE", async () => {
    const buf = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    const result = await validateReceiptFile(buf, "image/png");
    expect(result).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("rejects SVG text with UNSUPPORTED_TYPE", async () => {
    const buf = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>',
      "utf8"
    );
    const result = await validateReceiptFile(buf, "image/svg+xml");
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
  });

  it("rejects an executable header with UNSUPPORTED_TYPE", async () => {
    const buf = Buffer.concat([Buffer.from("MZ", "utf8"), Buffer.alloc(256, 0x90)]);
    const result = await validateReceiptFile(buf, "application/octet-stream");
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
  });

  it("rejects a declared MIME that does not match the detected type", async () => {
    const buf = await makeImagePng();
    const result = await validateReceiptFile(buf, "image/gif");
    expect(result).toMatchObject({ ok: false, code: "MIME_MISMATCH" });
  });

  it("rejects a truncated corrupt PNG with CORRUPT", async () => {
    const full = await makeImagePng();
    const buf = full.subarray(0, Math.floor(full.length / 3));
    const result = await validateReceiptFile(buf, "image/png");
    expect(result).toMatchObject({ ok: false, code: "CORRUPT" });
  });

  it("rejects a PDF with an /Encrypt trailer with ENCRYPTED_PDF", async () => {
    const base = await makePdf();
    const buf = Buffer.concat([
      base,
      Buffer.from(
        "\ntrailer<< /Size 5 /Root 1 0 R /Encrypt 4 0 R >>\nstartxref\n0\n%%EOF\n",
        "utf8"
      ),
    ]);
    const result = await validateReceiptFile(buf, "application/pdf");
    expect(result).toMatchObject({ ok: false, code: "ENCRYPTED_PDF" });
  });

  it("rejects an image below the minimum dimension with DIMENSIONS", async () => {
    const buf = await makeImagePng(30, 30);
    const result = await validateReceiptFile(buf, "image/png");
    expect(result).toMatchObject({ ok: false, code: "DIMENSIONS" });
  });

  it("respects a custom byte limit", async () => {
    const buf = await makeImagePng();
    const result = await validateReceiptFile(buf, "image/png", { maxBytes: 64 });
    expect(result).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("respects a custom PDF page limit", async () => {
    const buf = await makePdf(3);
    const result = await validateReceiptFile(buf, "application/pdf", { maxPdfPages: 2 });
    expect(result).toMatchObject({ ok: false, code: "TOO_MANY_PAGES" });
  });

  it("respects a custom pixel limit", async () => {
    const buf = await makeImagePng(100, 80);
    const result = await validateReceiptFile(buf, "image/png", { maxPixels: 1000 });
    expect(result).toMatchObject({ ok: false, code: "DIMENSIONS" });
  });
});

describe("makePreview", () => {
  it("re-encodes an image to sanitized WebP capped at 1600px wide with metadata stripped", async () => {
    const png = await sharp({
      create: { width: 2400, height: 800, channels: 3, background: { r: 10, g: 200, b: 20 } },
    })
      .png()
      .toBuffer();

    const preview = await makePreview(png, "image");
    expect(preview).not.toBeNull();

    const meta = await sharp(preview as Buffer).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(1600);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });

  it("does not enlarge small images", async () => {
    const png = await makeImagePng(200, 100);
    const preview = await makePreview(png, "image");
    expect(preview).not.toBeNull();
    const meta = await sharp(preview as Buffer).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(200);
  });

  it("returns null for a PDF", async () => {
    const buf = await makePdf();
    expect(await makePreview(buf, "pdf")).toBeNull();
  });

  it("returns null for undecodable image data", async () => {
    const buf = Buffer.from("not an image", "utf8");
    expect(await makePreview(buf, "image")).toBeNull();
  });
});
