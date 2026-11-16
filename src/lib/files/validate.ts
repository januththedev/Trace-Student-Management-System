import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

export type ReceiptKind = "image" | "pdf";

export type ReceiptMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export type ReceiptValidationError =
  | "TOO_LARGE"
  | "EMPTY"
  | "UNSUPPORTED_TYPE"
  | "MIME_MISMATCH"
  | "CORRUPT"
  | "ENCRYPTED_PDF"
  | "TOO_MANY_PAGES"
  | "DIMENSIONS";

export type ReceiptValidationOk = {
  ok: true;
  kind: ReceiptKind;
  mime: ReceiptMime;
  width?: number;
  height?: number;
  pages?: number;
  sha256: string;
};

export type ReceiptValidationFailure = {
  ok: false;
  code: ReceiptValidationError;
  message: string;
};

export type ReceiptValidationResult = ReceiptValidationOk | ReceiptValidationFailure;

export interface ValidateReceiptFileOptions {
  maxBytes?: number;
  maxPixels?: number;
  maxPdfPages?: number;
}

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_PIXELS = 50_000_000;
export const DEFAULT_MAX_PDF_PAGES = 20;
export const MIN_IMAGE_DIMENSION = 50;
export const PREVIEW_MAX_WIDTH = 1600;

const ALLOWED_MIMES: readonly ReceiptMime[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

function failure(code: ReceiptValidationError, message: string): ReceiptValidationFailure {
  return { ok: false, code, message };
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function normalizeDeclaredMime(declared: string): string {
  const base = (declared.split(";")[0] ?? "").trim().toLowerCase();
  return base === "image/jpg" ? "image/jpeg" : base;
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

async function validateImage(
  buf: Buffer,
  mime: ReceiptMime,
  maxPixels: number
): Promise<ReceiptValidationOk | ReceiptValidationFailure> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    const metadata = await sharp(buf).metadata();
    width = metadata.width;
    height = metadata.height;
    await sharp(buf).stats();
  } catch (err) {
    return failure("CORRUPT", `Image could not be decoded: ${messageOf(err)}`);
  }

  if (width === undefined || height === undefined) {
    return failure("CORRUPT", "Image dimensions could not be determined");
  }

  if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) {
    return failure(
      "DIMENSIONS",
      `Image is ${width}x${height}; minimum is ${MIN_IMAGE_DIMENSION}x${MIN_IMAGE_DIMENSION}`
    );
  }

  if (width * height > maxPixels) {
    return failure(
      "DIMENSIONS",
      `Image has ${width * height} pixels, exceeding the ${maxPixels} pixel limit`
    );
  }

  return {
    ok: true,
    kind: "image",
    mime,
    width,
    height,
    sha256: sha256Hex(buf),
  };
}

async function validatePdf(
  buf: Buffer,
  maxPdfPages: number
): Promise<ReceiptValidationOk | ReceiptValidationFailure> {
  if (buf.includes("/Encrypt")) {
    return failure("ENCRYPTED_PDF", "PDF is password-protected or encrypted");
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf);
  } catch (err) {
    const msg = messageOf(err);
    if (/encrypt/i.test(msg)) {
      return failure("ENCRYPTED_PDF", "PDF is password-protected or encrypted");
    }
    return failure("CORRUPT", `PDF could not be parsed: ${msg}`);
  }

  const pages = doc.getPageCount();
  if (pages > maxPdfPages) {
    return failure(
      "TOO_MANY_PAGES",
      `PDF has ${pages} pages, exceeding the limit of ${maxPdfPages}`
    );
  }

  return { ok: true, kind: "pdf", mime: "application/pdf", pages, sha256: sha256Hex(buf) };
}

export async function validateReceiptFile(
  buf: Buffer,
  declaredMime: string,
  opts?: ValidateReceiptFileOptions
): Promise<ReceiptValidationResult> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxPixels = opts?.maxPixels ?? DEFAULT_MAX_PIXELS;
  const maxPdfPages = opts?.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES;

  if (buf.length === 0) {
    return failure("EMPTY", "File is empty");
  }

  if (buf.length > maxBytes) {
    return failure("TOO_LARGE", `File is ${buf.length} bytes, exceeding the ${maxBytes} byte limit`);
  }

  let detected: { mime: string } | undefined;
  try {
    detected = (await fileTypeFromBuffer(buf)) ?? undefined;
  } catch (err) {
    return failure("UNSUPPORTED_TYPE", `File type could not be determined: ${messageOf(err)}`);
  }

  if (!detected || !ALLOWED_MIMES.includes(detected.mime as ReceiptMime)) {
    return failure(
      "UNSUPPORTED_TYPE",
      detected
        ? `File type ${detected.mime} is not allowed`
        : "File type could not be recognized from magic bytes"
    );
  }

  if (normalizeDeclaredMime(declaredMime) !== detected.mime) {
    return failure(
      "MIME_MISMATCH",
      `Declared MIME ${declaredMime || "(empty)"} does not match detected type ${detected.mime}`
    );
  }

  return detected.mime === "application/pdf"
    ? validatePdf(buf, maxPdfPages)
    : validateImage(buf, detected.mime as ReceiptMime, maxPixels);
}

export async function makePreview(buf: Buffer, kind: ReceiptKind): Promise<Buffer | null> {
  if (kind !== "image") {
    return null;
  }

  try {
    return await sharp(buf)
      .rotate()
      .resize({ width: PREVIEW_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}
