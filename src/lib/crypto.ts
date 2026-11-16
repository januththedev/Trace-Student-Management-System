import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, scrypt as _scrypt } from "node:crypto";

type ScryptOpts = { N: number; r: number; p: number; maxmem: number };
function scrypt(pw: string, salt: Buffer, keylen: number, opts: ScryptOpts): Promise<Buffer> {
  return new Promise((res, rej) => _scrypt(pw, salt, keylen, opts, (err, dk) => (err ? rej(err) : res(dk))));
}

function key(name: "NIC_ENCRYPTION_KEY" | "NIC_LOOKUP_KEY" | "SESSION_SECRET"): Buffer {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  const b = Buffer.from(v, "base64");
  if (b.length < 32) throw new Error(`${name} must decode to at least 32 bytes`);
  return b;
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). The "v1" key id supports rotation. */
export function encryptNic(normalized: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key("NIC_ENCRYPTION_KEY").subarray(0, 32), iv);
  const ct = Buffer.concat([c.update(normalized, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptNic(blob: string): string {
  const [ver, iv, tag, ct] = blob.split(".");
  if (ver !== "v1") throw new Error("unknown NIC key version");
  const d = createDecipheriv("aes-256-gcm", key("NIC_ENCRYPTION_KEY").subarray(0, 32), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** Keyed lookup digest (HMAC-SHA256) — never a plain hash of a predictable NIC. */
export function nicLookup(normalized: string): string {
  return createHmac("sha256", key("NIC_LOOKUP_KEY")).update(`nic:${normalized}`).digest("base64url");
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Bearer tokens are stored only as keyed hashes. */
export function hashToken(token: string, purpose: string): string {
  return createHmac("sha256", key("SESSION_SECRET")).update(`${purpose}:${token}`).digest("base64url");
}

export function hmacHex(data: string, purpose: string): string {
  return createHmac("sha256", key("SESSION_SECRET")).update(`${purpose}:${data}`).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const SCRYPT: ScryptOpts = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64url")}$${dk.toString("base64url")}`;
}
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) { await scrypt(pw, randomBytes(16), 32, SCRYPT); return false; }
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const dk = await scrypt(pw, Buffer.from(salt, "base64url"), 32, { ...SCRYPT, N: Number(n) });
  return safeEqual(dk.toString("base64url"), hash);
}
