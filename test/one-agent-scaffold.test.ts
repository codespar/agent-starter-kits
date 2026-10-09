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
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
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

/**
 * The scaffold's own test run, awaited. It takes tens of seconds, and a
 * synchronous spawn would hold this worker's event loop for all of them: the
 * runner's calls back to the main process time out at 60 seconds, and a run
 * with every test green ends in "Timeout calling onTaskUpdate" on a slow
 * machine. It is killed after `timeoutMs`, and says so.
 */
function runTests(tree: string, report: string, timeoutMs: number): Promise<{ status: number | null; timedOut: boolean }> {
  // A run of its own: not this run's worker.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST")));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--pool=forks", "--maxWorkers=1", "--reporter=json", `--outputFile=${report}`], {
      cwd: tree,
      env: { ...env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "" },
      stdio: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      done({ status, timedOut });
    });
  });
}

describe(`a scaffold of one agent (${AGENT})`, () => {
  it("runs the tests it carries and none fails", async () => {
    const tree = scaffold(AGENT);
    try {
      const report = join(tree, "vitest-report.json");
      const result = await runTests(tree, report, 240_000);
      expect(result.timedOut).toBe(false);
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
    } finally {
      // Removed whether it passed or not: the tree is a copy of two packages, and one left behind per run adds up. `node_modules` in it is a link, and removing the tree removes the link, never the install it points at.
      rmSync(tree, { recursive: true, force: true });
    }
    expect(existsSync(tree)).toBe(false);
    expect(lstatSync(join(ROOT, "node_modules")).isDirectory()).toBe(true);
  }, 300_000);
});
