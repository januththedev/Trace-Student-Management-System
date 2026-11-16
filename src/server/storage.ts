import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertObjectKey } from "./storage/object-key";
import { s3StoreFromEnv } from "./storage/s3";

/**
 * Private object storage adapter. Receipts NEVER live under /public.
 *  - "local": DEVELOPMENT ONLY. Writes to LOCAL_STORAGE_DIR on the server filesystem.
 *  - "s3": S3-compatible private bucket (see docs/scheduler-storage-setup.md).
 * Credentials stay server-side; all receipt delivery still uses authenticated application routes.
 */
export interface ObjectStore {
  readonly driver: "local" | "s3";
  readonly productionReady: boolean;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

class LocalStore implements ObjectStore {
  readonly driver = "local" as const;
  readonly productionReady = false;
  constructor(private root: string) {}
  private file(key: string) {
    assertObjectKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("invalid object key");
    return p;
  }
  async put(key: string, body: Buffer) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body, { flag: "w" });
  }
  async get(key: string) {
    try { return await fs.readFile(this.file(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async delete(key: string) {
    try { await fs.unlink(this.file(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  async exists(key: string) {
    const file = this.file(key);
    try { await fs.access(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
}

let store: ObjectStore | null = null;
export function objectStore(): ObjectStore {
  if (store) return store;
  const driver = process.env.STORAGE_DRIVER ?? "local";
  if (driver === "local") {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION !== "true") {
      throw new Error("STORAGE_DRIVER=local is development-only. Configure STORAGE_DRIVER=s3 for production.");
    }
    store = new LocalStore(path.resolve(process.env.LOCAL_STORAGE_DIR ?? "./.private-storage"));
    return store;
  }
  if (driver === "s3") {
    store = s3StoreFromEnv();
    return store;
  }
  throw new Error("STORAGE_DRIVER must be local or s3");
}

/** Scanner configuration is shared with the actual finalization scanner. */
export { scannerStatus } from "./malware";
