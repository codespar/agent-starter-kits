/**
 * The six kits of this repository through the hosted channel, each from its
 * own recorded example on the simulator: read-only, money out, a batch with
 * a refused line, receivables that wait for their payer, and a pull that is
 * not a CodeSpar payment. Nothing here names a kit to the channel; the kit
 * is a directory, and the channel is the one `tip-jar-agent` runs through.
 */
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkEventLog, createHostedRun, openHostedRun, RunSnapshotSchema, type HostedEvent, type HostedRun, type RunSnapshot } from "@codespar/agent-runtime";
import { FakeCharges, FakeProposals, hostedKit, MemoryState, ports } from "../packages/agent-runtime/test/hosted-ports.js";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "packages/agent-runtime/test/fixtures/hosted");
const kitOf = (name: string) => hostedKit(join(ROOT, "agents", name), ROOT);

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
  const log = state.log.get(run.runId) ?? [];
  expect(checkEventLog(log)).toEqual([]);
  return log;
}

describe("hosted, on the simulator, from each kit's own example", () => {
  it("hello-agent reads and answers: no execution, no mandate asked, nothing to decide", async () => {
    const state = new MemoryState();
    const run = await createHostedRun(await kitOf("hello-agent"), ports({ state }), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "happy-path" } });
    const s = await replayAll(run, 1);
    expect(s).toMatchObject({ executions: [], pending: [], run: { status: "idle" } });
    expect(s.turns[0]!.tools.map((t) => [t.name, t.effect])).toEqual([["list_bills", "read"]]);
    expect(s.turns[0]!.reply).toMatch(/Escola Aurora/);
    expect(events(state, run).some((e) => e.type === "approval.requested" || e.type === "dispatch.attempted")).toBe(false);
  });

  it("bills-agent proposes, waits for the person, and pays once on their decision; the contract fixture matches what runs", async () => {
    const state = new MemoryState();
    const run = await createHostedRun(await kitOf("bills-agent"), ports({ state }), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "happy-path" } });
    const waiting = await replayAll(run, 1);
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "bills-awaiting-approval.snapshot.json"), "utf8")) as RunSnapshot;
    expect(waiting.run.status).toBe(fixture.run.status);
    expect(waiting.pending.map((p) => p.kind)).toEqual(fixture.pending.map((p) => p.kind));
    const decision = waiting.pending[0]!;
    if (decision.kind !== "decision" || fixture.pending[0]!.kind !== "decision") throw new Error("expected a decision");
    expect(decision.binding).toEqual(fixture.pending[0]!.binding);
    expect(decision.items).toEqual(fixture.pending[0]!.items);

    const done = valid(await run.decide({ commandId: "d", executionId: decision.executionId, decision: "approve", binding: decision.binding }));
    expect(done.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(done.executions[0]!.evidence.map((e) => e.kind)).toEqual(["simulated"]);
    expect(events(state, run).filter((e) => e.type === "dispatch.attempted")).toHaveLength(1);
  });

  it("supplier-payments-agent presents the list once, takes one decision on it, and keeps a line the rail refused on its own row", async () => {
    const state = new MemoryState();
    // The rail refusing one supplier, set the way a test process sets it: through the kit's configuration, never the environment.
    const config = { SUPPLIER_PAYMENTS_STUB_REFUSE: "contas@insumos-atlantico.example.com.br" };
    const run = await createHostedRun(await kitOf("supplier-payments-agent"), ports({ state, config }), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "partial-batch-failure" } });
    const waiting = await replayAll(run, 1);
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "supplier-batch-awaiting-decision.snapshot.json"), "utf8")) as RunSnapshot;
    expect(waiting.pending.map((p) => p.kind)).toEqual(["batch_decision"]);
    const batch = waiting.pending[0]!;
    if (batch.kind !== "batch_decision" || fixture.pending[0]!.kind !== "batch_decision") throw new Error("expected a batch decision");
    expect(batch.batchHash).toBe(fixture.pending[0]!.batchHash);
    expect(batch.lines.map((l) => [l.beneficiary, l.amountMinor])).toEqual(fixture.pending[0]!.lines.map((l) => [l.beneficiary, l.amountMinor]));

    const done = valid(await run.decideBatch({ commandId: "d", batchRef: batch.batchRef, batchHash: batch.batchHash, count: batch.count, vetoed: [] }));
    expect(done.batches[0]!.lines.map((l) => [l.state, l.reason])).toEqual([
      ["settled", null],
      ["failed", "rail_failed"],
      ["settled", null],
    ]);
    expect(done.batches[0]!.settledMinor).toBe(174000);
    const log = events(state, run);
    expect(log.filter((e) => e.type === "batch.presented")).toHaveLength(1);
    expect(log.filter((e) => e.type === "batch.decided")).toHaveLength(1);
    expect(log.filter((e) => e.type === "dispatch.attempted")).toHaveLength(3);
  });

  it("supplier-payments-agent: a line the person vetoes is denied, and its siblings are paid", async () => {
    const run = await createHostedRun(await kitOf("supplier-payments-agent"), ports(), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "partial-batch-failure" } });
    const waiting = await replayAll(run, 1);
    const batch = waiting.pending[0]!;
    if (batch.kind !== "batch_decision") throw new Error("expected a batch decision");
    const done = valid(await run.decideBatch({ commandId: "d", batchRef: batch.batchRef, batchHash: batch.batchHash, count: batch.count, vetoed: [1] }));
    expect(done.batches[0]!.lines.map((l) => l.state)).toEqual(["settled", "denied", "settled"]);
  });

  it("collections-agent issues the receivable, waits for the payer the person plays, and closes once with one message", async () => {
    const state = new MemoryState();
    const run = await createHostedRun(await kitOf("collections-agent"), ports({ state }), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "happy-path" } });
    const waiting = await replayAll(run, 2);
    const decision = waiting.pending.find((p) => p.kind === "decision");
    if (!decision || decision.kind !== "decision") throw new Error("expected a decision");
    const issued = valid(await run.decide({ commandId: "d", executionId: decision.executionId, decision: "approve", binding: decision.binding }));
    expect(issued.run.status).toBe("awaiting_payer");
    const payer = issued.pending.find((p) => p.kind === "payer");
    if (!payer || payer.kind !== "payer") throw new Error("expected the payer");
    expect(payer).toMatchObject({ simulatable: true });

    const paid = valid(await run.simulatePayer({ commandId: "p", executionId: payer.executionId, behaviour: "pays" }));
    expect(paid.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(paid.run.status).toBe("idle");
    const log = events(state, run);
    expect(log.filter((e) => e.type === "instrument.presented").length).toBeGreaterThan(0);
    // The kit tells the payer once per state it reaches (`markTold`): the agreement awaiting the operator, then the payment. Never twice for one.
    const told = log.filter((e) => e.type === "counterparty.message");
    expect(told.length).toBeGreaterThanOrEqual(1);
    expect(new Set(told.map((e) => JSON.stringify(e.data))).size).toBe(told.length);
  });

  it("topup-agent pulls from the person's own bank: the consent waits for them, and nothing claims a CodeSpar receipt", async () => {
    const state = new MemoryState();
    const kit = await kitOf("topup-agent");
    const run = await createHostedRun(kit, ports({ state }), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "happy-path" } });
    const waiting = await replayAll(run, 2);
    const payer = waiting.pending.find((p) => p.kind === "payer");
    if (!payer || payer.kind !== "payer") throw new Error(`expected the person at their bank, got ${JSON.stringify(waiting.pending)}`);
    expect(payer.instrument.consentUrl).toBeTruthy();
    const done = valid(await run.simulatePayer({ commandId: "p", executionId: payer.executionId, behaviour: "pays" }));
    expect(done.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(JSON.stringify(state.log.get(run.runId))).not.toContain("codespar_receipt");
    expect(kit.descriptor.outcomeKinds).toEqual(["answer", "pull"]);
  });

  it("checkout-agent: the order waits for the attendant, and once approved waits for the customer to ask for the charge", async () => {
    const run = await createHostedRun(await kitOf("checkout-agent"), ports(), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "happy-path" } });
    const waiting = await replayAll(run, 2);
    const decision = waiting.pending.find((p) => p.kind === "decision");
    if (!decision || decision.kind !== "decision") throw new Error(`expected the order's decision, got ${JSON.stringify(waiting.pending)}`);
    expect(decision.binding.compositionHash).toMatch(/^sha256:/);
    const approved = valid(await run.decide({ commandId: "d", executionId: decision.executionId, decision: "approve", binding: decision.binding }));
    expect(approved.executions[0]!.state).toBe("approved");
  });

  it("supplier-payments-agent on codespar-test: every line becomes its own platform proposal, and nothing is decided through the run", async () => {
    const proposals = new FakeProposals();
    const state = new MemoryState();
    const run = await createHostedRun(await kitOf("supplier-payments-agent"), ports({ state, rail: { executor: "codespar-test", proposals } }), { commandId: "c", modelMode: "replay", executor: "codespar-test", options: { exampleId: "partial-batch-failure" } });
    const s = await replayAll(run, 1);
    expect(s.pending.map((p) => p.kind)).toEqual(["payment_proposal", "payment_proposal", "payment_proposal"]);
    expect(new Set(proposals.submitted.map((r) => r.attemptId)).size).toBe(3);
    expect(proposals.submitted.every((r) => r.batchHash !== null)).toBe(true);
    expect(s.batches[0]!.lines.map((l) => l.state)).toEqual(["executing", "executing", "executing"]);
    // Line 0's proposal, found by its execution: pendings come in the store's order, not the list's.
    const line0 = s.batches[0]!.lines[0]!.executionId;
    const p0 = s.pending.find((p) => p.kind === "payment_proposal" && p.executionId === line0);
    if (!p0 || p0.kind !== "payment_proposal") throw new Error("expected line 0's proposal");
    proposals.pay(p0.proposalId, "rcpt_platform_line_0");
    const after = valid(await run.resume({ commandId: "r" }));
    expect(after.batches[0]!.lines.map((l) => l.state)).toEqual(["settled", "executing", "executing"]);
    expect(proposals.submitted).toHaveLength(3);
    expect(events(state, run).filter((e) => e.type === "dispatch.attempted")).toHaveLength(3);
  });

  it("collections-agent on codespar-test: the charge is a platform receive proposal a person sends, its Test payer pays, and a resume repeats nothing", async () => {
    // FakeCharges is an in-memory SIMULATION of the host's port; the provider sandbox is the host's, exercised in the API's suite.
    const charges = new FakeCharges();
    const proposals = new FakeProposals();
    const state = new MemoryState();
    const kit = await kitOf("collections-agent");
    expect(kit.descriptor.executors.find((e) => e.id === "codespar-test")).toMatchObject({ evidence: "charge_status", blockedBy: [], requires: ["platform.test_project", "platform.consumer_mandate", "platform.charges"] });
    expect(kit.descriptor.recommendedRuns).toEqual([{ executor: "codespar-test", modelMode: "model", example: "acordo-1103", rank: 5 }]);
    const p = ports({ state, rail: { executor: "codespar-test", proposals, charges } });
    const run = await createHostedRun(kit, p, { commandId: "c", modelMode: "replay", executor: "codespar-test", options: { exampleId: "acordo-1103" } });
    const drafted = await replayAll(run, 2);
    // The kit's approval is forwarded; the person's decision is sending the charge on its card.
    expect(drafted.run.status).toBe("awaiting_decision");
    expect(drafted.pending.map((x) => x.kind)).toEqual(["payment_proposal"]);
    expect(charges.submitted).toHaveLength(1);
    expect(proposals.submitted).toHaveLength(0);
    expect(charges.submitted[0]).toMatchObject({ debtor: "Ana Paula Souza", amountMinor: 40500, currency: "BRL", dueDate: "2026-09-23" });
    // No document travels: the payee of a collection is the debtor's CPF, and the host never receives it.
    expect(JSON.stringify(charges.submitted)).not.toContain("39053344705");
    const proposal = drafted.pending[0]!;
    if (proposal.kind !== "payment_proposal") throw new Error("expected the charge proposal");
    expect(drafted.executions[0]!.evidence[0]).toMatchObject({ kind: "charge_status", detail: "platform charge proposal drafted; not sent, not paid" });
    const notYet = await run.simulatePayer({ commandId: "early", executionId: proposal.executionId, behaviour: "pays" }).then(() => undefined, (e: unknown) => e);
    expect((notYet as { code?: string }).code).toBe("not_awaiting_payer");

    charges.send(proposal.proposalId);
    const sent = valid(await run.resume({ commandId: "r1" }));
    expect(sent.run.status).toBe("awaiting_payer");
    const payer = sent.pending.find((x) => x.kind === "payer");
    if (!payer || payer.kind !== "payer") throw new Error(`expected the payer, got ${JSON.stringify(sent.pending)}`);
    expect(payer).toMatchObject({ chargeId: proposal.proposalId, simulatable: true, instrument: { payable: true, pixCopyPaste: "00020101fake-copy-paste", status: "executing" } });
    expect(events(state, run).some((e) => e.type === "instrument.presented" && (e.data as { chargeId: string }).chargeId === proposal.proposalId)).toBe(true);
    const expires = await run.simulatePayer({ commandId: "exp", executionId: payer.executionId, behaviour: "expires" }).then(() => undefined, (e: unknown) => e);
    expect((expires as { code?: string }).code).toBe("payer_not_simulatable");

    const paid = valid(await run.simulatePayer({ commandId: "pay", executionId: payer.executionId, behaviour: "pays" }));
    expect(paid.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(paid.run.status).toBe("idle");
    expect(paid.executions[0]!.evidence).toEqual([{ kind: "charge_status", id: `clr_fake_${proposal.proposalId}`, detail: "the platform reports the charge paid; the id is its receipt, not verified by the kit" }]);

    // Resume after a restart: the same proposal is read, nothing is drafted, sent or paid again.
    const reopened = await openHostedRun(kit, p, run.runId);
    const again = valid(await reopened.resume({ commandId: "r2" }));
    expect(again.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(charges.submitted).toHaveLength(1);
    expect(charges.payments).toEqual([proposal.proposalId]);
    expect(valid(await reopened.simulatePayer({ commandId: "pay", executionId: payer.executionId, behaviour: "pays" })).executions.map((e) => e.state)).toEqual(["settled"]);
    expect(charges.payments).toHaveLength(1);
    expect(events(state, reopened).filter((e) => e.type === "dispatch.attempted")).toHaveLength(1);
  });

  it("checkout-agent on codespar-test: the order's charge goes out as a receive proposal, and no NFS-e is issued or simulated", async () => {
    const charges = new FakeCharges();
    const state = new MemoryState();
    const kit = await kitOf("checkout-agent");
    const run = await createHostedRun(kit, ports({ state, rail: { executor: "codespar-test", proposals: new FakeProposals(), charges } }), { commandId: "c", modelMode: "replay", executor: "codespar-test", options: { exampleId: "ingresso-recital" } });
    const drafted = await replayAll(run, 2);
    expect(charges.submitted).toHaveLength(1);
    expect(charges.submitted[0]).toMatchObject({ debtor: "Beatriz Nunes", amountMinor: 4500 });
    const proposal = drafted.pending[0]!;
    if (proposal.kind !== "payment_proposal") throw new Error(`expected the charge proposal, got ${JSON.stringify(drafted.pending)}`);
    charges.send(proposal.proposalId);
    await run.resume({ commandId: "r" });
    const paid = valid(await run.simulatePayer({ commandId: "pay", executionId: proposal.executionId, behaviour: "pays" }));
    expect(paid.executions.map((e) => e.state)).toEqual(["settled"]);
    const exported = await run.export();
    const bundle = JSON.stringify(exported.events);
    expect(bundle).toContain("nfse.not_run");
    expect(bundle).not.toMatch(/invoice\.opened|nfse_stub/);
  });

  it("a charging kit on a host without the charge port has no codespar-test run: it is refused, never paid out as a payment proposal", async () => {
    for (const name of ["collections-agent", "checkout-agent"]) {
      const refused = await createHostedRun(await kitOf(name), ports({ rail: { executor: "codespar-test", proposals: new FakeProposals() } }), { commandId: "c", modelMode: "replay", executor: "codespar-test", options: { exampleId: "happy-path" } }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((refused as { code?: string }).code, name).toBe("executor_unsupported");
    }
  });

  it("the contract's catalog fixture is what this repository derives, but for the commit and the digests", async () => {
    const { buildCatalog, discoverAgentDirs } = await import("@codespar/agent-runtime");
    const derived = await buildCatalog({ root: ROOT, commit: "d".repeat(40), shared: ["packages/agent-core/src", "packages/agent-runtime/src"] }, discoverAgentDirs(join(ROOT, "agents")), "x");
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "catalog.json"), "utf8")) as typeof derived;
    const strip = (c: typeof derived) => c.kits.map(({ source: _source, inputSchema: { $schema: _a, ...input }, turnSchema: { $schema: _b, ...turn }, ...rest }) => ({ ...rest, inputSchema: input, turnSchema: turn }));
    expect(strip(derived)).toEqual(strip(fixture));
  });
});
