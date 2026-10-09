/**
 * `codespar init --template <agent>` makes a tree with every `packages/*`,
 * ONE agent and four root files (see `templates-read-nothing-outside.test.ts`).
 * The static check there reads paths. It cannot see a test that reaches
 * nothing foreign and still counts on the repository around it: the language
 * test asked `agents/` for more than 20 recorded turns, which is true here
 * and false in every scaffold but one, and each of them shipped with a red
 * `npm test`.
 *
 * So this builds that tree for the smallest agent and runs its tests, the way
 * a person who scaffolded it would. hello-agent has the least of everything
 * (two recorded turns, no payment, no channel), which makes it the tree where
 * a count on the whole repository fails first. The other agents' scaffolds
 * are the CLI's opt-in e2e; this one is the cheap alarm that runs on every
 * change here.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const AGENT = "hello-agent";
/** What a run leaves behind and what npm installs: not part of a template. */
const NOT_COPIED = new Set(["node_modules", "runs", ".codespar"]);

/** The template's tree: every package and one agent, verbatim, and the root files a test run reads. */
function scaffold(agent: string): string {
  const tree = mkdtempSync(join(tmpdir(), `kits-one-agent-${agent}-`));
  const copy = (path: string) => cpSync(join(ROOT, path), join(tree, path), { recursive: true, filter: (source) => !NOT_COPIED.has(basename(source)) });
  for (const pkg of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) if (pkg.isDirectory()) copy(join("packages", pkg.name));
  copy(join("agents", agent));
  for (const file of ["vitest.config.ts", "tsconfig.base.json"]) copy(file);
  // The dependencies are this repository's install: a scaffold installs the same pins.
  symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"), "dir");
  return tree;
}

interface VitestReport {
  numTotalTests: number;
  numFailedTests: number;
  testResults: Array<{ name: string; assertionResults: Array<{ status: string; fullName: string }> }>;
}

describe(`a scaffold of one agent (${AGENT})`, () => {
  it("runs the tests it carries and none fails", () => {
    const tree = scaffold(AGENT);
    const report = join(tree, "vitest-report.json");
    // A run of its own: not this run's worker.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST")));
    const result = spawnSync(process.execPath, [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--pool=forks", "--maxWorkers=1", "--reporter=json", `--outputFile=${report}`], {
      cwd: tree,
      env: { ...env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "" },
      encoding: "utf8",
      timeout: 240_000,
    });
    const ran = JSON.parse(readFileSync(report, "utf8")) as VitestReport;
    const failed = ran.testResults.flatMap((file) => file.assertionResults.filter((t) => t.status === "failed").map((t) => `${file.name.slice(tree.length + 1)}: ${t.fullName}`));

    expect(failed).toEqual([]);
    expect(ran.numFailedTests).toBe(0);
    expect(result.status).toBe(0);
    // It ran what a template carries, not an empty tree: the two packages' tests, and the agent's where it ships any (hello-agent ships none).
    expect(ran.numTotalTests).toBeGreaterThan(300);
    const units = ["packages/agent-core/", "packages/agent-runtime/", ...(existsSync(join(ROOT, "agents", AGENT, "test")) ? [`agents/${AGENT}/`] : [])];
    for (const unit of units) {
      expect([unit, ran.testResults.some((file) => file.name.slice(tree.length + 1).startsWith(unit))]).toEqual([unit, true]);
    }
  }, 300_000);
});
