import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAgent } from "@codespar/agent-core";

const AGENT_DIR = resolve(import.meta.dirname, "..");

function copyAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "hello-check-"));
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

  it("fails when guardrails contradict the manifest", () => {
    const dir = copyAgent();
    const g = JSON.parse(readFileSync(join(dir, "guardrails.json"), "utf8")) as { approval: string; escalate_above?: { amount: number } };
    g.approval = "mandate";
    writeFileSync(join(dir, "guardrails.json"), JSON.stringify(g));
    expect(codes(dir)).toContain("guardrails_contradict_manifest");
    g.approval = "human";
    g.escalate_above = { amount: 999 };
    writeFileSync(join(dir, "guardrails.json"), JSON.stringify(g));
    expect(codes(dir)).toContain("guardrails_contradict_manifest");
  });

  it("fails when the prompt names a tool tools.json does not have, or when a payment tool appears without pix-out maturity", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "SYSTEM_PROMPT.md"), readFileSync(join(dir, "SYSTEM_PROMPT.md"), "utf8") + "\nYou may also call codespar_pay.\n");
    expect(codes(dir)).toContain("prompt_contradicts_tools");
    const t = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")) as { meta_tools: Array<Record<string, unknown>> };
    t.meta_tools.push({ name: "codespar_pay", effect: "payment", description: "pay", input_schema: { type: "object" } });
    writeFileSync(join(dir, "tools.json"), JSON.stringify(t));
    expect(codes(dir)).toContain("tools_contradict_manifest");
  });

  it("fails when AGENTS.md and CLAUDE.md diverge", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "CLAUDE.md"), readFileSync(join(dir, "CLAUDE.md"), "utf8") + "\nextra line\n");
    expect(codes(dir)).toContain("agents_md_diverges");
  });

  it("fails when mcp, cli or schema are missing", () => {
    for (const field of ["mcp", "cli", "schema"]) {
      const dir = copyAgent();
      writeFileSync(join(dir, "agent.yaml"), readFileSync(join(dir, "agent.yaml"), "utf8").split("\n").filter((l) => !l.startsWith(`${field}:`)).join("\n"));
      expect(codes(dir)).toContain("manifest_field_missing");
    }
  });

  it("fails when a README claims third-party verifiability or .env.example grows a third key", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8") + "\nO recibo é verificável por terceiro.\n");
    expect(codes(dir)).toContain("doc_overclaims");
    writeFileSync(join(dir, ".env.example"), readFileSync(join(dir, ".env.example"), "utf8") + "APPROVAL_KEY=x\n");
    expect(codes(dir)).toContain("env_example_extra");
  });

  it("fails when agent.yaml declares an event the API does not publish", () => {
    const dir = copyAgent();
    const manifest = join(dir, "agent.yaml");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/^events: \[\]/m, "events: [commerce.payment.settled]"));
    expect(codes(dir)).toContain("events_unknown");
  });

  it("fails when eval.yaml does not extend the manifest or redeclares a field", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "evals", "eval.yaml"), "extends: ../agent.yaml\nname: other\n");
    expect(codes(dir)).toContain("eval_redeclares_manifest");
    writeFileSync(join(dir, "evals", "eval.yaml"), "cases: []\n");
    expect(codes(dir)).toContain("eval_extends");
  });
});
