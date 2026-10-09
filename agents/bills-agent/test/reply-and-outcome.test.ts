/**
 * The replayed reply of `happy-path` is the same sentence whatever the run
 * does with the payment it proposed. It promises a result, which every run
 * has, and no receipt, which only a settled one has.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

interface Payload {
  reply: string;
  executions: Array<{ state: string; receipt_ids: string[] }>;
  receipts: string[];
}

function start(args: string[]) {
  const stateDir = mkdtempSync(join(tmpdir(), "bills-reply-"));
  const result = spawnSync(process.execPath, [BIN, "start", ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("npm start -- --input: the replayed reply against what the run did", () => {
  const INPUT = ["--input", "pague a escola de outubro"];

  it.each([
    { name: "a person denied", flags: ["--deny"], state: "denied" },
    { name: "nobody decided", flags: [], state: "awaiting_approval" },
  ])("cites no receipt when $name, and there is none", ({ flags, state }) => {
    const out = start([...INPUT, ...flags, "--json"]);
    const payload = JSON.parse(out.stdout.trim()) as Payload;
    expect(payload.executions.map((e) => e.state)).toEqual([state]);
    expect(payload.receipts).toEqual([]);
    expect(payload.reply).toContain("O resultado está no terminal.");
    expect(payload.reply).not.toMatch(/recibo/i);
    // Nothing on the terminal names a receipt either: the lines of the run and the reply are all there is.
    expect(out.stderr).not.toMatch(/recibo/i);
  });

  it("says the same when the payment settled, and the receipt is the terminal's own line", () => {
    const out = start([...INPUT, "--approve"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("O resultado está no terminal.");
    // One mention of a receipt: the path the terminal prints for the one that exists.
    expect(`${out.stdout}${out.stderr}`.match(/recibo/gi)).toHaveLength(1);
    expect(`${out.stdout}${out.stderr}`).toMatch(/recibo: .*rcpt_stub_/);
  });

  it("a payment inside the mandate that the hour sends to a human is not said to be paid", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-reply-night-"));
    const result = spawnSync(process.execPath, [BIN, "start", "--mode", "mandate", "--input", "e mais 300 reais pra escola, a excursao", "--transcript", "test/fixtures/excursao-300.transcript.jsonl", "--now", "2026-09-23T23:00:00-03:00", "--json"], {
      cwd: AGENT_DIR,
      env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    const payload = JSON.parse(result.stdout.trim()) as Payload;
    expect(payload.executions.map((e) => e.state)).toEqual(["awaiting_approval"]);
    expect(payload.reply).not.toMatch(/paguei|recibo/i);
  });
});
