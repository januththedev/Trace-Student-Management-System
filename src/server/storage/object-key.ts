const SAFE_KEY = /^[a-z0-9][a-z0-9/_\-.]{8,200}$/i;

/** Keys are opaque internal identifiers, never user-supplied filesystem paths or URLs. */
export function assertObjectKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error("invalid object key");
}
