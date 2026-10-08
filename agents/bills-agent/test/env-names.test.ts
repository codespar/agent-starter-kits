/**
 * The kit reads `CODESPAR_API_URL` and `CODESPAR_PROJECT_ID`; the CodeSpar CLI
 * reads `CODESPAR_BASE_URL` and `CODESPAR_PROJECT`. As real processes: two
 * names that disagree stop the command with both named, and the CLI's names
 * alone are enough to run.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STAGING = "https://api.staging.codespar.dev";

describe("the commands refuse at the start when the two names disagree", () => {
  const BILLS = resolve(import.meta.dirname, "..");
  const BIN = resolve(BILLS, "../../packages/agent-runtime/bin.mjs");

  function run(args: string[], over: Record<string, string>) {
    const stateDir = mkdtempSync(join(tmpdir(), "env-names-"));
    const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd: BILLS,
      env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_API_URL: "", CODESPAR_PROJECT_ID: "", CODESPAR_BASE_URL: "", CODESPAR_PROJECT: "", BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs"), ...over },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("start: one sentence with both names and both values, no stack, nothing run", () => {
    const out = run(["start", "--input", "pague a escola de outubro", "--approve", "--json"], { CODESPAR_API_URL: "https://api.codespar.dev", CODESPAR_BASE_URL: STAGING });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("CODESPAR_API_URL=https://api.codespar.dev");
    expect(out.stderr).toContain(`CODESPAR_BASE_URL=${STAGING}`);
    expect(out.stderr).not.toMatch(/^\s+at /m);
  });

  it("verify: the same refusal, before any deployment is chosen", () => {
    const out = run(["verify", join(BILLS, "package.json")], { CODESPAR_PROJECT_ID: "prj_kit", CODESPAR_PROJECT: "prj_cli" });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("CODESPAR_PROJECT_ID=prj_kit");
    expect(out.stderr).toContain("CODESPAR_PROJECT=prj_cli");
  });

  it("start still runs when only the CLI's names are set", () => {
    const out = run(["start", "--input", "pague a escola de outubro", "--approve", "--json"], { CODESPAR_BASE_URL: STAGING, CODESPAR_PROJECT: "prj_cli" });
    expect(out.code).toBe(0);
  });
});
