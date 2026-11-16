import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { CreateBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, expect, test } from "vitest";
import { S3Store, s3StoreFromEnv } from "@/server/storage/s3";

// No PostgreSQL or host volume is touched. This container and its synthetic credentials
// belong exclusively to this test; cleanup never targets existing MinIO services.
const container = `t2t-storage-test-${randomUUID()}`;
const bucket = "synthetic-private-receipts";
const credentials = { accessKeyId: "synthetic-t2t-storage", secretAccessKey: "synthetic-only-storage-secret" };
let created = false;
let endpoint = "";
let client: S3Client;
let store: S3Store;
const clients: S3Store[] = [];

beforeAll(async () => {
  execFileSync("docker", ["run", "--detach", "--name", container, "--label", "t2t.test=private-storage", "--publish", "127.0.0.1::9000", "--env", `MINIO_ROOT_USER=${credentials.accessKeyId}`, "--env", `MINIO_ROOT_PASSWORD=${credentials.secretAccessKey}`, "quay.io/minio/minio:latest", "server", "/data"], { timeout: 60_000, stdio: "pipe" });
  created = true;
  const port = execFileSync("docker", ["port", container, "9000/tcp"], { encoding: "utf8", timeout: 10_000 }).trim().split(":").at(-1);
  endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* container starting */ }
    if (ready) break;
    await pause(200);
  }
  if (!ready) throw new Error("Dedicated synthetic MinIO did not become ready");
  client = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  store = s3StoreFromEnv({ S3_BUCKET: bucket, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: credentials.accessKeyId, S3_SECRET_ACCESS_KEY: credentials.secretAccessKey, S3_ENDPOINT: endpoint, NODE_ENV: "test" });
});

afterAll(() => {
  store?.destroy(); client?.destroy(); clients.forEach(value => value.destroy());
  if (created) execFileSync("docker", ["rm", "--force", container], { timeout: 20_000, stdio: "pipe" });
});

test("round-trips private receipt/export bytes and content type, overwrites and deletes idempotently", async () => {
  const key = `receipts/${randomUUID()}.pdf`;
  expect(store.productionReady).toBe(true);
  expect(await store.exists(key)).toBe(false);
  expect(await store.get(key)).toBeNull();
  const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  await store.put(key, bytes, "application/pdf");
  expect(await store.exists(key)).toBe(true);
  expect(await store.get(key)).toEqual(bytes);
  expect((await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentType).toBe("application/pdf");
  expect((await fetch(`${endpoint}/${bucket}/${key}`)).status).toBe(403);
  await store.put(key, Buffer.alloc(0), "text/csv");
  expect(await store.get(key)).toEqual(Buffer.alloc(0));
  await store.delete(key); await store.delete(key);
  expect(await store.get(key)).toBeNull(); expect(await store.exists(key)).toBe(false);
});

test("does not disguise invalid credentials or unavailable storage as a missing object", async () => {
  const denied = new S3Store(bucket, { endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: "invalid-synthetic-access", secretAccessKey: "invalid-synthetic-secret" } }); clients.push(denied);
  const key = `receipts/${randomUUID()}.pdf`;
  await expect(denied.get(key)).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  await expect(denied.exists(key)).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  await expect(denied.put(key, Buffer.from("synthetic"), "application/pdf")).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  await expect(denied.delete(key)).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  const wrongBucket = new S3Store("synthetic-missing-bucket", { endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials }); clients.push(wrongBucket);
  await expect(wrongBucket.get(key)).rejects.toMatchObject({ name: "NoSuchBucket" });
  const offline = new S3Store(bucket, { endpoint: "http://127.0.0.1:1", region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials }); clients.push(offline);
  await expect(offline.get(key)).rejects.toBeDefined();
  await expect(offline.exists(key)).rejects.toBeDefined();
});

test("rejects unsafe object keys on every operation before contacting S3", async () => {
  for (const key of ["../secret.pdf", "receipts/../../secret", "/receipts/123.pdf", "receipts\\123.pdf", "receipts/%2e%2e/a.pdf"]) {
    await expect(store.put(key, Buffer.from("synthetic"), "application/pdf")).rejects.toThrow("invalid object key");
    await expect(store.get(key)).rejects.toThrow("invalid object key");
    await expect(store.exists(key)).rejects.toThrow("invalid object key");
    await expect(store.delete(key)).rejects.toThrow("invalid object key");
  }
});
