#!/usr/bin/env node
/**
 * Runs the WhatsApp Cloud API emulator the channel's `simulator` backend talks
 * to: `dyvit-wa-sim`, published as `@dyvit/whatsapp-simulator-cli` (MIT) from
 * https://github.com/fabianocruz/whatsapp-simulator. It is not ours and it is
 * not a dependency of this workspace.
 *
 * WHY NOT A DEPENDENCY. It is a development tool. Nothing in `packages/` or
 * `agents/` imports it, so `npm ci` has no reason to fetch it and a contributor
 * who never runs the WhatsApp gate never downloads it. `npx` fetches the exact
 * version into its own cache the first time it is needed; nothing is vendored,
 * nothing is installed globally, and the repository's tree is untouched.
 *
 * WHY PINNED TO A VERSION. A moving `latest` would make our gate fail on
 * somebody else's release. `--version` overrides, and there is no `latest`.
 * The version the resolved package declares is CHECKED against the pin below,
 * so a stray global install earlier on PATH cannot quietly take over.
 *
 * WHY NOT `npx … serve` DIRECTLY. Because 0.1.0's published bin does nothing.
 * `dist/cli.js` runs `main()` only when `import.meta.url` equals
 * `pathToFileURL(process.argv[1]).href`, and a bin is a symlink, so through
 * `npx` (or any `node_modules/.bin`) the two never match: the process exits 0
 * having started no server, which reads as a passing command and a dead port.
 * So `npx` fetches the pinned version and we run the module file it resolved
 * to. Delete `resolveCli` the day that guard is fixed upstream.
 *
 * Usage:
 *   node scripts/whatsapp-emulator.mjs                   start it (foreground)
 *   node scripts/whatsapp-emulator.mjs --prepare         fetch and resolve only
 *   node scripts/whatsapp-emulator.mjs --version <v>     a different release
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const EMULATOR_PACKAGE = "@dyvit/whatsapp-simulator-cli";
/** The release the gate is measured against. Bump deliberately, never automatically. */
export const EMULATOR_VERSION = "0.1.0";
/** The binary the package installs, and the name we look for on the PATH `npx` hands us. */
export const EMULATOR_BIN = "dyvit-wa-sim";
export const EMULATOR_PORT = 4290;
/** Must match `WHATSAPP_SIM_APP_SECRET`. A local development value, not a credential. */
export const EMULATOR_APP_SECRET = "dev";
/** Where the channel's own receiver listens; the emulator posts its webhooks there. */
export const EMULATOR_WEBHOOK_PORT = 4399;

/** Runs inside the `npx` child, where the cache's `.bin` is first on the PATH. No shell. */
const FIND_ENTRY = [
  "const { existsSync, realpathSync } = require('node:fs');",
  "const { delimiter, join } = require('node:path');",
  `const hit = (process.env.PATH ?? '').split(delimiter).map((d) => join(d, ${JSON.stringify(EMULATOR_BIN)})).find((p) => existsSync(p));`,
  "if (!hit) process.exit(3);",
  "process.stdout.write(realpathSync(hit));",
].join("");

function spec(version) {
  return `${EMULATOR_PACKAGE}@${version}`;
}

/**
 * Fetches the pinned version through `npx` and returns the module file inside
 * the cache it landed in. The fetch is `npx`'s; the second step is ours only
 * because the bin cannot be invoked (see the header).
 */
export function resolveCli(version = EMULATOR_VERSION, say = (l) => process.stderr.write(l + "\n")) {
  say(`whatsapp emulator: resolving ${spec(version)}`);
  const found = spawnSync("npx", ["--yes", "--package", spec(version), "--", process.execPath, "-e", FIND_ENTRY], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (found.error) throw found.error;
  const entry = (found.stdout ?? "").trim();
  if (found.status !== 0 || !entry) {
    throw new Error(`could not fetch ${spec(version)} (npx exited ${found.status}). Is the version published, and is the network reachable?`);
  }
  const manifest = JSON.parse(readFileSync(resolve(dirname(entry), "..", "package.json"), "utf8"));
  if (manifest.version !== version) {
    throw new Error(`resolved ${EMULATOR_PACKAGE}@${manifest.version} at ${entry}, but this repo is pinned to ${version}`);
  }
  return entry;
}

function serve(version, webhookUrl) {
  const entry = resolveCli(version);
  const child = spawn(
    process.execPath,
    [entry, "serve", "--port", String(EMULATOR_PORT), "--webhook", webhookUrl, "--app-secret", EMULATOR_APP_SECRET],
    { cwd: ROOT, stdio: "inherit" },
  );
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  const version = argv.includes("--version") ? argv[argv.indexOf("--version") + 1] : EMULATOR_VERSION;
  const webhookUrl = argv.includes("--webhook") ? argv[argv.indexOf("--webhook") + 1] : `http://127.0.0.1:${EMULATOR_WEBHOOK_PORT}/`;
  if (argv.includes("--prepare")) {
    process.stderr.write(`whatsapp emulator ready: ${resolveCli(version)}\n`);
  } else {
    process.stderr.write(`whatsapp emulator: ${spec(version)} on :${EMULATOR_PORT}, webhooks to ${webhookUrl}\n`);
    serve(version, webhookUrl);
  }
}
