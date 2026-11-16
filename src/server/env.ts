import "server-only";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  NIC_ENCRYPTION_KEY: z.string().min(40),
  NIC_LOOKUP_KEY: z.string().min(40),
  SESSION_SECRET: z.string().min(40),
  CRON_SECRET: z.string().min(16).optional(),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default("./.private-storage"),
  MALWARE_SCANNER: z.enum(["none", "clamav"]).default("none"),
  RECEIPT_MAX_BYTES: z.coerce.number().int().positive().max(50 * 1024 * 1024).default(10 * 1024 * 1024),
  STUDENT_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  STUDENT_ABSOLUTE_MINUTES: z.coerce.number().int().min(30).max(24 * 60).default(720),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  NODE_ENV: z.string().default("development"),
});

let cached: z.infer<typeof schema> | null = null;
export function env() {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
