#!/usr/bin/env node
// Sandbox by construction (spec section 15): no key-shaped string reaches a
// commit. Runs on the staged files from the pre-commit hook and on the
// whole tree in the CI. A `csk_test_` value that is not the placeholder is
// refused too: a test key is still a credential.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const PATTERNS = [
  { name: "codespar live key", re: /csk_live_[A-Za-z0-9]{6,}/ },
  { name: "codespar test key", re: /csk_test_(?!your_key_here)[A-Za-z0-9]{8,}/ },
  { name: "anthropic key", re: /sk-ant-(?!your_key_here)[A-Za-z0-9_-]{16,}/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "0x private key", re: /\b0x[0-9a-fA-F]{64}\b/ },
];
const SKIP = [/^node_modules\//, /package-lock\.json$/, /\.png$|\.jpg$|\.gif$|\.ico$/];

const mode = process.argv[2] ?? "staged";
// `dir <path>`: every file under a directory that is not a checkout, its own node_modules included (the hosted-kits artifact bundles two packages there).
const root = mode === "dir" ? process.argv[3] : undefined;
if (mode === "dir" && !root) {
  process.stderr.write("usage: node scripts/secret-scan.mjs dir <path>\n");
  process.exit(2);
}
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
const files =
  mode === "dir"
    ? walk(root)
    : mode === "all"
      ? execSync("git ls-files", { encoding: "utf8" }).split("\n")
      : execSync("git diff --cached --name-only --diff-filter=ACMR", { encoding: "utf8" }).split("\n");

let hits = 0;
for (const file of files.filter(Boolean)) {
  if (SKIP.some((s) => s.test(mode === "dir" ? relative(root, file) : file)) && !(mode === "dir" && /^node_modules\//.test(relative(root, file)))) continue;
  let text;
  try {
    text = mode === "all" || mode === "dir" ? readFileSync(file, "utf8") : execSync(`git show :${JSON.stringify(file)}`, { encoding: "utf8" });
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) {
      hits += 1;
      process.stderr.write(`secret-scan: ${name} in ${file}\n`);
    }
  }
}
if (hits) {
  process.stderr.write(`secret-scan: ${hits} finding(s). Keys live in .env (gitignored) and nowhere else.\n`);
  process.exit(1);
}
process.stderr.write(`secret-scan: clean (${mode}${root ? ` ${root}` : ""})\n`);
