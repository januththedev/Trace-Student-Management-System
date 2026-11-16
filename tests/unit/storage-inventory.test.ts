import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { S3Client, ListObjectsV2Command, type ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { afterEach, expect, test, vi, type Mock } from "vitest";
import { S3Store } from "@/server/storage/s3";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function s3() { return new S3Store("synthetic-bucket", { region: "auto", credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" } }); }
// Narrow the SDK's callback/promise overloads to the actual inventory request boundary.
function mockInventory() { return vi.spyOn(S3Client.prototype, "send") as unknown as Mock<(command: ListObjectsV2Command) => Promise<ListObjectsV2CommandOutput>>; }

test("bucket inventory sums every metadata page including previews, temporary objects and empty files", async () => {
  const send = mockInventory()
    .mockResolvedValueOnce({ $metadata: {}, Contents: [{ Key: "receipts/a", Size: 100 }, { Key: "receipts/a.preview", Size: 20 }], IsTruncated: true, NextContinuationToken: "page-two" })
    .mockResolvedValueOnce({ $metadata: {}, Contents: [{ Key: "uploads/b", Size: 30 }, { Key: "exports/empty", Size: 0 }], IsTruncated: false });
  const store = s3();
  try {
    expect(await store.inventory()).toEqual({ totalBytes: 150, objectCount: 4 });
    expect(send.mock.calls[1][0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls[1][0].input).toMatchObject({ ContinuationToken: "page-two" });
  } finally { store.destroy(); }
});

test("inventory rejects provider failures and missing pagination instead of reporting free capacity", async () => {
  const send = mockInventory().mockRejectedValueOnce(new Error("denied"));
  const store = s3();
  try {
    await expect(store.inventory()).rejects.toThrow("denied");
    send.mockResolvedValueOnce({ $metadata: {}, IsTruncated: true });
    await expect(store.inventory()).rejects.toThrow("incomplete inventory");
    send.mockResolvedValueOnce({ $metadata: {}, Contents: [{ Size: -1 }] });
    await expect(store.inventory()).rejects.toThrow("invalid object size");
  } finally { store.destroy(); }
});

test("local inventory measures nested physical files and missing directories accurately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t2t-inventory-"));
  try {
    vi.resetModules(); vi.stubEnv("STORAGE_DRIVER", "local"); vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("LOCAL_STORAGE_DIR", path.join(root, "objects"));
    const { objectStore } = await import("@/server/storage");
    expect(await objectStore().inventory()).toEqual({ totalBytes: 0, objectCount: 0 });
    await mkdir(path.join(root, "objects", "receipts"), { recursive: true });
    await writeFile(path.join(root, "objects", "receipts", "original.pdf"), Buffer.alloc(40));
    await writeFile(path.join(root, "objects", "receipts", "preview.webp"), Buffer.alloc(15));
    await writeFile(path.join(root, "objects", "empty"), "");
    expect(await objectStore().inventory()).toEqual({ totalBytes: 55, objectCount: 3 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
