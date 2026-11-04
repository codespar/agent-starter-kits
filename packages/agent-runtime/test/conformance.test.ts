/**
 * Hosted conformance: every agent under `agents/`, discovered from its
 * `agent.yaml` and never listed, plus a test-only kit no code names, passes
 * the same checks a host relies on before it runs one. Nothing below branches
 * on a kit's name; a seventh kit is checked the day its directory lands.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadManifest, loadToolsFile, parseTranscript } from "@codespar/agent-core";
import { loadAgent } from "../src/agent.js";
import { describeKit, discoverAgentDirs } from "../src/hosted/catalog.js";
import { listScenarios, loadScenario } from "../src/scenarios.js";
import { setup } from "../src/setup.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_KIT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/kits/tip-jar-agent");
const AGENT_DIRS = discoverAgentDirs(join(ROOT, "agents"));
const ALL = [...AGENT_DIRS, TEST_KIT];
const FAKE_COMMIT = "0".repeat(40);
const scratch = mkdtempSync(join(tmpdir(), "hosted-conformance-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

// A scaffold of one agent carries this file too: nothing here counts the agents of this repository (the root `test/` does).
describe("discovery", () => {
  it("finds every directory under agents/ that holds an agent.yaml, named as its manifest names it", () => {
    const expected = readdirSync(join(ROOT, "agents"), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(ROOT, "agents", e.name, "agent.yaml")));
    expect(AGENT_DIRS.length).toBe(expected.length);
    expect(AGENT_DIRS.map((d) => loadManifest(join(d, "agent.yaml")).manifest.name)).toEqual(AGENT_DIRS.map((d) => d.split("/").pop()));
  });
});

describe.each(ALL.map((dir) => [dir.split("/").pop()!, dir]))("%s", (_name, dir) => {
  const loaded = loadManifest(join(dir, "agent.yaml"));
  const manifest = loaded.manifest;
  const tools = loadToolsFile(loaded.resolvePath(manifest.tools));
  const toolNames = new Set([...tools.meta_tools, ...tools.local_tools].map((t) => t.name));

  it("has the entrypoint the artifact compiles: src/kit.ts exporting `agent`", async () => {
    expect(existsSync(join(dir, "src/kit.ts"))).toBe(true);
    const module = (await import(join(dir, "src/kit.ts"))) as { agent?: { dir: string; kit: unknown } };
    expect(module.agent?.dir).toBe(dir);
    const agent = await loadAgent(dir);
    expect(agent.dir).toBe(dir);
  });

  it("has every file the manifest names", () => {
    for (const rel of [manifest.tools, manifest.guardrails, manifest.mandate_schema, manifest.agents_md, "SYSTEM_PROMPT.md"]) expect(existsSync(loaded.resolvePath(rel)), rel).toBe(true);
    expect(statSync(loaded.resolvePath(manifest.scenarios)).isDirectory()).toBe(true);
  });

  it("runs on the simulator executor with an empty configuration: no key, no variable, no file of its own", async () => {
    const agent = await loadAgent(dir);
    const state = mkdtempSync(join(scratch, "state-"));
    const s = setup(agent, { rail: "stub", env: {}, stateDir: state, runsDir: join(state, "runs"), say: () => {} });
    try {
      expect(s.railKind).toBe("stub");
      expect(s.config).toEqual({});
      // Every tool the model may call has a handler, and no handler answers a tool the model cannot call.
      expect(Object.keys(s.handlers).sort()).toEqual([...toolNames].sort());
    } finally {
      s.close();
    }
  });

  it("reads its configuration through the port, never from process.env", () => {
    const offenders = filesUnder(join(dir, "src")).filter((f) => /process\.env/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("has examples whose turns, modes and recorded tool calls agree with the manifest and tools.json", async () => {
    const agent = await loadAgent(dir);
    const names = listScenarios(agent);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const scenario = loadScenario(agent, name);
      expect(scenario.name, `${name}.json`).toBe(name);
      for (const mode of scenario.modes) expect(manifest.approval, `${name}: mode ${mode}`).toContain(mode);
      const transcript = resolve(dir, "scenarios", scenario.transcript);
      expect(existsSync(transcript), `${name}: ${scenario.transcript}`).toBe(true);
      const steps = parseTranscript(readFileSync(transcript, "utf8"));
      expect(steps.length, `${name}: an empty transcript replays nothing`).toBeGreaterThan(0);
      // A recorded call outside tools.json is legitimate only as the prompt-injection case: the loop refuses it, which is what the pack proves.
      const outside = steps.flatMap((s) => s.tool_calls ?? []).filter((c) => !toolNames.has(c.name));
      if (outside.length > 0) expect(name, `${name} calls ${outside.map((c) => c.name).join(", ")}`).toMatch(/injection/);
    }
  });

  it("derives a descriptor the contract accepts, with the prerequisites its manifest declares", async () => {
    const agent = await loadAgent(dir);
    const d = describeKit(agent, { root: ROOT, commit: FAKE_COMMIT, shared: ["packages/agent-core/src", "packages/agent-runtime/src"] });
    expect(d.id).toBe(manifest.name);
    expect(d.requiredCapabilities).toEqual(Object.keys(manifest.maturity).sort());
    expect(d.approvalModes).toEqual(manifest.approval);
    expect(d.supportedExecutors[0]).toBe("simulator");
    const moves = [...tools.meta_tools, ...tools.local_tools].some((t) => t.effect === "payment" || t.effect === "charge");
    expect(d.needsMandate).toBe(moves);
    for (const e of d.executors) for (const capability of e.blockedBy) expect(manifest.maturity[capability]).toBe("blocked");
    // codespar-test: money on the CodeSpar API, as platform proposals (CONTRATO.md v1.1); a kit on another rail has none.
    expect(d.supportedExecutors.includes("codespar-test")).toBe(moves && agent.kit.apiRailKey !== "none");
  });
});

describe("no host code names a kit", () => {
  it("the hosted sources hold no agent id", () => {
    const ids = ALL.map((d) => loadManifest(join(d, "agent.yaml")).manifest.name);
    const hostedSources = filesUnder(join(ROOT, "packages/agent-runtime/src/hosted"));
    for (const file of hostedSources) {
      const text = readFileSync(file, "utf8");
      for (const id of ids) expect(text.includes(id), `${file} names ${id}`).toBe(false);
    }
  });
});
