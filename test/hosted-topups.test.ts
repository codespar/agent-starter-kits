/**
 * topup-agent on the integrated Test (CONTRATO v1.8, decision D2 of 27/11): the pull is the PLATFORM's top-up
 * (`codespar_wallet` action `top_up`), which the person makes on the dashboard and confirms at their bank, and the
 * platform's record of it is the evidence. FakeTopUps is an in-memory SIMULATION of the host's port; the platform's
 * records are the host's, exercised in the API's suite. No bank is reached from here.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostedRun, openHostedRun, RunSnapshotSchema, type HostedEvent, type HostedRun, type RunSnapshot } from "@codespar/agent-runtime";
import { exportCommands } from "../packages/agent-runtime/src/hosted/export-commands.js";
import { FakeProposals, FakeTopUps, hostedKit, MemoryState, ports } from "../packages/agent-runtime/test/hosted-ports.js";

const ROOT = resolve(import.meta.dirname, "..");
const kitOf = () => hostedKit(join(ROOT, "agents", "topup-agent"), ROOT);

function valid(s: RunSnapshot): RunSnapshot {
  const parsed = RunSnapshotSchema.safeParse(s);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  return s;
}

async function replayAll(run: HostedRun, turns: number): Promise<RunSnapshot> {
  for (let n = 0; n < turns; n += 1) await run.turn({ commandId: `turn-${n}`, exampleTurn: n });
  return valid(await run.snapshot());
}

function events(state: MemoryState, run: HostedRun): HostedEvent[] {
  return state.log.get(run.runId) ?? [];
}

async function started(topups: FakeTopUps, state = new MemoryState()) {
  const kit = await kitOf();
  const proposals = new FakeProposals();
  const p = ports({ state, rail: { executor: "codespar-test", proposals, topups } });
  const run = await createHostedRun(kit, p, { commandId: "c", modelMode: "replay", executor: "codespar-test", options: { exampleId: "happy-path" } });
  const offered = await replayAll(run, 2);
  return { kit, p, run, offered, proposals, state };
}

describe("topup-agent on codespar-test: the platform's own top-up", () => {
  it("the descriptor offers codespar-test on platform.top_ups, proved by the platform's record, with no spending mandate", async () => {
    const kit = await kitOf();
    expect(kit.descriptor.executors.find((e) => e.id === "codespar-test")).toEqual({ id: "codespar-test", evidence: "rail_record", requires: ["platform.test_project", "platform.top_ups"], blockedBy: [] });
    expect(kit.descriptor.recommendedRuns).toEqual([{ executor: "codespar-test", modelMode: "model", example: "happy-path", rank: 6 }]);
  });

  it("a host without the top-up port runs no top-up on codespar-test: refused, never simulated", async () => {
    const kit = await kitOf();
    const refused = await createHostedRun(kit, ports({ rail: { executor: "codespar-test", proposals: new FakeProposals() } }), { commandId: "c", modelMode: "replay", executor: "codespar-test", options: { exampleId: "happy-path" } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((refused as { code?: string }).code).toBe("executor_unsupported");
  });

  it("offers the platform's top-up once, waits for the person at their bank, and settles on the platform's record", async () => {
    const topups = new FakeTopUps();
    const { kit, p, run, offered, proposals, state } = await started(topups);
    expect(topups.submitted).toHaveLength(1);
    expect(topups.submitted[0]).toMatchObject({ amountMinor: 100, currency: "BRL" });
    // No payment proposal, no charge proposal: the platform's top-up is the only thing offered.
    expect(proposals.submitted).toHaveLength(0);
    expect(offered.run.status).toBe("awaiting_payer");
    const payer = offered.pending.find((x) => x.kind === "payer");
    if (!payer || payer.kind !== "payer") throw new Error(`expected the person's top-up, got ${JSON.stringify(offered.pending)}`);
    // Nothing here can confirm for the person: no payer to simulate, and the page is the dashboard's top-up page.
    expect(payer).toMatchObject({ simulatable: false, instrument: { payable: false, status: "awaiting_person", consentUrl: "/dashboard/projects/prj_fixture/shop?top_up=1&amount_minor=100" } });
    expect(offered.executions[0]!.evidence[0]).toMatchObject({ kind: "rail_record", detail: "top-up offered; the person has not made it at their bank" });
    expect(events(state, run).some((e) => e.type === "instrument.presented")).toBe(true);
    expect(events(state, run).some((e) => e.type === "proposal.updated")).toBe(false);
    expect(events(state, run).some((e) => e.type === "outcome.pending" && (e.data as { kind: string }).kind === "awaiting_payer")).toBe(true);
    const simulated = await run.simulatePayer({ commandId: "pay", executionId: payer.executionId, behaviour: "pays" }).then(() => undefined, (e: unknown) => e);
    expect((simulated as { code?: string }).code).toBe("payer_not_simulatable");

    // The person made it; the bank has not finished: still waiting, still one offer.
    topups.person(payer.chargeId, "in_progress");
    const making = valid(await run.resume({ commandId: "r1" }));
    expect(making.executions[0]!.state).toBe("executing");
    expect(making.executions[0]!.evidence[0]).toMatchObject({ kind: "rail_record", detail: "top-up made by the person; the bank has not finished it" });

    topups.person(payer.chargeId, "completed", { recordId: "swp_fake_1", endToEndId: "E2E-FAKE-1" });
    const done = valid(await run.resume({ commandId: "r2" }));
    expect(done.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(done.run.status).toBe("idle");
    expect(done.executions[0]!.evidence).toEqual([{ kind: "rail_record", id: "swp_fake_1", detail: "the platform's own record of the pull the person made; not a CodeSpar receipt, not verified by the kit" }]);
    expect(events(state, run).some((e) => e.type === "counterparty.message" && (e.data as { text: string }).text.includes("E2E-FAKE-1"))).toBe(true);

    // A restart and a resume: the same record, nothing offered again.
    const again = valid(await (await openHostedRun(kit, p, run.runId)).resume({ commandId: "r3" }));
    expect(again.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(topups.submitted).toHaveLength(1);
    expect(events(state, run).filter((e) => e.type === "dispatch.attempted")).toHaveLength(1);
  });

  it("D4: a top-up whose outcome is unknown stays open, offers no second pull, and closes only on the platform's record", async () => {
    const topups = new FakeTopUps();
    const { run, offered, state } = await started(topups);
    const payer = offered.pending.find((x) => x.kind === "payer");
    if (!payer || payer.kind !== "payer") throw new Error("expected the person's top-up");
    topups.person(payer.chargeId, "uncertain", { code: "unknown", detail: "the bank's answer to the pull did not arrive" });
    const unknown = valid(await run.resume({ commandId: "r1" }));
    expect(unknown.executions[0]!.state).toBe("executing");
    // Not a payer link any more: a reconciliation, so nothing invites the person to make another pull.
    expect(unknown.pending.map((x) => x.kind)).toEqual(["reconciliation"]);
    expect(unknown.run.status).toBe("awaiting_reconciliation");
    expect(topups.submitted).toHaveLength(1);
    const again = valid(await run.resume({ commandId: "r2" }));
    expect(again.executions[0]!.state).toBe("executing");
    expect(topups.submitted).toHaveLength(1);
    expect(events(state, run).filter((e) => e.type === "dispatch.attempted")).toHaveLength(1);

    topups.person(payer.chargeId, "completed", { recordId: "swp_fake_2" });
    const closed = valid(await run.resume({ commandId: "r3" }));
    expect(closed.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(closed.executions[0]!.evidence[0]).toMatchObject({ kind: "rail_record", id: "swp_fake_2" });
  });

  it("a top-up the platform recorded as refused fails with the platform's own code, and nothing was pulled", async () => {
    const topups = new FakeTopUps();
    const { run, offered } = await started(topups);
    const payer = offered.pending.find((x) => x.kind === "payer");
    if (!payer || payer.kind !== "payer") throw new Error("expected the person's top-up");
    topups.person(payer.chargeId, "refused", { code: "rejected", detail: "the bank refused the pull" });
    const refused = valid(await run.resume({ commandId: "r1" }));
    expect(refused.executions[0]!.state).toBe("failed");
    expect(refused.executions[0]!.attempts[0]).toMatchObject({ status: "failed", code: "rejected" });
    expect(topups.submitted).toHaveLength(1);
  });

  it("an offer whose answer was lost is asked again under the same attempt: the same top-up, nothing more", async () => {
    const topups = new FakeTopUps();
    topups.loseNextSubmit = true;
    const { run, offered } = await started(topups);
    expect(offered.executions[0]!.state).toBe("executing");
    expect(offered.pending.map((x) => x.kind)).toEqual(["reconciliation"]);
    const found = valid(await run.resume({ commandId: "r1" }));
    expect(topups.submitted).toHaveLength(1);
    expect(found.pending.map((x) => x.kind)).toEqual(["payer"]);
  });

  it("the export of an integrated-Test top-up says what is the platform's and the person's, and starts the kit on the simulator", async () => {
    const kit = await kitOf();
    const commands = exportCommands(kit.descriptor, { modelMode: "model", executor: "codespar-test", approvalMode: "mandate", locale: "pt-BR", exampleId: "happy-path" }, { model: "claude-test-1" });
    const text = commands.join("\n");
    expect(text).toContain("codespar_wallet top_up");
    expect(text).toContain("csk_test_");
    expect(text).toContain("nenhum comando a reproduz");
    expect(text).toContain("simulador (stub)");
    expect(text).not.toContain("--rail api");
    expect(text).not.toContain("CODESPAR_API_KEY");
    expect(commands.at(-1)).toBe("ANTHROPIC_MODEL=claude-test-1 npm start --workspace=agents/topup-agent -- --rail stub --provider anthropic --mode mandate --locale pt-BR");
    const en = exportCommands(kit.descriptor, { modelMode: "model", executor: "codespar-test", approvalMode: "mandate", locale: "en", exampleId: null }).join("\n");
    expect(en).toContain("no command reproduces it");
    expect(en).toContain("--rail stub");
  });

  it("the simulator still runs the kit's own simulated pull, labeled simulated", async () => {
    const kit = await kitOf();
    const state = new MemoryState();
    const run = await createHostedRun(kit, ports({ state }), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "happy-path" } });
    const snap = await replayAll(run, 2);
    const payer = snap.pending.find((x) => x.kind === "payer");
    if (!payer || payer.kind !== "payer") throw new Error(`expected the simulated bank, got ${JSON.stringify(snap.pending)}`);
    expect(payer.simulatable).toBe(true);
    const paid = valid(await run.simulatePayer({ commandId: "p", executionId: payer.executionId, behaviour: "pays" }));
    expect(paid.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(paid.executions[0]!.evidence[0]).toMatchObject({ kind: "simulated" });
  });
});
