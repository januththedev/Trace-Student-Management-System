import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { objectStore, type ObjectStore } from "@/server/storage";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
/** Bound decompression independently from a mutable upload-size environment value. */
export const MAX_ARCHIVE_ORIGINAL_BYTES = 20 * 1024 * 1024;

export interface ArchivedReceipt {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  archiveEncoding: string | null;
  archiveOriginalKey: string | null;
}

export function assertOriginalReceipt(bytes: Buffer, asset: Pick<ArchivedReceipt, "sizeBytes" | "sha256">): void {
  if (bytes.byteLength !== asset.sizeBytes || !/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new Error("Receipt archive integrity check failed.");
  const actual = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(asset.sha256, "hex");
  if (!timingSafeEqual(actual, expected)) throw new Error("Receipt archive integrity check failed.");
}

export async function compressReceipt(bytes: Buffer): Promise<Buffer> {
  if (bytes.byteLength > MAX_ARCHIVE_ORIGINAL_BYTES) throw new Error("Receipt exceeds the archive size limit.");
  return gzipAsync(bytes, { level: 9 });
}

export async function decodeReceiptArchive(bytes: Buffer, asset: Pick<ArchivedReceipt, "sizeBytes" | "sha256">): Promise<Buffer> {
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || asset.sizeBytes > MAX_ARCHIVE_ORIGINAL_BYTES) {
    throw new Error("Receipt archive has an invalid original size.");
  }
  // A corrupt stream cannot expand beyond its independently recorded original size.
  const original = await gunzipAsync(bytes, { maxOutputLength: asset.sizeBytes });
  assertOriginalReceipt(original, asset);
  return original;
}

/** Authorization belongs to the caller. This helper only retrieves exact original evidence. */
export async function readReceiptAssetBytes(asset: ArchivedReceipt, store: ObjectStore = objectStore()): Promise<Buffer | null> {
  const bytes = await store.get(asset.objectKey);
  if (!asset.archiveEncoding) return bytes;
  if (asset.archiveEncoding !== "gzip") throw new Error("Receipt archive encoding is not supported.");
  if (bytes) return decodeReceiptArchive(bytes, asset);
  // During the cleanup grace period a missing archive still has a verified original.
  // Corrupt archives deliberately fail closed rather than concealing a storage defect.
  if (asset.archiveOriginalKey) {
    const original = await store.get(asset.archiveOriginalKey);
    if (original) {
      assertOriginalReceipt(original, asset);
      return original;
    }
  }
  return null;
}
