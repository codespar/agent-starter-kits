/**
 * Section 14.1: the plugin manifests parse, reference only files that exist,
 * and the skill carries the frontmatter a coding agent needs. The same check
 * `npm run check` runs first; here it is broken one way at a time.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlugin, ROOT } from "../scripts/check-plugin.mjs";

function copyPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), "codespar-plugin-"));
  for (const entry of [".claude-plugin", ".cursor-plugin", ".agents", "plugin.json", "mcp.json", "rules", "skills", "AGENTS.md", "CLAUDE.md", "docs", "packages"]) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  // The skill names files of the anchor agent; the copy keeps them without the runner's node_modules.
  cpSync(join(ROOT, "agents", "bills-agent"), join(dir, "agents", "bills-agent"), { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("/.codespar") && !src.includes("/runs") });
  cpSync(join(ROOT, "agents", "collections-agent"), join(dir, "agents", "collections-agent"), { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("/.codespar") && !src.includes("/runs") });
  return dir;
}

const codes = (dir: string) => checkPlugin(dir).findings.filter((f: { level: string }) => f.level === "error").map((f: { code: string }) => f.code);

describe("the codespar-core plugin manifests", () => {
  it("pass on the shipped tree", () => {
    expect(codes(resolve(ROOT))).toEqual([]);
  });

  it("fail when a manifest does not parse or names a file that does not exist", () => {
    const dir = copyPlugin();
    writeFileSync(join(dir, ".cursor-plugin", "plugin.json"), "{ not json");
    expect(codes(dir)).toContain("manifest_unparseable");
    const claude = join(dir, ".claude-plugin", "plugin.json");
    writeFileSync(claude, readFileSync(claude, "utf8").replace("./mcp.json", "./missing.json"));
    expect(codes(dir)).toContain("manifest_path_missing");
  });

  it("fail when the skill loses its frontmatter, its name, or a file it references", () => {
    const dir = copyPlugin();
    const skill = join(dir, "skills", "codespar-agent-builder", "SKILL.md");
    const original = readFileSync(skill, "utf8");
    writeFileSync(skill, original.replace(/^---\n[\s\S]*?\n---\n/, ""));
    expect(codes(dir)).toContain("skill_frontmatter_missing");
    writeFileSync(skill, original.replace("name: codespar-agent-builder", "name: other"));
    expect(codes(dir)).toContain("skill_name");
    writeFileSync(skill, original);
    rmSync(join(dir, "skills", "codespar-agent-builder", "reference", "evals.md"));
    expect(codes(dir)).toContain("skill_reference_missing");
  });

  it("fail when the MCP pin drifts from the manifest's, or when the root AGENTS.md and CLAUDE.md diverge", () => {
    const dir = copyPlugin();
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { codespar: { command: "npx", args: ["-y", "@codespar/mcp@0.0.1"] } } }));
    expect(codes(dir)).toContain("mcp_pin_drift");
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { codespar: { command: "npx", args: ["-y", "@codespar/mcp"] } } }));
    expect(codes(dir)).toContain("mcp_unpinned");
    writeFileSync(join(dir, "CLAUDE.md"), readFileSync(join(dir, "CLAUDE.md"), "utf8") + "\nextra\n");
    expect(codes(dir)).toContain("agents_md_diverges");
  });
});
