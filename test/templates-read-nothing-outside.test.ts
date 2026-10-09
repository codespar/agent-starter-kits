/**
 * `codespar init --template <agent>` scaffolds a template that codespar-core's
 * sync builds from this repository: every `packages/*` the agent needs,
 * verbatim, the ONE agent, verbatim, and four root files (LICENSE,
 * .gitignore, tsconfig.base.json, vitest.config.ts). Nothing else: no
 * `scripts/`, no `docs/`, no root `test/`, no sibling agent.
 *
 * So a file under `packages/` or `agents/` that reads one of those paths works
 * here and throws in every scaffold. Two tests of the runtime did exactly
 * that (the emulator pin in `scripts/`, and the collections and checkout
 * agents), and every template's `npm test` was red on files it had no way to
 * satisfy (codespar-core#191). They now live in this directory, which the sync
 * never copies. This keeps the next one out.
 *
 * What it reads: string literals starting with `../`, resolved against the
 * directory of the file they are in, which is how `import.meta.dirname`
 * paths are written here, and the same path spelled as arguments (`"..",
 * "..", "scripts"`). It flags one that leaves the file's own package or agent
 * AND lands on something a template does not carry. A path built from another
 * base, or computed, is not seen, and neither is a test that reaches nothing
 * foreign and still counts on the whole repository being around it (a floor
 * on how many recorded turns `agents/` holds). For those the proof is a
 * scaffold's own `npm test`: `one-agent-scaffold.test.ts` runs one here, and
 * the CLI's opt-in e2e runs the real ones.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

/** Top-level entries of this repository that no template carries. */
const KITS_ONLY = new Set(["scripts", "docs", "skills", "rules", "test", ".github", ".claude-plugin", ".cursor-plugin", ".agents", "README.md", "AGENTS.md", "CLAUDE.md", "mcp.json", ".mcp.json", "plugin.json"]);

const SKIP_DIRS = new Set(["node_modules", "runs", ".codespar"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|mts|mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The upward paths a source spells out: a `"../x/y"` literal, and the same
 * path written as arguments, `"..", "..", "x", "y"`, which is how
 * `join(import.meta.dirname, "..", "..", "..", "scripts")` reads. The second
 * form is returned joined, so both are judged as one path.
 */
function upwardPaths(source: string): string[] {
  const literals = [...source.matchAll(/["'`](\.\.\/[^"'`$]*)["'`]/g)].map((m) => m[1]!);
  const segments = [...source.matchAll(/((?:["']\.\.["']\s*,\s*)*["']\.\.["'](?:\s*,\s*["'][^"'`$,]+["'])*)/g)].map((m) => [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((s) => s[1]!).join("/"));
  return [...literals, ...segments];
}

/** Every `../` literal under `packages/*` and `agents/*` of `root` that reaches something a template made from that unit would not have. */
function outsideReads(root: string): string[] {
  const units = ["packages", "agents"].flatMap((top) => readdirSync(join(root, top), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(top, e.name)));
  const agents = new Set(units.filter((u) => u.startsWith(`agents${sep}`)));
  const found: string[] = [];
  for (const unit of units) {
    for (const file of sources(join(root, unit))) {
      for (const literal of upwardPaths(readFileSync(file, "utf8"))) {
        const target = relative(root, resolve(dirname(file), literal));
        if (!relative(unit, target).startsWith("..")) continue; // still inside its own package or agent
        const [top, name] = target.split(sep);
        // A sibling agent, not merely a path that happens to pass through `agents/` (an agent test resolving `../../packages/…` from its own directory).
        const sibling = top === "agents" && name !== undefined && agents.has(join("agents", name)) && join("agents", name) !== unit;
        const kitsOnly = KITS_ONLY.has(top!) || sibling;
        if (kitsOnly) found.push(`${relative(root, file)}: "${literal}" reaches ${target}, which a template does not carry`);
      }
    }
  }
  return found;
}

describe("a template reads nothing it does not carry", () => {
  it("no file under packages/ or agents/ reads scripts/, docs/, the root test/ or another agent", () => {
    expect(outsideReads(ROOT)).toEqual([]);
  });

  it("the check sees the two reads that turned every scaffold red, and not a path that stays home", () => {
    const tree = mkdtempSync(join(tmpdir(), "kits-outside-reads-"));
    const put = (path: string, body: string) => {
      mkdirSync(dirname(join(tree, path)), { recursive: true });
      writeFileSync(join(tree, path), body);
    };
    put("packages/agent-runtime/test/emulator.test.ts", 'readFileSync(resolve(import.meta.dirname, "../../../scripts/whatsapp-emulator.mjs"), "utf8");');
    put("packages/agent-runtime/test/fallback.test.ts", 'const COLLECTIONS = resolve(import.meta.dirname, "../../../agents/collections-agent");');
    put("packages/agent-runtime/src/channels/whatsapp/index.ts", 'import { checkOutbound } from "../rules.js";');
    put("agents/checkout-agent/test/cli.test.ts", 'const bin = resolve(import.meta.dirname, "../src/kit.ts");');
    put("agents/collections-agent/agent.yaml", "schema: 1\n");
    put("agents/checkout-agent/test/bin.test.ts", 'const bin = resolve(agentDir, "../../packages/agent-runtime/bin.mjs");');
    put("agents/checkout-agent/test/sibling.test.ts", 'const other = resolve(import.meta.dirname, "../../collections-agent/agent.yaml");');
    // The same reads spelled as arguments, which the literal form alone did not see; and the repository root, which every template has.
    put("packages/agent-core/test/pin.test.ts", 'const PIN = join(import.meta.dirname, "..", "..", "..", "scripts", "whatsapp-emulator.mjs");');
    put("packages/agent-core/test/language.test.ts", 'const ROOT = join(import.meta.dirname, "..", "..", "..");');
    put("packages/agent-core/test/home.test.ts", 'const SRC = join(import.meta.dirname, "..", "src", "language.ts");');
    expect(outsideReads(tree).sort()).toEqual([
      'agents/checkout-agent/test/sibling.test.ts: "../../collections-agent/agent.yaml" reaches agents/collections-agent/agent.yaml, which a template does not carry',
      'packages/agent-core/test/pin.test.ts: "../../../scripts/whatsapp-emulator.mjs" reaches scripts/whatsapp-emulator.mjs, which a template does not carry',
      'packages/agent-runtime/test/emulator.test.ts: "../../../scripts/whatsapp-emulator.mjs" reaches scripts/whatsapp-emulator.mjs, which a template does not carry',
      'packages/agent-runtime/test/fallback.test.ts: "../../../agents/collections-agent" reaches agents/collections-agent, which a template does not carry',
    ]);
  });
});
