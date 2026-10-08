/**
 * `rerun` replays the model's side of a run. An adversarial case of
 * `kind: events` has none: it drives rail deliveries and never asks the
 * model, so its bundle holds no `transcript.jsonl`. `rerun` says so and stops,
 * instead of dying on the file it cannot open.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAdversarialCase, runAdversarialCase } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

function rerun(args: string[], runsDir: string) {
  const result = spawnSync(process.execPath, [BIN, "rerun", ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", BILLS_RUNS_DIR: runsDir, BILLS_STATE_DIR: join(runsDir, "state") },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("npm run rerun <run-id> on a run with no model turn", () => {
  it("refuses the adversarial events case by name of what is missing, with no stack", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "bills-rerun-adv-"));
    const original = await runAdversarialCase(agent, loadAdversarialCase(agent, "webhook-replay"), { runsDir });
    expect(original.ok).toBe(true);
    expect(existsSync(join(runsDir, original.run_id, "transcript.jsonl"))).toBe(false);

    const out = rerun([original.run_id], runsDir);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`runs/${original.run_id} has no transcript.jsonl`);
    expect(out.stderr).toContain("nothing to replay");
    expect(out.stderr).not.toContain("ENOENT");
    expect(out.stderr).not.toMatch(/^\s+at /m);

    const asJson = rerun([original.run_id, "--json"], runsDir);
    expect(asJson.code).toBe(1);
    expect(asJson.stdout).toBe("");
    expect(asJson.stderr).not.toContain("ENOENT");
  });

  it("still replays an adversarial case that did ask the model", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "bills-rerun-adv-"));
    const original = await runAdversarialCase(agent, loadAdversarialCase(agent, "prompt-injection"), { runsDir });
    const out = rerun([original.run_id], runsDir);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("rerun ok");
  });
});
