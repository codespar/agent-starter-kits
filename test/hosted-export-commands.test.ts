/**
 * The commands a hosted run's export hands a person, for each kit of this
 * repository: they must install on a machine that has nothing but Node.
 *
 * A kit depends on `@codespar/agent-core` and `@codespar/agent-runtime`,
 * workspace packages of this repository that are not on npm. A copy of the
 * kit's folder alone answered `npm install` with E404 (Playground QA,
 * 2026-11-26). So the copy is the repository at the run's commit, the install
 * runs at its root, and the kit starts by its workspace.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostedRun, discoverAgentDirs } from "@codespar/agent-runtime";
import { exportCommands } from "../packages/agent-runtime/src/hosted/export-commands.js";
import { hostedKit, ports } from "../packages/agent-runtime/test/hosted-ports.js";

const ROOT = resolve(import.meta.dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { name: string; workspaces?: string[]; scripts?: Record<string, string>; dependencies?: Record<string, string> };
const workspacePackages = readdirSync(join(ROOT, "packages"))
  .map((dir) => join(ROOT, "packages", dir, "package.json"))
  .filter((path) => existsSync(path))
  .map((path) => readJson(path).name);

describe("the exported commands install outside this repository", () => {
  for (const dir of discoverAgentDirs(join(ROOT, "agents"))) {
    const name = basename(dir);
    it(`${name}: copies the repository at the run's commit, installs at its root, starts the kit by its workspace`, async () => {
      const pkg = readJson(join(dir, "package.json"));
      // Why a folder alone cannot install: the kit needs packages only this repository holds.
      expect(Object.keys(pkg.dependencies ?? {}).filter((dep) => workspacePackages.includes(dep)).length).toBeGreaterThan(0);
      expect(readJson(join(ROOT, "package.json")).workspaces).toContain("agents/*");
      expect(pkg.scripts?.["start"]).toBeDefined();

      const kit = await hostedKit(dir, ROOT);
      const example = kit.descriptor.examples.find((e) => e.replay);
      if (!example) throw new Error(`${name} has no recorded example`);
      const run = await createHostedRun(kit, ports(), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: example.id } });
      const { code } = await run.export();
      const commit = kit.descriptor.source.commit;

      expect(code.commands[0]).toBe(`npx degit codespar/agent-starter-kits#${commit} agent-starter-kits`);
      expect(code.commands).toContain("cd agent-starter-kits && npm install");
      const start = code.commands[code.commands.length - 1]!;
      expect(start).toMatch(new RegExp(`^npm start --workspace=agents/${name} -- `));
      expect(start).toContain(`--scenario ${example.id}`);
      // Nothing is installed from inside the kit's own folder.
      expect(code.commands.join("\n")).not.toMatch(/agents\/[a-z-]+#|cd [a-z-]+-agent\b/);
    });
  }
});

describe("the exported commands say and prepare what the Playground run used", () => {
  const bills = () => hostedKit(join(ROOT, "agents/bills-agent"), ROOT);

  it("integrated Test with a model: the CodeSpar API rail, the model and its id, the example's first message, each key named and none written", async () => {
    const { descriptor } = await bills();
    const lines = exportCommands(descriptor, { modelMode: "model", executor: "codespar-test", approvalMode: "mandate", locale: "pt-BR", exampleId: "conta-teste" }, { model: "claude-opus-4-7" });
    const all = lines.join("\n");
    expect(lines).toContain("cp -n agents/bills-agent/.env.example agents/bills-agent/.env");
    expect(all).toMatch(/^echo '.*agents\/bills-agent\/\.env.*CODESPAR_API_KEY.*csk_test_.*console da CodeSpar.*ANTHROPIC_API_KEY/m);
    expect(all).toContain("echo 'Modelo do Playground: claude-opus-4-7.'");
    expect(all).toContain("consentimento para o mandato de teste");
    const first = descriptor.examples.find((e) => e.id === "conta-teste")!.turns[0].input;
    expect(all).toContain(`a primeira mensagem foi ${JSON.stringify(first)}`);
    expect(lines[lines.length - 1]).toBe("ANTHROPIC_MODEL=claude-opus-4-7 npm start --workspace=agents/bills-agent -- --rail api --provider anthropic --mode mandate --locale pt-BR");
    // No key, no flag that confirms a payment, no comment line a zsh would run as a command.
    expect(all).not.toMatch(/csk_test_[A-Za-z0-9]{12,}|sk-ant-|--approve|--yes|--simulate-payer/);
    expect(lines.some((l) => l.startsWith("#"))).toBe(false);
  });

  it("a replay on the simulator says it runs on the stub rail and the recorded conversation, and asks for no key", async () => {
    const { descriptor } = await bills();
    const lines = exportCommands(descriptor, { modelMode: "replay", executor: "simulator", approvalMode: "human", locale: "en", exampleId: "happy-path" });
    expect(lines.join("\n")).not.toMatch(/\.env|API_KEY/);
    expect(lines).toContain("echo 'No key: example happy-path runs on the simulated rail (stub) and repeats the recorded conversation (replay). Nothing reaches CodeSpar.'");
    expect(lines[lines.length - 1]).toBe("npm start --workspace=agents/bills-agent -- --scenario happy-path --mode human --locale en");
  });

  it("a model id that is not one is left out of the shell line", async () => {
    const { descriptor } = await bills();
    const lines = exportCommands(descriptor, { modelMode: "model", executor: "simulator", approvalMode: "human", locale: "en", exampleId: null }, { model: "x; rm -rf ~" });
    expect(lines.join("\n")).not.toContain("rm -rf");
    expect(lines[lines.length - 1]).toBe("npm start --workspace=agents/bills-agent -- --provider anthropic --mode human --locale en");
  });

  it("a line with an apostrophe stays one shell word", async () => {
    const { descriptor } = await bills();
    const lines = exportCommands(descriptor, { modelMode: "model", executor: "simulator", approvalMode: "human", locale: "en", exampleId: null }, { model: "claude-opus-4-7" });
    expect(lines).toContain("echo 'The Playground'\\''s model: claude-opus-4-7.'");
  });

  it("the host's model reaches the export through the model port", async () => {
    const kit = await bills();
    const model = { mode: "model" as const, runtime: { name: "host", step: async () => ({ text: "ok" }) }, model: "claude-opus-4-7" };
    const run = await createHostedRun(kit, ports({ model }), { commandId: "c", modelMode: "model", executor: "simulator", options: { exampleId: "happy-path" } });
    const { code } = await run.export();
    expect(code.commands[code.commands.length - 1]).toMatch(/^ANTHROPIC_MODEL=claude-opus-4-7 npm start --workspace=agents\/bills-agent -- --provider anthropic /);
  });
});
