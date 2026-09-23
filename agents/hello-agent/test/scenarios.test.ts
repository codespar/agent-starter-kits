import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkScenario, listScenarios, loadScenario, runScenario } from "../src/scenarios.js";

const runsDir = mkdtempSync(join(tmpdir(), "hello-runs-"));

describe("section 12: scenario packs, on the replay provider", () => {
  const required = ["happy-path", "prompt-injection"];

  it("ships the scenarios a read-only agent needs", () => {
    for (const name of required) expect(listScenarios()).toContain(name);
  });

  for (const name of required) {
    const scenario = loadScenario(name);
    for (const mode of scenario.modes) {
      it(`${name} [${mode}] ends in the states the pack declares`, async () => {
        const run = await runScenario(scenario, { mode, runsDir });
        const check = checkScenario(scenario, run);
        expect(check.failures).toEqual([]);
        expect(check.ok).toBe(true);
        expect(run.executions).toEqual([]);
        // Every event of the bundle (a tool refusal, here) carries an actor; no receipt exists.
        const eventsPath = join(run.bundle_dir, "events.jsonl");
        const events = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { actor?: unknown }) : [];
        for (const e of events) expect(e.actor).toBeDefined();
        expect(readdirSync(join(run.bundle_dir, "receipts"))).toEqual([]);
      });
    }
  }

  it("prompt-injection: the refusal is in the trail, with the agent's actor", async () => {
    const run = await runScenario(loadScenario("prompt-injection"), { mode: "human", runsDir });
    const events = readFileSync(join(run.bundle_dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; tool?: string; reason?: string; actor?: { type: string } });
    expect(events.filter((e) => e.type === "tool.refused").map((e) => [e.tool, e.reason, e.actor?.type])).toEqual([["codespar_pay", "tool_not_allowed", "agent"]]);
  });
});
