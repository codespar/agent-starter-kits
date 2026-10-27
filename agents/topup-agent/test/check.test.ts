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
  const dir = mkdtempSync(join(tmpdir(), "topup-check-"));
  tempDirs.push(dir);
  for (const f of ["agent.yaml", "SYSTEM_PROMPT.md", "tools.json", "guardrails.json", "mandate.example.json", "AGENTS.md", "CLAUDE.md", "README.md", "runbook.md", ".env.example"]) cpSync(join(AGENT_DIR, f), join(dir, f));
  for (const d of ["scenarios", "evals", "channels"]) cpSync(join(AGENT_DIR, d), join(dir, d), { recursive: true });
  return dir;
}

const codes = (dir: string) => checkAgent(dir).findings.filter((f) => f.level === "error").map((f) => f.code);

describe("npm run check on the pull agent", () => {
  it("passes on the shipped agent: a charge tool is satisfied by the sweeping-pull maturity", () => {
    expect(codes(AGENT_DIR)).toEqual([]);
  });

  it("fails when the manifest stops declaring sweeping-pull, and when the charge tool is dropped", () => {
    const dir = copyAgent();
    const manifest = readFileSync(join(dir, "agent.yaml"), "utf8");
    const dropped = manifest.replace(/^  sweeping-pull:.*\n/m, "");
    expect(dropped).not.toBe(manifest);
    writeFileSync(join(dir, "agent.yaml"), dropped);
    expect(codes(dir)).toContain("tools_contradict_manifest");

    const again = copyAgent();
    const t = JSON.parse(readFileSync(join(again, "tools.json"), "utf8")) as { meta_tools: Array<{ effect: string }> };
    writeFileSync(join(again, "tools.json"), JSON.stringify({ ...t, meta_tools: t.meta_tools.filter((x) => x.effect !== "charge") }));
    expect(codes(again)).toContain("tools_contradict_manifest");
  });

  it("keeps the shipped mandate's caps equal to the defaults the bank authorization uses", () => {
    const mandate = JSON.parse(readFileSync(join(AGENT_DIR, "mandate.example.json"), "utf8")) as { cap_minor: number; per_tx_cap_minor: number };
    expect([mandate.cap_minor, mandate.per_tx_cap_minor]).toEqual([1000, 500]);
  });
});
