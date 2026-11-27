import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkAgent } from "@codespar/agent-core";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const AGENT_DIR = resolve(import.meta.dirname, "..");

function copyAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "pix-payment-check-"));
  tempDirs.push(dir);
  for (const f of ["agent.yaml", "SYSTEM_PROMPT.md", "tools.json", "guardrails.json", "mandate.example.json", "AGENTS.md", "CLAUDE.md", "README.md", "runbook.md", ".env.example"]) cpSync(join(AGENT_DIR, f), join(dir, f));
  cpSync(join(AGENT_DIR, "scenarios"), join(dir, "scenarios"), { recursive: true });
  cpSync(join(AGENT_DIR, "evals"), join(dir, "evals"), { recursive: true });
  return dir;
}

const codes = (dir: string) => checkAgent(dir).findings.filter((f) => f.level === "error").map((f) => f.code);

describe("npm run check: the manifest is the index", () => {
  it("passes on the shipped agent", () => {
    expect(codes(AGENT_DIR)).toEqual([]);
  });

  it("fails when the charge tool is dropped, or when the manifest stops declaring the receivables maturity", () => {
    const dir = copyAgent();
    const t = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")) as { meta_tools: Array<{ effect: string }> };
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ ...t, meta_tools: t.meta_tools.filter((x) => x.effect !== "charge") }));
    expect(codes(dir)).toContain("tools_contradict_manifest");
    const again = copyAgent();
    const manifest = readFileSync(join(again, "agent.yaml"), "utf8");
    const dropped = manifest.replace(/^  bolepix-receivables:.*\n/m, "");
    expect(dropped).not.toBe(manifest);
    writeFileSync(join(again, "agent.yaml"), dropped);
    expect(codes(again)).toContain("tools_contradict_manifest");
  });

  it("fails when AGENTS.md and CLAUDE.md diverge, or when the README overclaims", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "CLAUDE.md"), readFileSync(join(dir, "CLAUDE.md"), "utf8") + "\nextra line\n");
    expect(codes(dir)).toContain("agents_md_diverges");
    writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8") + "\nThe record is third-party verifiable.\n");
    expect(codes(dir)).toContain("doc_overclaims");
  });
});
