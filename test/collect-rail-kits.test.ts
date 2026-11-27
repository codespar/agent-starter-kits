/**
 * The command a Playground charge run exports (`--rail api --simulate-payer`)
 * reproduces the Playground's calls outside it: the charging kits, on their
 * API rail, charge through Collect's public routes and their Test payer pays
 * through Collect's (D1, 27/11/2026; docs/OPEN_QUESTIONS.md §69). The kit runs
 * here as `npm start` runs it, through `setup` with the person's environment,
 * against a local server that answers the routes' documented shapes; only the
 * model is the recorded one and the clock is the recording's, so the recorded
 * due date is inside the envelope.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { handleExecution, loadScenario, scenariosDir, setup } from "@codespar/agent-runtime";
import { loadAgent } from "../packages/agent-runtime/src/agent.js";
import { startFakeCollect } from "../packages/agent-core/test/fake-collect-api.js";

const ROOT = resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

describe("collections-agent --rail api: the Playground's charge, through Collect's public routes", () => {
  it("issues the link, the Test payer pays it once at the provider's sandbox, the read settles it, and the Collect receipt is kept", { timeout: 60_000 }, async () => {
    const fake = await startFakeCollect({ issuingReads: 1 });
    try {
      const agent = await loadAgent(join(ROOT, "agents/collections-agent"));
      const scenario = loadScenario(agent, "acordo-1150");
      const pinned = new Date(scenario.now);
      const said: string[] = [];
      const told: string[] = [];
      const s = setup(agent, {
        mode: "mandate",
        rail: "api",
        provider: "replay",
        transcript: resolve(scenariosDir(agent), scenario.transcript),
        stateDir: temp("collections-collect-state-"),
        runsDir: temp("collections-collect-runs-"),
        now: () => pinned,
        env: { CODESPAR_API_KEY: "csk_test_unit_0000", CODESPAR_API_URL: fake.url },
        say: (l) => said.push(l),
        locale: "en",
      });
      try {
        expect(s.railKind).toBe("api");
        expect(s.rail.name).toBe("codespar-collect");
        const runtime = s.makeRuntime();
        const loop = s.makeLoop(runtime, (execution) =>
          handleExecution(execution, { setup: s, approver: { id: "usr_operator", channel: "terminal" }, decision: "approve", say: (l) => said.push(l), tell: (l) => told.push(l), ask: async () => "s", simulatePayer: true, waitSeconds: 30 }),
        );
        for (const turn of scenario.turns) await loop.turn(turn.input);

        const executions = s.engine.list();
        expect(executions.map((e) => [e.state, e.reason ?? null])).toEqual([["settled", null]]);
        const outcome = executions[0]!.outcomes[0]!;
        expect(outcome.transaction_id).toMatch(/^cl_/);
        expect(outcome.receipt_id).toMatch(/^clr_/);
        // The Collect receipt is in the run's bundle.
        expect(readdirSync(join(s.bundle.dir, "receipts"))).toEqual([`${outcome.receipt_id}.json`]);

        const routes = fake.calls.map((c) => `${c.method} ${c.path.split("?")[0]!.replace(/(cla?_)x*\d+/g, "$1…")}`);
        // The calls, in order: the link and its publish; the payer page's read; the Test payer's attempt and its payment; the
        // read that sees the payment; the receipt. Nothing else, and nothing twice that moves anything.
        expect(routes.filter((r) => r.startsWith("POST"))).toEqual(["POST /v1/collect/links", "POST /v1/collect/links/cl_…/publish", "POST /v1/collect/cl_…/attempts", "POST /v1/collect/attempts/cla_…/test-pay"]);
        expect(routes.at(-1)).toBe("GET /v1/collect/links/cl_…/payments");
        expect(new Set(routes.filter((r) => r.startsWith("GET")))).toEqual(new Set(["GET /v1/collect/cl_…", "GET /v1/collect/links/cl_…/payments"]));
        expect(fake.payments.filter((p) => p["kind"] === "paid")).toHaveLength(1);
        // The key is a test key; the debtor's document is never sent by the kit.
        expect(fake.calls.filter((c) => c.auth !== null).every((c) => c.auth === "Bearer csk_test_unit_0000")).toBe(true);
        expect((fake.calls[0]!.body as { payer: unknown }).payer).toEqual({ name: expect.any(String) });
        // The person saw the Collect page, and the debtor was told once.
        expect(told.join("\n")).toContain(`${fake.url}/c/${outcome.transaction_id}`);
      } finally {
        s.close();
      }
    } finally {
      await fake.close();
    }
  });
});
