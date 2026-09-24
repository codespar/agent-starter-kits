#!/usr/bin/env node
/**
 * Runs the WhatsApp Cloud API emulator the channel's `simulator` backend talks
 * to: `dyvit-wa-sim`, from https://github.com/fabianocruz/whatsapp-simulator
 * (MIT). It is not ours and it is not a dependency of this workspace.
 *
 * WHY NOT A DEPENDENCY. Its packages are not published to npm (checked
 * 2026-09-24: `@dyvit/whatsapp-simulator-cli` and `@dyvit/whatsapp-pricing`
 * both 404), and it is a pnpm workspace while this repo is an npm one. Making
 * it a dependency would mean vendoring someone else's tree or teaching our
 * `npm ci` about pnpm, and neither is worth it for a development tool. So it
 * is a CLONE AT A PINNED SHA, in a cache directory, started by this script and
 * by one CI step. `npm ci` never sees it.
 *
 * WHY PINNED. A moving `main` would make our gate fail on someone else's
 * commit. `--sha` overrides, and there is no `latest`.
 *
 * Usage:
 *   node scripts/whatsapp-emulator.mjs             start it (foreground)
 *   node scripts/whatsapp-emulator.mjs --prepare   clone and install only
 *   node scripts/whatsapp-emulator.mjs --sha <sha> a different revision
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The revision the gate is measured against. Bump deliberately, never automatically. */
export const EMULATOR_REPO = "https://github.com/fabianocruz/whatsapp-simulator.git";
export const EMULATOR_SHA = "2f1f8bc120ddbc1bfa23386622f9a93f3fdeb980";
export const EMULATOR_PORT = 4290;
/** Must match `WHATSAPP_SIM_APP_SECRET`. A local development value, not a credential. */
export const EMULATOR_APP_SECRET = "dev";
/** Where the channel's own receiver listens; the emulator posts its webhooks there. */
export const EMULATOR_WEBHOOK_PORT = 4399;

const CACHE = process.env["WHATSAPP_SIM_DIR"] ?? join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "codespar-whatsapp-simulator");

/** Corepack asks before downloading a package manager, which hangs a CI step forever. */
const ENV = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", encoding: "utf8", env: ENV, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

/** pnpm, because the emulator is a pnpm workspace. Corepack first, then whatever is on PATH. */
function pnpm() {
  if (spawnSync("pnpm", ["--version"], { encoding: "utf8", env: ENV }).status === 0) return ["pnpm"];
  if (spawnSync("corepack", ["--version"], { encoding: "utf8", env: ENV }).status === 0) return ["corepack", "pnpm"];
  throw new Error("the emulator needs pnpm (it is a pnpm workspace). Install it with `corepack enable` or `npm i -g pnpm@9.12.3`.");
}

export function prepare(sha = EMULATOR_SHA, say = (l) => process.stderr.write(l + "\n")) {
  mkdirSync(dirname(CACHE), { recursive: true });
  if (!existsSync(join(CACHE, ".git"))) {
    say(`whatsapp emulator: cloning ${EMULATOR_REPO} into ${CACHE}`);
    run("git", ["clone", "--quiet", EMULATOR_REPO, CACHE]);
  }
  const head = spawnSync("git", ["-C", CACHE, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  if (head !== sha) {
    run("git", ["-C", CACHE, "fetch", "--quiet", "origin"]);
    run("git", ["-C", CACHE, "checkout", "--quiet", sha]);
  }
  const [bin, ...rest] = pnpm();
  say(`whatsapp emulator: installing at ${sha.slice(0, 12)}`);
  run(bin, [...rest, "install", "--frozen-lockfile"], { cwd: CACHE });
  return CACHE;
}

function serve(sha, webhookUrl) {
  prepare(sha);
  const [bin, ...rest] = pnpm();
  const child = spawn(bin, [...rest, "cli", "--", "serve", "--webhook", webhookUrl, "--app-secret", EMULATOR_APP_SECRET], {
    cwd: CACHE,
    stdio: "inherit",
    env: ENV,
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  const sha = argv.includes("--sha") ? argv[argv.indexOf("--sha") + 1] : EMULATOR_SHA;
  const webhookUrl = argv.includes("--webhook") ? argv[argv.indexOf("--webhook") + 1] : `http://127.0.0.1:${EMULATOR_WEBHOOK_PORT}/`;
  if (argv.includes("--prepare")) {
    prepare(sha);
    process.stderr.write(`whatsapp emulator ready at ${CACHE}\n`);
  } else {
    process.stderr.write(`whatsapp emulator: ${ROOT} -> ${CACHE} @ ${sha.slice(0, 12)}, webhooks to ${webhookUrl}\n`);
    serve(sha, webhookUrl);
  }
}
