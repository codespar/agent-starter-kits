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
import { checkEventLog, createHostedRun, RunSnapshotSchema, type HostedEvent, type HostedRun, type RunSnapshot } from "@codespar/agent-runtime";
import { hostedKit, MemoryState, ports } from "../packages/agent-runtime/test/hosted-ports.js";

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

  it("the contract's catalog fixture is what this repository derives, but for the commit and the digests", async () => {
    const { buildCatalog, discoverAgentDirs } = await import("@codespar/agent-runtime");
    const derived = await buildCatalog({ root: ROOT, commit: "d".repeat(40), shared: ["packages/agent-core/src", "packages/agent-runtime/src"] }, discoverAgentDirs(join(ROOT, "agents")), "x");
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "catalog.json"), "utf8")) as typeof derived;
    const strip = (c: typeof derived) => c.kits.map(({ source: _source, inputSchema: { $schema: _a, ...input }, turnSchema: { $schema: _b, ...turn }, ...rest }) => ({ ...rest, inputSchema: input, turnSchema: turn }));
    expect(strip(derived)).toEqual(strip(fixture));
  });
});
