/**
 * What the API rail says when `.codespar/mandate.json` is missing. The
 * sentence follows the kit: an agent with a `consent` step is sent to it, and
 * an agent without one is told the mandate is issued outside the terminal.
 */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoMandateError, setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

/** The agent's own files in a scratch directory, so no local `.codespar/` or `.env` decides the outcome. */
function scratchAgent() {
  const dir = mkdtempSync(join(tmpdir(), "bills-no-mandate-"));
  for (const file of ["agent.yaml", "SYSTEM_PROMPT.md", "tools.json", "guardrails.json", "mandate.example.json"]) cpSync(join(agent.dir, file), join(dir, file));
  return { ...agent, dir };
}

function refusal(): Error {
  const scratch = scratchAgent();
  try {
    setup(scratch, { rail: "api", provider: "replay", env: { CODESPAR_API_KEY: "csk_test_unit_0000" }, runsDir: join(scratch.dir, "runs"), stateDir: join(scratch.dir, ".codespar"), say: () => undefined });
  } catch (err) {
    return err as Error;
  }
  throw new Error("setup built an API rail without a signed mandate");
}

describe("bills-agent: the API rail without a signed mandate", () => {
  it("keeps pointing at the consent step, because this agent has one", () => {
    const err = refusal();
    expect(err).toBeInstanceOf(NoMandateError);
    expect(err.message).toMatch(/^no signed mandate yet/);
    expect(agent.kit.consent).toBeDefined();
    expect(err.message).toContain("npm run consent -- --yes");
  });
});
