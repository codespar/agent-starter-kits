/**
 * The bundle masks every payee key (#116), and `rerun` reads the refusals it
 * replays out of that bundle: by the position of the refused dispatch, never
 * by the masked key, which more than one key can share. A line the rail
 * refused in the original run is refused again in the rerun, and only it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Every directory this file makes under the system temp dir is removed when the file ends: one left behind per test adds up across runs.
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const PAYROLL = "roda a folha de outubro";
const REFUSED = "+5511988880002";
const MANDATE = JSON.parse(readFileSync(join(AGENT_DIR, "mandate.example.json"), "utf8")) as { beneficiaries: Array<{ payee: string }>; merchant_allowlist: string[] };

function cli(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [BIN, command, ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: "2026-10-07T14:00:00-03:00", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("supplier-payments-agent: rerun of a refused line, from a masked bundle", () => {
  it("writes no full payee key and replays the refusal", () => {
    const stateDir = tempDir(join(tmpdir(), "supplier-masked-"));
    const env = { SUPPLIER_PAYMENTS_STATE_DIR: stateDir, SUPPLIER_PAYMENTS_RUNS_DIR: join(stateDir, "runs") };
    const first = cli("start", ["--input", PAYROLL, "--approve", "--json"], { ...env, SUPPLIER_PAYMENTS_STUB_REFUSE: REFUSED });
    expect(first.code).toBe(1);
    const { run_id } = JSON.parse(first.stdout.trim()) as { run_id: string };

    const bundle = join(stateDir, "runs", run_id);
    const payees = [...new Set([...MANDATE.beneficiaries.map((b) => b.payee), ...MANDATE.merchant_allowlist])].filter((p) => p !== "*");
    // A batch's lines are the company's, never the model's tool call, so this run has no exception: no file names a key.
    for (const file of filesUnder(bundle)) {
      const text = readFileSync(file, "utf8");
      for (const payee of payees) expect(text.includes(payee), `${payee} in ${file}`).toBe(false);
    }

    const rerun = cli("rerun", [run_id, "--json"], env);
    expect(rerun.code).toBe(0);
    const r = JSON.parse(rerun.stdout.trim()) as { same_states: boolean; original_outcomes: string[]; rerun_outcomes: string[] };
    expect(r.same_states).toBe(true);
    expect(r.rerun_outcomes).toEqual(r.original_outcomes);
    expect(r.original_outcomes).toContain("failed");
  });
});
