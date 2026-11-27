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
