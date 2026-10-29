/**
 * An interactive start with no model key and no transcript (#112) ends before
 * a run is set up, with one line saying what to do, and exit 1: never the
 * replay provider's throw and its stack trace. A replay stays reachable, but
 * only when it is asked for by name.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every directory this file makes under the system temp dir is removed when the file ends.
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const setupCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/setup.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/setup.js")>();
  return {
    ...original,
    setup: () => {
      setupCalls.count += 1;
      throw new Error("setup reached");
    },
  };
});

const { start } = await import("../src/commands/start.js");
const { loadAgent } = await import("../src/agent.js");

const HELLO_DIR = resolve(import.meta.dirname, "../../../agents/hello-agent");
const BIN = resolve(import.meta.dirname, "../bin.mjs");

describe("npm start, interactive, with no model key and no transcript", () => {
  let written: string[];

  beforeEach(() => {
    setupCalls.count = 0;
    written = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("CODESPAR_API_KEY", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("says what to do, exits 1, and never sets up a run", async () => {
    const agent = await loadAgent(HELLO_DIR);
    const code = await start(agent, ["--locale", "en"]);
    const terminal = written.join("");
    expect(code).toBe(1);
    expect(setupCalls.count).toBe(0);
    expect(terminal).toContain("no ANTHROPIC_API_KEY or GEMINI_API_KEY and no transcript");
    expect(terminal).toContain("--transcript <file>");
    expect(terminal).toContain("--scenario <name>");
    // The recorded runs it can replay, by name.
    expect(terminal).toContain("happy-path (");
    expect(terminal).not.toMatch(/Error:|\n\s+at /);
  });

  it("goes on to set up the run when a key is there", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "placeholder-model-key");
    const agent = await loadAgent(HELLO_DIR);
    await expect(start(agent, ["--locale", "en"])).rejects.toThrow("setup reached");
    expect(setupCalls.count).toBe(1);
  });
});

describe("npm start -- --scenario, with no model key", () => {
  it("still replays the scenario it names", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hello-no-key-"));
    tempDirs.push(stateDir);
    const result = spawnSync(process.execPath, [BIN, "start", "--scenario", "happy-path", "--locale", "en"], {
      cwd: HELLO_DIR,
      env: { ...process.env, ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", CODESPAR_API_KEY: "", HELLO_STATE_DIR: stateDir, HELLO_RUNS_DIR: join(stateDir, "runs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.stderr).toContain("== scenario happy-path");
    expect(result.stderr).not.toContain("no ANTHROPIC_API_KEY or GEMINI_API_KEY and no transcript");
    expect(result.status).toBe(0);
  });
});
