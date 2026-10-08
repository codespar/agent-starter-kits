/**
 * What the terminal says a run did is counted from the engine, not taken from
 * the reply. The replayed reply of the payroll says it ran and the receipts
 * are on the terminal; these runs are the two where that is false (every line
 * already paid; every line failed), driven as real processes because the exit
 * code is part of the contract.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const PAYROLL = "roda a folha de outubro";
const PAYROLL_KEYS = "ana.ribeiro@example.com.br,+5511988880002,11144477735";

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [BIN, "start", ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: "2026-10-07T14:00:00-03:00", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A person at the keyboard: each answer is typed when its prompt shows, because readline drops a line that arrives before the question. */
function converse(args: string[], env: Record<string, string>, answers: Array<{ after: string; type: string }>): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, "start", ...args], { cwd: AGENT_DIR, env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: "2026-10-07T14:00:00-03:00", ...env } });
    let stdout = "";
    let stderr = "";
    const pending = [...answers];
    const feed = () => {
      while (pending[0] && (stdout + stderr).includes(pending[0].after)) child.stdin.write(pending.shift()!.type + "\n");
      if (pending.length === 0) child.stdin.end();
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); feed(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); feed(); });
    child.on("error", fail);
    child.on("close", () => done(stdout));
  });
}

function scratch(label: string): Record<string, string> {
  const stateDir = mkdtempSync(join(tmpdir(), `supplier-outcome-${label}-`));
  return { SUPPLIER_PAYMENTS_STATE_DIR: stateDir, SUPPLIER_PAYMENTS_RUNS_DIR: join(stateDir, "runs") };
}

type Payload = { reply: string; executions: Array<{ state: string }>; outcome: { settled: number; failed: number; declined: number; already_paid: number; open: number } };

describe("npm start -- --input: the line after the reply is the engine's count", () => {
  it("a payroll that settles says so and exits 0", () => {
    const out = run(["--input", PAYROLL, "--approve"], scratch("settled"));
    expect(out.stdout).toContain("resultado deste run: 3 liquidada(s), 0 com falha ou recusada(s), 0 negada(s) ou expirada(s), 0 pulada(s) por já paga(s), 0 em aberto");
    expect(out.code).toBe(0);
  });

  it("a second run of a paid payroll drafts nothing, says three lines were already paid, and exits 0", () => {
    const env = scratch("paid");
    expect(run(["--input", PAYROLL, "--approve"], env).code).toBe(0);
    const again = run(["--input", PAYROLL, "--approve", "--json"], env);
    const payload = JSON.parse(again.stdout.trim()) as Payload;
    expect(payload.executions).toHaveLength(0);
    expect(payload.outcome).toMatchObject({ settled: 0, failed: 0, already_paid: 3, open: 0 });
    expect(again.code).toBe(0);

    const told = run(["--input", PAYROLL, "--approve"], env);
    expect(told.stdout).toContain("resultado deste run: 0 liquidada(s), 0 com falha ou recusada(s), 0 negada(s) ou expirada(s), 3 pulada(s) por já paga(s), 0 em aberto");
  });

  it("a payroll the rail refuses line by line says three failed and exits 1, whatever the recorded reply says", () => {
    const out = run(["--input", PAYROLL, "--approve", "--json"], { ...scratch("failed"), SUPPLIER_PAYMENTS_STUB_REFUSE: PAYROLL_KEYS });
    const payload = JSON.parse(out.stdout.trim()) as Payload;
    expect(payload.executions.map((e) => e.state)).toEqual(["failed", "failed", "failed"]);
    expect(payload.reply).toContain("recibo no terminal");
    expect(payload.outcome).toMatchObject({ settled: 0, failed: 3, already_paid: 0, open: 0 });
    expect(out.code).toBe(1);
  });

  it("a payroll a person denies is not a failed process: three declined, exit 0", () => {
    const out = run(["--input", PAYROLL, "--deny", "--json"], scratch("denied"));
    expect((JSON.parse(out.stdout.trim()) as Payload).outcome).toMatchObject({ settled: 0, failed: 0, declined: 3, already_paid: 0, open: 0 });
    expect(out.code).toBe(0);
  });

  it("--help says what the exit code means", () => {
    const out = run(["--help"], {});
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("exit (--input): 0");
  });
});

describe("npm start, interactive: every turn's reply is followed by the engine's count", () => {
  it("prints the count of the turn under the replayed reply", async () => {
    const stdout = await converse(["--transcript", "scenarios/happy-path.transcript.jsonl", "--locale", "en"], { ...scratch("interactive"), SUPPLIER_PAYMENTS_STUB_REFUSE: PAYROLL_KEYS }, [
      { after: "Ctrl+D", type: PAYROLL },
      { after: "Approve the list?", type: "all" },
    ]);
    expect(stdout).toContain("recibo no terminal");
    expect(stdout).toContain("result of this run: 0 settled, 3 failed or refused, 0 denied or expired, 0 skipped as already paid, 0 open");
  });
});
