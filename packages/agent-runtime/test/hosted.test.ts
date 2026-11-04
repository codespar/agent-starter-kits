/**
 * The hosted channel on a kit no host code names (`tip-jar-agent`): the
 * contract's commands, its refusals, and the failures a host must survive —
 * a duplicate command, a decision on a list that changed, an approver the
 * host does not authorize, a process that dies mid-turn or right after a
 * dispatch. The repository's own kits run through the same channel in the
 * root `test/hosted-kits.test.ts`.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { checkEventLog, RunSnapshotSchema, type HostedEvent, type RunSnapshot } from "../src/hosted/contract.js";
import { createHostedRun, HostedRefusal, openHostedRun, type HostedKit } from "../src/hosted/run.js";
import { ACTOR, MemoryState, ScriptedRuntime, hostedKit, ports } from "./hosted-ports.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const TEST_KIT = join(HERE, "fixtures/kits/tip-jar-agent");
let kit: HostedKit;
beforeAll(async () => {
  kit = await hostedKit(TEST_KIT, ROOT);
});

const replay = { commandId: "c-create", modelMode: "replay" as const, executor: "simulator" as const, options: { exampleId: "happy-path" } };
const valid = (s: RunSnapshot) => {
  const parsed = RunSnapshotSchema.safeParse(s);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  return s;
};
const log = (p: { state: MemoryState }, runId: string): HostedEvent[] => p.state.log.get(runId) ?? [];
const refusal = async (promise: Promise<unknown>, code: string) => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HostedRefusal);
  expect((err as HostedRefusal).code).toBe(code);
};

describe("a replayed money-out run", () => {
  it("leaves the payment awaiting a person, pays it once on an authorized decision, and keeps the event log gapless and valid", async () => {
    const p = ports();
    const before = { ...process.env };
    const run = await createHostedRun(kit, p, replay);
    const turn = await run.turn({ commandId: "c-1", exampleTurn: 0 });
    expect(turn.turnId).toBe("turn_1");

    const waiting = valid(await run.snapshot());
    expect(waiting.run.status).toBe("awaiting_decision");
    expect(waiting.executions.map((e) => e.state)).toEqual(["awaiting_approval"]);
    const decision = waiting.pending[0]!;
    expect(decision.kind).toBe("decision");
    if (decision.kind !== "decision") return;
    expect(decision.items[0]).toMatchObject({ beneficiary: "Café Central (barista)", amountMinor: 1000, payeeMasked: "ba***@cafe.example.com.br" });

    const done = valid(await run.decide({ commandId: "c-2", executionId: decision.executionId, decision: "approve", binding: decision.binding }));
    expect(done.executions[0]).toMatchObject({ state: "settled", approvedBy: { type: "human", id: ACTOR.userId, channel: "playground" } });
    expect(done.executions[0]!.evidence.every((e) => e.kind === "simulated")).toBe(true);
    expect(done.run.status).toBe("idle");
    expect(p.decisions).toEqual([{ executionId: decision.executionId, decision: "approve" }]);

    const events = log(p, run.runId);
    expect(checkEventLog(events)).toEqual([]);
    expect(events.at(-1)!.seq).toBe(done.cursor.seq);
    expect(events.filter((e) => e.type === "dispatch.attempted")).toHaveLength(1);
    const transitions = events.filter((e) => e.type === "execution.transitioned").map((e) => (e.data as { to: string }).to);
    expect(transitions).toEqual(done.executions[0]!.history.map((h) => h.to));

    // Nothing written next to the kit and nothing changed in the environment.
    expect(existsSync(join(TEST_KIT, ".codespar"))).toBe(false);
    expect(existsSync(join(TEST_KIT, "runs"))).toBe(false);
    expect(process.env).toEqual(before);
  });

  it("answers a repeated command from its record, and refuses the same id with another payload", async () => {
    const p = ports();
    const run = await createHostedRun(kit, p, replay);
    const first = await run.turn({ commandId: "c-1", exampleTurn: 0 });
    expect(await run.turn({ commandId: "c-1", exampleTurn: 0 })).toEqual(first);
    const s = await run.snapshot();
    const d = s.pending[0]!;
    if (d.kind !== "decision") throw new Error("expected a decision");
    await run.decide({ commandId: "c-2", executionId: d.executionId, decision: "approve", binding: d.binding });
    await run.decide({ commandId: "c-2", executionId: d.executionId, decision: "approve", binding: d.binding });
    await refusal(run.decide({ commandId: "c-2", executionId: d.executionId, decision: "deny", binding: d.binding }), "command_conflict");
    const events = log(p, run.runId);
    expect(events.filter((e) => e.type === "approval.decided")).toHaveLength(1);
    expect(events.filter((e) => e.type === "dispatch.attempted")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.accepted")).toHaveLength(1);
  });

  it("refuses a decision on what was not shown, and one the host does not authorize, changing nothing", async () => {
    const p = ports({ authorize: async () => ({ ok: false, code: "not_holder", message: "only the account holder approves" }) });
    const run = await createHostedRun(kit, p, replay);
    await run.turn({ commandId: "c-1", exampleTurn: 0 });
    const s = await run.snapshot();
    const d = s.pending[0]!;
    if (d.kind !== "decision") throw new Error("expected a decision");
    await refusal(run.decide({ commandId: "c-2", executionId: d.executionId, decision: "approve", binding: { ...d.binding, totalMinor: 100 } }), "decision_stale");
    await refusal(run.decide({ commandId: "c-3", executionId: d.executionId, decision: "approve", binding: d.binding }), "not_authorized");
    const after = valid(await run.snapshot());
    expect(after.executions[0]!.state).toBe("awaiting_approval");
    expect(log(p, run.runId).some((e) => e.type === "approval.decided" || e.type === "dispatch.attempted")).toBe(false);
  });

  it("refuses an actor of another project, on reads as on commands", async () => {
    const state = new MemoryState();
    const run = await createHostedRun(kit, ports({ state }), replay);
    const intruder = await openHostedRun(kit, ports({ state, actor: { ...ACTOR, projectId: "prj_other" } }), run.runId);
    await refusal(intruder.snapshot(), "not_authorized");
    await refusal(intruder.turn({ commandId: "x", exampleTurn: 0 }), "not_authorized");
  });

  it("stops: what awaits a person is denied, a later turn is refused, nothing is erased", async () => {
    const p = ports();
    const run = await createHostedRun(kit, p, replay);
    await run.turn({ commandId: "c-1", exampleTurn: 0 });
    const stopped = valid(await run.stop({ commandId: "c-2", reason: "changed my mind" }));
    expect(stopped.run.status).toBe("stopped");
    expect(stopped.executions[0]).toMatchObject({ state: "denied", reason: "denied_by_approver" });
    await refusal(run.turn({ commandId: "c-3", text: "again" }), "run_stopped");
    expect(log(p, run.runId).filter((e) => e.type === "run.stopped")).toHaveLength(1);
  });

  it("exports the masked run: no payee key, no approval signature, no flag that confirms a payment", async () => {
    const p = ports();
    const run = await createHostedRun(kit, p, replay);
    await run.turn({ commandId: "c-1", exampleTurn: 0 });
    const s = await run.snapshot();
    const d = s.pending[0]!;
    if (d.kind !== "decision") throw new Error("expected a decision");
    await run.decide({ commandId: "c-2", executionId: d.executionId, decision: "approve", binding: d.binding });
    const exported = await run.export();
    const text = JSON.stringify(exported);
    expect(text).not.toContain("barista@cafe.example.com.br");
    expect(text).not.toMatch(/"signature":\s*\{/);
    expect(exported.code.commands.join(" ")).not.toMatch(/--approve|--yes|--simulate-payer/);
    expect(exported.code).toMatchObject({ kitPath: "agents/tip-jar-agent", commit: kit.descriptor.source.commit });
    expect(exported.approvals).toHaveLength(1);
  });
});

describe("what a host must survive", () => {
  it("a crash mid-turn: the turn is not run again, its text is not sent again, and the run continues", async () => {
    const state = new MemoryState();
    const model = new ScriptedRuntime([
      [{ id: "tc_1", name: "list_jars", input: {} }],
      { text: "never reached" },
    ]);
    const run = await createHostedRun(kit, ports({ state, model: { mode: "model", runtime: model } }), { ...replay, modelMode: "model" });
    // The save after the first step dies: the image keeps the turn as in flight.
    state.dieOnSave = 2;
    await expect(run.turn({ commandId: "c-1", text: "tip the barista 10 reais" })).rejects.toThrow(/simulated crash/);

    const next = new ScriptedRuntime([{ text: "Here are the jars again." }]);
    const reopened = await openHostedRun(kit, ports({ state, model: { mode: "model", runtime: next } }), run.runId);
    const s = valid(await reopened.snapshot());
    expect(s.turns[0]).toMatchObject({ turnId: "turn_1", interrupted: true });
    expect(s.run.status).toBe("idle");
    const types = log({ state }, run.runId).map((e) => e.type);
    expect(types).toContain("run.interrupted");
    expect(types).toContain("run.resumed");

    await reopened.turn({ commandId: "c-2", text: "show the jars" });
    // The model saw the conversation with the interruption said, and the cut turn's text only once.
    const seen = next.seen[0]!;
    expect(seen.filter((m) => m.role === "user" && m.content === "tip the barista 10 reais").length).toBeLessThanOrEqual(1);
    expect(seen.at(-1)).toEqual({ role: "user", content: "show the jars" });
    expect(checkEventLog(log({ state }, run.runId))).toEqual([]);
  });

  it("a crash right after the dispatch: reopened, the payment is reconciled and never sent again", async () => {
    const state = new MemoryState();
    const run = await createHostedRun(kit, ports({ state }), replay);
    await run.turn({ commandId: "c-1", exampleTurn: 0 });
    const s = await run.snapshot();
    const d = s.pending[0]!;
    if (d.kind !== "decision") throw new Error("expected a decision");
    // The first save of the decision is the one before the rail call; the next one dies after the rail answered.
    state.dieOnSave = 2;
    await expect(run.decide({ commandId: "c-2", executionId: d.executionId, decision: "approve", binding: d.binding })).rejects.toThrow(/simulated crash/);

    const reopened = await openHostedRun(kit, ports({ state }), run.runId);
    const before = valid(await reopened.snapshot());
    expect(before.executions[0]!.state).toBe("executing");
    expect(before.run.status).toBe("awaiting_reconciliation");
    expect(before.pending.map((x) => x.kind)).toEqual(["reconciliation"]);

    const after = valid(await reopened.resume({ commandId: "c-3" }));
    // The stub's record of the attempt died with the process, so the rail cannot confirm it: it stays for a person, and is not re-sent.
    expect(after.executions[0]!.state).toBe("executing");
    const events = log({ state }, run.runId);
    expect(events.filter((e) => e.type === "dispatch.attempted")).toHaveLength(1);
    expect(checkEventLog(events)).toEqual([]);
    await refusal(reopened.decide({ commandId: "c-4", executionId: d.executionId, decision: "approve", binding: d.binding }), "not_awaiting_approval");
  });

  it("two processes on one run: the second save loses, and says so", async () => {
    const state = new MemoryState();
    const run = await createHostedRun(kit, ports({ state }), replay);
    const other = await openHostedRun(kit, ports({ state }), run.runId);
    await other.turn({ commandId: "c-other", exampleTurn: 0 });
    await refusal(run.turn({ commandId: "c-1", exampleTurn: 0 }), "revision_conflict");
  });
});

describe("what a run never infers", () => {
  it("refuses an executor the kit does not build, a model port that disagrees, and a replay with nothing to replay", async () => {
    await refusal(createHostedRun(kit, ports({ rail: { executor: "codespar-test", client: {} as never, mandate: {} as never } }), { ...replay, executor: "codespar-test" }), "executor_unsupported");
    await refusal(createHostedRun(kit, ports(), { ...replay, modelMode: "model" }), "model_mode_unsupported");
    await refusal(createHostedRun(kit, ports(), { ...replay, options: {} }), "example_unknown");
    await refusal(createHostedRun(kit, ports(), { ...replay, options: { exampleId: "happy-path", approvalMode: "mandate", locale: "en" } }).then((r) => r.turn({ commandId: "t", text: "typed" })), "replay_requires_example_turn");
  });
});
