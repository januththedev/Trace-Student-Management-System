import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
export const fontResponsesPath = path.resolve("tests/e2e/.artifacts/font-responses.json");
const urls = [
  "https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@300..800&display=swap",
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap",
];
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36";

async function download(url: string, destination: string) {
  try { if ((await stat(destination)).size > 0) return; } catch { /* populate cache */ }
  await run(process.platform === "win32" ? "curl.exe" : "curl", ["-4", "--fail", "--silent", "--show-error", "--max-time", "30", "--user-agent", userAgent, "--output", destination, url], { windowsHide: true });
}

// Cache the actual Google CSS and font bytes. Next's font fixture transport reads
// this cache so native font networking cannot block functional acceptance tests.
export async function cacheFonts() {
  const directory = path.resolve("tests/e2e/.artifacts/fonts");
  const publicDirectory = path.resolve("tests/e2e/.artifacts/app/public/_acceptance-fonts");
  await mkdir(directory, { recursive: true });
  await mkdir(publicDirectory, { recursive: true });
  const responses: Record<string, string> = {};
  await Promise.all(urls.map(async (url, index) => {
    const cssFile = path.join(directory, `${index}.css`);
    await download(url, cssFile);
    let css = await readFile(cssFile, "utf8");
    const files = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((match) => match[1]))];
    await Promise.all(files.map(async (fileUrl, fontIndex) => {
      const fontFile = path.join(directory, `${index}-${fontIndex}${path.extname(new URL(fileUrl).pathname)}`);
      await download(fileUrl, fontFile);
      await cp(fontFile, path.join(publicDirectory, path.basename(fontFile)));
      const local = `http://127.0.0.1:3100/_acceptance-fonts/${path.basename(fontFile)}`;
      css = css.replaceAll(fileUrl, local);
    }));
    responses[url] = css;
  }));
  await writeFile(fontResponsesPath, JSON.stringify(responses));
}
