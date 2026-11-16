import { afterEach, describe, expect, it, vi } from "vitest";
import { assertObjectKey } from "@/server/storage/object-key";
import { s3StoreFromEnv } from "@/server/storage/s3";

const synthetic = { S3_BUCKET: "synthetic-private-receipts", S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "synthetic-access", S3_SECRET_ACCESS_KEY: "synthetic-test-secret" };
afterEach(() => vi.unstubAllEnvs());

describe("private storage configuration and keys", () => {
  it.each(["../receipt.pdf", "/receipts/123.pdf", "receipts/../../secret", "receipts\\123.pdf", "https://example.test/a.pdf", "receipts/%2e%2e/a.pdf", "short", "receipts/with space.pdf"])("rejects unsafe key %s", key => {
    expect(() => assertObjectKey(key)).toThrow("invalid object key");
  });
  it("accepts opaque receipt and export keys", () => {
    expect(() => assertObjectKey("receipts/01234567-89ab-cdef-0123-456789abcdef.png")).not.toThrow();
    expect(() => assertObjectKey("exports/01234567-89ab-cdef-0123-456789abcdef.csv")).not.toThrow();
  });
  it.each(Object.keys(synthetic))("fails closed when %s is missing", name => {
    expect(() => s3StoreFromEnv({ ...synthetic, [name]: "" })).toThrow(`${name} is required`);
  });
  it("rejects insecure production transport and credential-bearing endpoint URLs", () => {
    expect(() => s3StoreFromEnv({ ...synthetic, NODE_ENV: "production", S3_ENDPOINT: "http://storage.example.test" })).toThrow("must use HTTPS");
    expect(() => s3StoreFromEnv({ ...synthetic, S3_ENDPOINT: "https://user:secret@storage.example.test" })).toThrow("without credentials");
    expect(() => s3StoreFromEnv({ ...synthetic, S3_ENDPOINT: "file:///private" })).toThrow("HTTP(S)");
    expect(() => s3StoreFromEnv({ ...synthetic, S3_FORCE_PATH_STYLE: "yes" })).toThrow("true or false");
  });
  it("supports AWS default endpoints and HTTPS-compatible providers", () => {
    const aws = s3StoreFromEnv({ ...synthetic, NODE_ENV: "production" });
    const compatible = s3StoreFromEnv({ ...synthetic, NODE_ENV: "production", S3_ENDPOINT: "https://storage.example.test", S3_FORCE_PATH_STYLE: "false" });
    expect(aws.driver).toBe("s3"); expect(compatible.productionReady).toBe(true);
    aws.destroy(); compatible.destroy();
  });
  it("preserves the production guard for local disk storage", async () => {
    vi.resetModules();
    vi.stubEnv("STORAGE_DRIVER", "local"); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ALLOW_LOCAL_STORAGE_IN_PRODUCTION", "false");
    const { objectStore } = await import("@/server/storage");
    expect(() => objectStore()).toThrow("development-only");
  });
  it("local exists rejects invalid keys instead of disguising them as absent", async () => {
    vi.resetModules(); vi.stubEnv("STORAGE_DRIVER", "local"); vi.stubEnv("NODE_ENV", "test");
    const { objectStore } = await import("@/server/storage");
    expect(objectStore().driver).toBe("local");
    await expect(objectStore().exists("../secret.pdf")).rejects.toThrow("invalid object key");
  });
});
