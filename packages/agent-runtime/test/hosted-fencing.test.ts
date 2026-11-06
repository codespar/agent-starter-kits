/**
 * Fencing (CONTRATO v1.2): when the host gives a run to another process, the
 * old one must stop at once — no save, no event, no proposal — and the new
 * owner must take the run over without drafting a second proposal for an
 * attempt the old one already proposed.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { checkEventLog } from "../src/hosted/contract.js";
import { createHostedRun, HostedRefusal, openHostedRun, type HostedKit } from "../src/hosted/run.js";
import { FakeProposals, MemoryState, hostedKit, ports } from "./hosted-ports.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let kit: HostedKit;
beforeAll(async () => {
  kit = await hostedKit(join(HERE, "fixtures/kits/tip-jar-agent"), join(HERE, "../../.."));
});

const create = { commandId: "c-create", modelMode: "replay" as const, executor: "codespar-test" as const, options: { exampleId: "happy-path" } };
const processAt = (epoch: number, state: MemoryState, proposals: FakeProposals) => ports({ state: state.forEpoch(epoch) as MemoryState, rail: { executor: "codespar-test", proposals: proposals.forEpoch(epoch) } });
const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (e: unknown) => (e instanceof HostedRefusal ? e.code : String(e)),
  );

describe("fencing", () => {
  it("a process whose lease was taken stops at its next save: nothing written, no event, no proposal, and it stays stopped", async () => {
    const state = new MemoryState();
    const proposals = new FakeProposals();
    const old = await createHostedRun(kit, processAt(1, state, proposals), create);
    state.epoch = 2;
    const owner = await openHostedRun(kit, processAt(2, state, proposals), old.runId);
    const before = state.log.get(old.runId)!.length;

    expect(await code(old.turn({ commandId: "c-1", exampleTurn: 0 }))).toBe("fenced");
    expect(await code(old.resume({ commandId: "c-2" }))).toBe("fenced");
    expect(await code(old.snapshot())).toBe("fenced");
    expect(state.log.get(old.runId)!.length).toBe(before);
    expect(proposals.submitted).toHaveLength(0);

    await owner.turn({ commandId: "c-1", exampleTurn: 0 });
    expect(proposals.submitted).toHaveLength(1);
    expect(checkEventLog(state.log.get(old.runId)!)).toEqual([]);
  });

  it("a process fenced at the proposal port sends nothing more, and the new owner proposes that attempt once", async () => {
    const state = new MemoryState();
    const proposals = new FakeProposals();
    const old = await createHostedRun(kit, processAt(1, state, proposals), create);
    proposals.fencedBelow = 2;
    expect(await code(old.turn({ commandId: "c-1", exampleTurn: 0 }))).toBe("fenced");
    const written = state.log.get(old.runId)!.length;
    expect(proposals.submitted).toHaveLength(0);
    // The last thing the old process saved is the checkpoint before the proposal call; nothing after it.
    expect(state.log.get(old.runId)!.at(-1)!.type).toBe("dispatch.attempted");

    state.epoch = 2;
    const owner = await openHostedRun(kit, processAt(2, state, proposals), old.runId);
    const s = await owner.snapshot();
    expect(s.pending.map((p) => p.kind)).toEqual(["payment_proposal"]);
    expect(proposals.submitted).toHaveLength(1);
    expect(state.log.get(old.runId)!.length).toBeGreaterThan(written);
    expect(checkEventLog(state.log.get(old.runId)!)).toEqual([]);
  });

  it("the new owner resumes a proposal the old one drafted but never recorded: same attempt, same proposal, none drafted again", async () => {
    const state = new MemoryState();
    const proposals = new FakeProposals();
    const old = await createHostedRun(kit, processAt(1, state, proposals), create);
    // Saves 1-3 (turn accepted, first step, the checkpoint before the proposal call) succeed; the 4th, after the proposal was drafted, dies with the process.
    state.dieOnSave = 4;
    await expect(old.turn({ commandId: "c-1", exampleTurn: 0 })).rejects.toThrow(/simulated crash/);
    expect(proposals.submitted).toHaveLength(1);
    const drafted = `prop_${proposals.submitted[0]!.attemptId}`;

    state.epoch = 2;
    const owner = await openHostedRun(kit, processAt(2, state, proposals), old.runId);
    const s = await owner.snapshot();
    expect(s.pending).toEqual([{ kind: "payment_proposal", executionId: proposals.submitted[0]!.executionId, proposalId: drafted, proposalState: "awaiting_approval" }]);
    expect(proposals.submitted).toHaveLength(1);
    proposals.pay(drafted, "rcpt_platform_after_takeover");
    const done = await owner.resume({ commandId: "c-2" });
    expect(done.executions[0]).toMatchObject({ state: "settled", evidence: [{ kind: "codespar_receipt", id: "rcpt_platform_after_takeover" }] });
    expect(proposals.submitted).toHaveLength(1);
  });
});
