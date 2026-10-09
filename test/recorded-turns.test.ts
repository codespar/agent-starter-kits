/**
 * `packages/agent-core/test/language.test.ts` is copied into every scaffold
 * `codespar init --template <agent>` makes, where `agents/` holds ONE agent.
 * It used to ask for more than 20 recorded turns, which only this repository
 * has: bills-agent records 11, collections-agent 18, hello-agent 2, and their
 * scaffolds' `npm test` was red on a count they had no way to reach.
 *
 * The count is a fact about this repository, so it is asked here, which no
 * template carries. What the scaffold keeps is the part that is true of any
 * tree: every recorded turn it does have reads as Portuguese.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLanguage } from "../packages/agent-core/src/language.js";
import { recordedTurns } from "../packages/agent-core/test/recorded-turns.js";

const ROOT = resolve(import.meta.dirname, "..");
const RECORDED = ["scenarios", join("channels", "whatsapp")];

const readAsEnglish = (root: string) => recordedTurns(root).filter((text) => detectLanguage(text) === "en");

/** The tree a scaffold of `agent` has under `agents/`: that agent's recordings, and no sibling. */
function scaffoldOf(agent: string): string {
  const tree = mkdtempSync(join(tmpdir(), `kits-scaffold-${agent}-`));
  for (const dir of RECORDED) {
    const from = join(ROOT, "agents", agent, dir);
    if (existsSync(from)) cpSync(from, join(tree, "agents", agent, dir), { recursive: true });
  }
  return tree;
}

describe("the recorded turns of this repository", () => {
  const agents = readdirSync(join(ROOT, "agents"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  it("are more than 20, and none reads as English", () => {
    expect(recordedTurns(ROOT).length).toBeGreaterThan(20);
    expect(readAsEnglish(ROOT)).toEqual([]);
  });

  it("every agent records at least one, so no scaffold's language test passes on nothing", () => {
    for (const agent of agents) expect([agent, recordedTurns(scaffoldOf(agent)).length > 0]).toEqual([agent, true]);
  });

  it("a scaffold of one agent holds what its copy of language.test.ts asks, whatever its count", () => {
    const counts = agents.map((agent) => {
      const tree = scaffoldOf(agent);
      expect([agent, readAsEnglish(tree)]).toEqual([agent, []]);
      return recordedTurns(tree).length;
    });
    // The case that was red: an agent alone is below the floor the whole repository clears.
    expect(Math.min(...counts)).toBeLessThanOrEqual(20);
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(recordedTurns(ROOT).length);
  });

  it("an English turn in a scaffold is still caught", () => {
    const tree = scaffoldOf("hello-agent");
    mkdirSync(join(tree, "agents", "hello-agent", "scenarios"), { recursive: true });
    writeFileSync(join(tree, "agents", "hello-agent", "scenarios", "english.json"), JSON.stringify({ turns: [{ input: "pay the electricity bill for October" }] }));
    expect(readAsEnglish(tree)).toEqual(["pay the electricity bill for October"]);
  });
});
