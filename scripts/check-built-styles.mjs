import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// A successful Next build must contain the current design system, not a cached
// stylesheet from an earlier deployment. Keep this check on the deploy path.
async function cssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? cssFiles(target) : target.endsWith(".css") ? [target] : [];
  }))).flat();
}
const source = await readFile("src/app/globals.css", "utf8");
const files = process.argv[2] === "--css" ? [process.argv[3]] : await cssFiles(".next/static");
const output = (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");
const missing = [".entry-heading", ".staff-nav-groups", ".staff-menu-close", ".staff-account-trigger"].filter(selector => !output.includes(selector));
function normalize(value) {
  const clean = value.trim().toLowerCase();
  return /^#[0-9a-f]{3}$/.test(clean) ? "#" + [...clean.slice(1)].map(c => c + c).join("") : clean;
}
for (const token of ["--color-bg", "--color-inv", "--color-accent", "--radius-lg"]) {
  const pattern = new RegExp(`${token}\\s*:\\s*([^;}]+)`);
  const expected = source.match(pattern)?.[1];
  const actual = output.match(pattern)?.[1];
  if (!expected || !actual || normalize(expected) !== normalize(actual)) missing.push(token);
}
if (missing.length) throw new Error(`Built CSS does not match the current source: ${missing.join(", ")}. Refusing to deploy stale styles.`);
console.log("Built CSS matches current entry, sidebar, theme and radius styles.");
