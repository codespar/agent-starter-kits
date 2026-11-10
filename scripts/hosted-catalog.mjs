#!/usr/bin/env node
/**
 * The hosted catalog: one descriptor per agent under `agents/`, derived from
 * its manifest, tools, scenario packs and kit module (CONTRATO.md section 1).
 * The work is in `packages/agent-runtime/src/hosted/catalog.ts`; this file is
 * the process boundary tsx needs, the same one `bin.mjs` is.
 *
 * Usage: node scripts/hosted-catalog.mjs [--out <file>] [--check <file>] [--version <v>]
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../packages/agent-runtime/src/hosted/catalog-cli.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", cli, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
