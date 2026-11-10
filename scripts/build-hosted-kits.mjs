#!/usr/bin/env node
/**
 * The hosted-kits artifact (CONTRATO.md section 7): one npm package holding
 * the runtime, the core and every agent, compiled by this repository's own
 * TypeScript (no bundler), with a catalog whose digests are of the files
 * that ship. The CodeSpar API pins the tarball by URL and integrity and runs
 * these modules; it never copies a prompt.
 *
 *   build/hosted-kits/package/            the laid-out package
 *   build/hosted-kits/codespar-hosted-kits-<version>.tgz
 *   build/hosted-kits/catalog.json         a copy, for the release notes
 *
 * Usage: node scripts/build-hosted-kits.mjs [--out build/hosted-kits] [--allow-dirty]
 * `--allow-dirty` is for a local try only: the digests then name files no commit holds.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const OUT = resolve(ROOT, argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "build/hosted-kits");
const INTERNAL = ["@codespar/agent-core", "@codespar/agent-runtime"];
/**
 * The model SDKs a terminal uses. A host passes its own model (ModelPort) and never loads them: the providers import them on
 * their first step, not at import. So they ship as optional peers, and the API installs nothing of them.
 */
const OPTIONAL_PEERS = ["@anthropic-ai/sdk", "@google/genai"];
/** What never ships from an agent's directory: local state, runs, tests, evals, its npm and tsc files, and its TypeScript (shipped compiled). */
const NOT_SHIPPED = new Set(["node_modules", ".codespar", "runs", "test", "evals", "package.json", "tsconfig.json"]);

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
if (!argv.includes("--allow-dirty") && git("status", "--porcelain", "--", "agents", "packages", "tsconfig.hosted.json", "tsconfig.hosted-types.json") !== "") {
  process.stderr.write("build-hosted-kits: agents/ or packages/ has uncommitted changes; the digests would name files no commit holds (--allow-dirty for a local try)\n");
  process.exit(2);
}
const version = `0.1.0-hosted.${commit.slice(0, 12)}`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const agentDirs = readdirSync(join(ROOT, "agents"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(ROOT, "agents", e.name, "agent.yaml")))
  .map((e) => e.name)
  .sort();

rmSync(OUT, { recursive: true, force: true });
const TSC = join(OUT, "tsc");
const PKG = join(OUT, "package");
mkdirSync(PKG, { recursive: true });

// 1. Compile with the repository's own tsc: JS for everything, declarations for the core and the runtime.
const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
for (const project of ["tsconfig.hosted.json", "tsconfig.hosted-types.json"]) execFileSync(process.execPath, [tsc, "-p", join(ROOT, project), "--outDir", TSC], { cwd: ROOT, stdio: "inherit" });

// 2. The two packages every kit imports, bundled inside the artifact so a kit and its host share ONE copy of each.
const dependencies = {};
const addDependencies = (from, deps = {}) => {
  for (const [name, range] of Object.entries(deps)) {
    if (INTERNAL.includes(name)) continue;
    if (dependencies[name] && dependencies[name] !== range) throw new Error(`build-hosted-kits: ${name} is pinned ${dependencies[name]} and ${range} (${from}); one artifact installs one version`);
    dependencies[name] = range;
  }
};
const jsOf = (spec) => spec.replace(/\.ts$/, ".js");
for (const [name, dir] of [["@codespar/agent-core", "packages/agent-core"], ["@codespar/agent-runtime", "packages/agent-runtime"]]) {
  const source = readJson(join(ROOT, dir, "package.json"));
  addDependencies(dir, source.dependencies);
  const target = join(PKG, "node_modules", name);
  cpSync(join(TSC, dir, "src"), join(target, "src"), { recursive: true });
  const exports = Object.fromEntries(Object.entries(source.exports).map(([key, spec]) => [key, { types: spec.replace(/\.ts$/, ".d.ts"), default: jsOf(spec) }]));
  writeFileSync(join(target, "package.json"), JSON.stringify({ name, version: source.version, type: "module", main: jsOf(source.main), types: source.types.replace(/\.ts$/, ".d.ts"), exports }, null, 2) + "\n");
}

// 3. Every agent: its files as they are, its src compiled.
for (const name of agentDirs) {
  const from = join(ROOT, "agents", name);
  const to = join(PKG, "kits", name);
  addDependencies(`agents/${name}`, readJson(join(from, "package.json")).dependencies);
  cpSync(from, to, { recursive: true, filter: (src) => { const rel = relative(from, src); const base = rel.split("/").pop(); return rel === "" || !(NOT_SHIPPED.has(base) || base.startsWith(".env") || (rel.startsWith("src/") || rel === "src")); } });
  cpSync(join(TSC, "agents", name, "src"), join(to, "src"), { recursive: true });
}

