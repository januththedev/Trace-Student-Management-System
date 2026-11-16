import "server-only";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { ObjectStore } from "../storage";
import { assertObjectKey } from "./object-key";

export class S3Store implements ObjectStore {
  readonly driver = "s3" as const;
  readonly productionReady = true;
  private readonly client: S3Client;

  constructor(private readonly bucket: string, config: S3ClientConfig) {
    this.client = new S3Client({ maxAttempts: 3, requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 }, ...config });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertObjectKey(key);
    // No ACL header: compatible with bucket-owner-enforced buckets. Never request public access.
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer | null> {
    assertObjectKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) throw new Error("Object storage returned no body");
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    assertObjectKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      // HEAD has no structured error body. Never turn a 403 or transport failure into absence.
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    // S3 delete is idempotent for absent keys; bucket/auth/transport errors still propagate.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async inventory(): Promise<{ totalBytes: number; objectCount: number }> {
    let totalBytes = 0, objectCount = 0;
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1000, ContinuationToken: token }));
      for (const object of result.Contents ?? []) {
        if (!Number.isSafeInteger(object.Size) || object.Size! < 0) throw new Error("Storage returned an invalid object size");
        totalBytes += object.Size!;
        objectCount++;
        if (!Number.isSafeInteger(totalBytes)) throw new Error("Storage inventory exceeds supported size");
      }
      if (!result.IsTruncated) break;
      token = result.NextContinuationToken;
      if (!token || seen.has(token)) throw new Error("Storage returned an incomplete inventory");
      seen.add(token);
    } while (token);
    return { totalBytes, objectCount };
  }

  destroy(): void { this.client.destroy(); }
}

export function s3StoreFromEnv(values: Record<string, string | undefined> = process.env): S3Store {
  function required(name: string): string {
    const value = values[name]?.trim();
    if (!value) throw new Error(`${name} is required for STORAGE_DRIVER=s3`);
    return value;
  }
  const bucket = required("S3_BUCKET");
  const region = required("S3_REGION");
  const accessKeyId = required("S3_ACCESS_KEY_ID");
  const secretAccessKey = required("S3_SECRET_ACCESS_KEY");
  let endpoint: string | undefined;
  if (values.S3_ENDPOINT) {
    let url: URL;
    try { url = new URL(values.S3_ENDPOINT); } catch { throw new Error("S3_ENDPOINT must be a valid HTTP(S) URL"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("S3_ENDPOINT must be an HTTP(S) URL without credentials, query or fragment");
    if (values.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("S3_ENDPOINT must use HTTPS in production");
    endpoint = url.toString();
  }
  if (values.S3_FORCE_PATH_STYLE && !["true", "false"].includes(values.S3_FORCE_PATH_STYLE)) throw new Error("S3_FORCE_PATH_STYLE must be true or false");
  return new S3Store(bucket, {
    region, endpoint,
    forcePathStyle: values.S3_FORCE_PATH_STYLE ? values.S3_FORCE_PATH_STYLE === "true" : Boolean(endpoint),
    credentials: { accessKeyId, secretAccessKey, ...(values.S3_SESSION_TOKEN ? { sessionToken: values.S3_SESSION_TOKEN } : {}) },
  });
}
