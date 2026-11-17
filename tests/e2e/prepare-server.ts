import { cp, mkdir, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { cacheFonts } from "./cache-fonts";

// Next permits only one dev server per build directory. Other agents may be
// running this checkout, so use a disposable, unchanged copy of current sources.
async function prepare() {
  const root = process.cwd();
  const target = path.join(root, "tests/e2e/.artifacts/app");
  if (path.relative(root, target) !== path.join("tests", "e2e", ".artifacts", "app")) throw new Error("Invalid disposable app directory");
  await mkdir(target, { recursive: true });
  // Interrupted compilation can leave invalid Turbopack task references. Remove
  // only these verified generated paths, never dependencies or the real checkout.
  for (const name of [".next", "src", "public"]) {
    const generated = path.resolve(target, name);
    if (path.dirname(generated) !== target) throw new Error("Unsafe artifact path");
    await rm(generated, { recursive: true, force: true });
  }
  for (const name of ["src", "public", "next.config.ts", "postcss.config.mjs", "tsconfig.json", "package.json", "pnpm-lock.yaml", ".gitignore"]) {
    await cp(path.join(root, name), path.join(target, name), { recursive: true });
  }
  try { await stat(path.join(target, "node_modules")); }
  catch { await symlink(path.join(root, "node_modules"), path.join(target, "node_modules"), "junction"); }
  if (process.env.T2T_E2E_CACHED_FONTS === "1") await cacheFonts();
}
prepare().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