// 4. The entry a host imports: the runtime, with the catalog and the kits bound to this package's own directory.
writeFileSync(
  join(PKG, "host.js"),
  `// Generated by scripts/build-hosted-kits.mjs at ${commit}.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostedCatalog as loadAt, openHostedKit as openAt } from "@codespar/agent-runtime";
export * from "@codespar/agent-runtime";
const ROOT = dirname(fileURLToPath(import.meta.url));
/** This artifact's catalog, every kit's digest recomputed from the installed files. */
export const loadHostedCatalog = (reader) => loadAt(ROOT, reader);
/** One kit of this artifact, by id and the digest a run was created with. */
export const openHostedKit = (catalog, id, packageDigest) => openAt(ROOT, catalog, id, packageDigest);
`,
);
writeFileSync(
  join(PKG, "host.d.ts"),
  `export * from "@codespar/agent-runtime";
import type { CatalogReader, HostedCatalog, HostedKit } from "@codespar/agent-runtime";
export declare function loadHostedCatalog(reader?: CatalogReader): HostedCatalog;
export declare function openHostedKit(catalog: HostedCatalog, id: string, packageDigest: string): Promise<HostedKit>;
`,
);
writeFileSync(
  join(PKG, "package.json"),
  JSON.stringify(
    {
      name: "@codespar/hosted-kits",
      version,
      description: `CodeSpar starter kits, compiled for a host, from codespar/agent-starter-kits@${commit}.`,
      license: "MIT",
      type: "module",
      exports: { "./host": { types: "./host.d.ts", default: "./host.js" }, "./catalog.json": "./catalog.json" },
      engines: { node: ">=22.13" },
      // The two internal packages are listed AND bundled: npm installs the copies inside the tarball, never a registry version.
      dependencies: Object.fromEntries(
        [...Object.entries(dependencies).filter(([name]) => !OPTIONAL_PEERS.includes(name)), ...INTERNAL.map((name) => [name, readJson(join(PKG, "node_modules", name, "package.json")).version])].sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      peerDependencies: Object.fromEntries(OPTIONAL_PEERS.filter((name) => dependencies[name]).map((name) => [name, dependencies[name]])),
      peerDependenciesMeta: Object.fromEntries(OPTIONAL_PEERS.filter((name) => dependencies[name]).map((name) => [name, { optional: true }])),
      bundleDependencies: INTERNAL,
      repository: { type: "git", url: "https://github.com/codespar/agent-starter-kits" },
      codespar: { commit },
    },
    null,
    2,
  ) + "\n",
);

// 5. The catalog, from the compiled kits as they lie in the package, with the digests of the files that ship.
const runtime = await import(pathToFileURL(join(PKG, "node_modules/@codespar/agent-runtime/src/index.js")).href);
const kits = [];
for (const name of agentDirs) {
  const { agent } = await import(pathToFileURL(join(PKG, "kits", name, "src/kit.js")).href);
  kits.push(runtime.describeKit(agent, { root: PKG, commit, shared: runtime.ARTIFACT_SHARED, digestOf: (id) => runtime.artifactDigest(PKG, id) }));
}
kits.sort((a, b) => (a.id < b.id ? -1 : 1));
const catalog = runtime.HostedCatalogSchema.parse({ v: 1, contractVersion: runtime.CONTRACT_VERSION, artifact: { name: "@codespar/hosted-kits", version, commit }, kits });
writeFileSync(join(PKG, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
writeFileSync(join(OUT, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
// The catalog a host loads must verify against the package as laid out.
runtime.loadHostedCatalog(PKG);

// 6. The tarball, and its integrity as npm will record it.
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", OUT], { cwd: PKG, encoding: "utf8" }))[0];
const tgz = join(OUT, packed.filename);
const integrity = `sha512-${createHash("sha512").update(readFileSync(tgz)).digest("base64")}`;
writeFileSync(join(OUT, "artifact.json"), JSON.stringify({ name: packed.name, version, commit, file: packed.filename, integrity, size: packed.size, kits: catalog.kits.map((k) => ({ id: k.id, version: k.version, packageDigest: k.source.packageDigest })) }, null, 2) + "\n");
rmSync(TSC, { recursive: true, force: true });
process.stderr.write(`build-hosted-kits: ${packed.filename}, ${catalog.kits.length} kits, ${integrity}, from ${commit}\n`);
