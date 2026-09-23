/**
 * The contracts that need a real process: `--json` on stdout and nothing
 * else, the live-key refusal, and `npm run check`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const NODE = process.execPath;

function run(script: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(NODE, ["--disable-warning=ExperimentalWarning", "--import", "tsx", script, ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("npm start -- --input ... --json", () => {
  it("prints valid JSON on stdout and nothing else; people go to stderr; no execution, no receipt", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hello-json-"));
    const out = run("src/main.ts", ["--input", "quais contas vencem em outubro?", "--json"], { HELLO_STATE_DIR: stateDir, HELLO_RUNS_DIR: join(stateDir, "runs") });
    expect(out.code).toBe(0);
    const lines = out.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as { mode: string; rail: string; actor: { type: string }; tool_calls: Array<{ name: string; refused: boolean }>; executions: unknown[]; receipts: string[] };
    expect(payload.mode).toBe("human");
    expect(payload.rail).toBe("stub");
    expect(payload.actor.type).toBe("agent");
    expect(payload.tool_calls).toEqual([{ name: "list_bills", refused: false }]);
    expect(payload.executions).toEqual([]);
    expect(payload.receipts).toEqual([]);
    expect(out.stderr).toContain("replay");
  });

  it("refuses a key outside csk_test_ before anything else, although it never calls the API", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hello-live-"));
    const out = run("src/main.ts", ["--input", "quais contas vencem em outubro?", "--json"], { HELLO_STATE_DIR: stateDir, CODESPAR_API_KEY: ["csk", "live", "0000000000"].join("_") });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("csk_test_");
  });
});

describe("npm run check", () => {
  it("is green for the shipped agent and prints JSON with --json", () => {
    const out = run("src/commands/check.ts", ["--json"], {});
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout.trim()) as { ok: boolean; agent: string; findings: unknown[] };
    expect(report).toMatchObject({ ok: true, agent: "hello-agent" });
    expect(report.findings.filter((f) => (f as { level: string }).level === "error")).toEqual([]);
  });
});
