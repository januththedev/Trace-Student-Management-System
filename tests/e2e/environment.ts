import "dotenv/config";
import path from "node:path";

// A fixed, dedicated database: never reset the developer or integration databases.
const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for Playwright");
export const adminUrl = source;
const url = new URL(source);
url.pathname = "/t2t_e2e";
export const e2eUrl = url.toString();
export const storageDir = path.resolve("tests/e2e/.artifacts/storage");
export const STAFF_EMAIL = "acceptance-super@example.test";
export const STAFF_PASSWORD = "Synthetic-acceptance-only-473!";
export const PROGRAMME_ID = "e2e00000-0000-4000-8000-000000000001";

// Explicit synthetic keys, isolated from developer/production credentials.
export const e2eEnv = {
  DATABASE_URL: e2eUrl,
  NIC_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
  NIC_LOOKUP_KEY: Buffer.alloc(32, 12).toString("base64"),
  SESSION_SECRET: Buffer.alloc(32, 13).toString("base64"),
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: storageDir,
  // Each test uses an independent identity. Avoid suite-wide IP limits on localhost.
  RL_ENTRY_IP: "1000",
};
Object.assign(process.env, e2eEnv);

