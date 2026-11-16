import "dotenv/config";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { closeDb } from "../src/db/client";

async function main() {
  // Honor server-only markers in a trusted operator process, without weakening web modules.
  if (!process.execArgv.includes("--conditions=react-server")) {
    const child = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", process.argv[1], ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true, env: process.env });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } }, strict: true });
  const password = process.env.T2T_BOOTSTRAP_PASSWORD;
  delete process.env.T2T_BOOTSTRAP_PASSWORD;
  if (!values.email || !values.name || !password || password.length < 12) throw new Error("Usage: pnpm exec tsx scripts/bootstrap-super-admin.ts --email x --name y; set T2T_BOOTSTRAP_PASSWORD to at least 12 characters.");
  const { bootstrapSuperAdmin } = await import("../src/server/services/governance");
  const a = await bootstrapSuperAdmin({ email: values.email, name: values.name, password });
  console.log(`Bootstrapped Super Admin ${a.email} (${a.id}).`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : "Bootstrap failed."); process.exitCode = 1; }).finally(closeDb);
