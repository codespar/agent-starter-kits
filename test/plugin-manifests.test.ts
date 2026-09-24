/**
 * Section 14.1: the plugin manifests parse, reference only files that exist,
 * and the skill carries the frontmatter a coding agent needs. The same check
 * `npm run check` runs first; here it is broken one way at a time.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlugin, ROOT } from "../scripts/check-plugin.mjs";

function copyPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), "codespar-plugin-"));
  for (const entry of [".claude-plugin", ".cursor-plugin", ".agents", "plugin.json", "mcp.json", ".mcp.json", "rules", "skills", "AGENTS.md", "CLAUDE.md", "docs", "packages"]) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  // The skill names files of the anchor agent; the copy keeps them without the runner's node_modules.
  cpSync(join(ROOT, "agents", "bills-agent"), join(dir, "agents", "bills-agent"), { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("/.codespar") && !src.includes("/runs") });
  cpSync(join(ROOT, "agents", "collections-agent"), join(dir, "agents", "collections-agent"), { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("/.codespar") && !src.includes("/runs") });
  cpSync(join(ROOT, "agents", "hello-agent"), join(dir, "agents", "hello-agent"), { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("/.codespar") && !src.includes("/runs") });
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
    writeFileSync(claude, readFileSync(claude, "utf8").replace("./.mcp.json", "./missing.json"));
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

  it("fail when an agent carries a copy of the runner", () => {
    const dir = copyPlugin();
    mkdirSync(join(dir, "agents", "hello-agent", "src", "commands"), { recursive: true });
    writeFileSync(join(dir, "agents", "hello-agent", "src", "commands", "resume.ts"), "export {};\n");
    expect(codes(dir)).toContain("agent_carries_runtime");
    const message = checkPlugin(dir).findings.find((f: { code: string }) => f.code === "agent_carries_runtime")?.message as string;
    expect(message).toContain("runtime-owned; delete it");

    const again = copyPlugin();
    writeFileSync(join(again, "agents", "hello-agent", "src", "main.ts"), "export {};\n");
    expect(codes(again)).toContain("agent_carries_runtime");
  });

  it("fail when the MCP pin drifts from the manifest's, when the two spellings of mcp.json differ, or when the root AGENTS.md and CLAUDE.md diverge", () => {
    const dir = copyPlugin();
    const drifted = JSON.stringify({ mcpServers: { codespar: { command: "npx", args: ["-y", "@codespar/mcp@0.0.1"] } } });
    writeFileSync(join(dir, "mcp.json"), drifted);
    expect(codes(dir)).toContain("mcp_split");
    writeFileSync(join(dir, ".mcp.json"), drifted);
    expect(codes(dir)).toContain("mcp_pin_drift");
    const unpinned = JSON.stringify({ mcpServers: { codespar: { command: "npx", args: ["-y", "@codespar/mcp"] } } });
    writeFileSync(join(dir, "mcp.json"), unpinned);
    writeFileSync(join(dir, ".mcp.json"), unpinned);
    expect(codes(dir)).toContain("mcp_unpinned");
    writeFileSync(join(dir, "CLAUDE.md"), readFileSync(join(dir, "CLAUDE.md"), "utf8") + "\nextra\n");
    expect(codes(dir)).toContain("agents_md_diverges");
  });
});
