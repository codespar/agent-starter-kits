/**
 * `node scripts/hosted-catalog.mjs [--out <file>] [--check <file>] [--version <v>]`
 *
 * Writes the hosted catalog of every agent under `agents/`, or checks that a
 * catalog file is the one this tree produces. The commit is `git rev-parse
 * HEAD` and the digests are of the files on disk, so a tree with changes
 * under `agents/` or `packages/` is refused: its digests would name a commit
 * that does not hold those files.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@codespar/agent-core";
import { buildCatalog, discoverAgentDirs } from "./catalog.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const SHARED_SOURCE = ["packages/agent-core/src", "packages/agent-runtime/src"] as const;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  if (git("status", "--porcelain", "--", "agents", "packages") !== "") {
    process.stderr.write("hosted-catalog: agents/ or packages/ has uncommitted changes; the digests would not match the commit. Commit first.\n");
    return 2;
  }
  const catalog = await buildCatalog({ root: ROOT, commit, shared: SHARED_SOURCE }, discoverAgentDirs(join(ROOT, "agents")), flag(argv, "--version") ?? "0.0.0-source");
  const text = JSON.stringify(catalog, null, 2) + "\n";
  const check = flag(argv, "--check");
  if (check) {
    const same = canonicalJson(JSON.parse(readFileSync(check, "utf8"))) === canonicalJson(catalog);
    process.stderr.write(same ? `hosted-catalog: ${check} matches ${commit}\n` : `hosted-catalog: ${check} differs from what ${commit} produces\n`);
    return same ? 0 : 1;
  }
  const out = flag(argv, "--out");
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  process.stderr.write(`hosted-catalog: ${catalog.kits.length} kit(s) at ${commit}: ${catalog.kits.map((k) => k.id).join(", ")}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`hosted-catalog: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
