import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("pdfjs-dist/package.json");
const packageRoot = path.dirname(packageJsonPath);
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const expectedVersion = "6.5.438";

if (packageJson.version !== expectedVersion) {
  throw new Error(`Expected pdfjs-dist ${expectedVersion}, found ${packageJson.version}. Update the worker URL contract and asset pin together.`);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "public", "vendor", "pdfjs", packageJson.version);
const assets = [
  ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["cmaps", "cmaps"],
  ["standard_fonts", "standard_fonts"],
  ["wasm", "wasm"],
  ["iccs", "iccs"],
];

async function copyAllowedTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Refusing to copy a symbolic link from pdfjs-dist: ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const names = (await readdir(source)).sort((a, b) => a.localeCompare(b, "en"));
    for (const name of names) await copyAllowedTree(path.join(source, name), path.join(destination, name));
    return;
  }
  if (!info.isFile()) throw new Error(`Refusing to copy a non-file pdfjs-dist asset: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

await mkdir(outputRoot, { recursive: true });
for (const [sourceRelative, destinationRelative] of assets) {
  await copyAllowedTree(path.join(packageRoot, sourceRelative), path.join(outputRoot, destinationRelative));
}
await copyFile(path.join(packageRoot, "LICENSE"), path.join(outputRoot, "LICENSE"));

console.log(`Prepared PDF.js ${packageJson.version} browser assets at ${path.relative(repositoryRoot, outputRoot).replaceAll(path.sep, "/")}`);
