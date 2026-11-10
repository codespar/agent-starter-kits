/**
 * Fornecedores and Primeiros passos on the integrated Test (CONTRATO v1.5),
 * through the hosted channel with a scripted model and IN-MEMORY ports: the
 * proposals, the reads and the state here are SIMULATIONS of the host, not the
 * platform. What they prove is the kit's side: which tools it calls, what it
 * asks the host for, what it never asks, and that a resume repeats nothing.
 * The platform's side is proved on the enterprise, against its own records.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Mandate } from "@codespar/agent-core";
import { createHostedRun } from "@codespar/agent-runtime";
import { FakeProposals, FakeReads, hostedKit, MemoryState, ports, ScriptedRuntime } from "../packages/agent-runtime/test/hosted-ports.js";

const ROOT = resolve(import.meta.dirname, "..");
const kitOf = (name: string) => hostedKit(join(ROOT, "agents", name), ROOT);

function playgroundMandate(agentId: string): Mandate {
  const one = "0b5d6c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
  const two = "1c6e7d2f-3a4b-4c5d-9e0f-1a2b3c4d5e6f";
  return {
    id: "mdt_playground_test_fixture",
    version: 1,
    consumer_id: "cst_playground_fixture",
    agent_id: agentId,
    purpose: "Playground: recebedores de teste da plataforma",
    currency: "BRL",
    cap_minor: 20000,
    per_tx_cap_minor: 3000,
    periodic_cap: { window: "month", cap_minor: 10000 },
    merchant_pin_kind: "pix-key",
    merchant_allowlist: [one, two],
    beneficiaries: [
      { alias: "conta-teste", name: "Recebedor de teste da plataforma", payee: one },
      { alias: "conta-teste-projeto", name: "Recebedor de teste do projeto", payee: two },
    ],
    status: "active",
    expires_at: "2027-11-07T00:00:00.000Z",
    source: "consent",
  };
}

function toolResult(model: ScriptedRuntime, name: string): Record<string, unknown> {
  const message = model.seen.flat().find((m) => m.role === "tool" && m.name === name);
  if (!message || message.role !== "tool") throw new Error(`the model never received ${name}`);
  return JSON.parse(message.content) as Record<string, unknown>;
}

describe("Fornecedores (supplier-payments-agent) on the integrated Test", () => {
  it("the recommended run pays the test batch as one proposal per line, the person pays them, and a resume after that repeats nothing", async () => {
    const kit = await kitOf("supplier-payments-agent");
    expect(kit.descriptor.recommendedRuns).toEqual([{ executor: "codespar-test", modelMode: "model", example: "lote-teste", rank: 2 }]);
    const proposals = new FakeProposals();
    proposals.initialState = "drafted";
    const state = new MemoryState();
    const model = new ScriptedRuntime([
      [{ id: "tc_1", name: "list_payables", input: {} }],
      [{ id: "tc_2", name: "codespar_pay", input: { action: "pix", batch_ref: "teste-2026-10" } }],
      { text: "Criei uma proposta por linha do lote de teste; cada uma aguarda a sua decisão no card." },
    ]);
    const run = await createHostedRun(kit, ports({ state, rail: { executor: "codespar-test", proposals, mandate: playgroundMandate("supplier-payments-agent") }, model: { mode: "model", runtime: model } }), {
      commandId: "c",
      modelMode: "model",
      executor: "codespar-test",
      options: { exampleId: "lote-teste" },
    });
    await run.turn({ commandId: "t", exampleTurn: 0 });
    expect(model.seen[0]!.at(-1)).toEqual({ role: "user", content: "pague o lote de teste" });

    const report = toolResult(model, "codespar_pay") as { lines: Array<{ alias: string; amount_minor: number; dispatch: string }>; failed: string[] };
    expect(report.lines.map((l) => [l.alias, l.amount_minor, l.dispatch])).toEqual([
      ["conta-teste", 1000, "awaiting_proposal_decision"],
      ["conta-teste-projeto", 1000, "awaiting_proposal_decision"],
    ]);
    expect(report.failed).toEqual([]);
    expect(proposals.submitted.map((r) => r.totalMinor)).toEqual([1000, 1000]);

    const waiting = await run.snapshot();
    expect(waiting.pending.map((p) => p.kind)).toEqual(["payment_proposal", "payment_proposal"]);

    for (const r of proposals.submitted) proposals.pay(`prop_${r.attemptId}`, `rcpt_${r.attemptId.slice(-6)}`);
    const paid = await run.resume({ commandId: "r-1" });
    expect(paid.executions.map((e) => e.state)).toEqual(["settled", "settled"]);
    expect(paid.batches[0]!.settledMinor).toBe(2000);

    // Resume again: nothing drafted, dispatched or settled twice.
    const before = { proposals: proposals.submitted.length, dispatches: (state.log.get(run.runId) ?? []).filter((e) => e.type === "dispatch.attempted").length, receipts: paid.executions.flatMap((e) => e.evidence).length };
    const again = await run.resume({ commandId: "r-2" });
    expect({ proposals: proposals.submitted.length, dispatches: (state.log.get(run.runId) ?? []).filter((e) => e.type === "dispatch.attempted").length, receipts: again.executions.flatMap((e) => e.evidence).length }).toEqual(before);
    expect(before).toEqual({ proposals: 2, dispatches: 2, receipts: 2 });
  });
});

describe("Primeiros passos (hello-agent) on the integrated Test", () => {
  it("reads the Test project through the host with no mandate, and asks for nothing that spends", async () => {
    const kit = await kitOf("hello-agent");
    expect(kit.descriptor.needsMandate).toBe(false);
    expect(kit.descriptor.recommendedRuns).toEqual([{ executor: "codespar-test", modelMode: "model", example: "conta-plataforma", rank: 3 }]);
    const reads = new FakeReads();
    const proposals = new FakeProposals();
    const model = new ScriptedRuntime([
      [{ id: "tc_1", name: "codespar_account", input: { view: "balance" } }],
      [{ id: "tc_2", name: "codespar_account", input: { view: "proposals", limit: 50 } }],
      { text: "Seu projeto de Test tem R$ 240,00 disponíveis." },
    ]);
    // No mandate in the rail port: a read needs none.
    const run = await createHostedRun(kit, ports({ rail: { executor: "codespar-test", proposals, reads }, model: { mode: "model", runtime: model } }), {
      commandId: "c",
      modelMode: "model",
      executor: "codespar-test",
      options: { exampleId: "conta-plataforma" },
    });
    await run.turn({ commandId: "t", exampleTurn: 0 });
    expect(model.seen[0]!.at(-1)).toEqual({ role: "user", content: "qual é o saldo da minha conta de teste?" });
    expect(toolResult(model, "codespar_account")).toMatchObject({ available: true, view: "balance", accountExists: true, currencies: [{ currency: "BRL", availableMinor: 24000 }] });
    // The limit is capped at 10 before it reaches the host.
    expect(reads.calls).toEqual(["balance", "proposals:10"]);
    // Every payee the model reads is masked, even one the host failed to mask.
    const listed = model.seen.flat().filter((m) => m.role === "tool" && m.name === "codespar_account").map((m) => (m as { content: string }).content);
    expect(listed.join("\n")).not.toContain("pagador@banco.example.com.br");
    expect(listed.join("\n")).toContain("pa***@banco.example.com.br");
    expect(proposals.submitted).toEqual([]);
    const s = await run.snapshot();
    expect(s.executions).toEqual([]);
    expect(s.pending).toEqual([]);
  });

  it("on the simulator there is no account to read, and the tool says so instead of inventing one", async () => {
    const model = new ScriptedRuntime([[{ id: "tc_1", name: "codespar_account", input: { view: "balance" } }], { text: "Aqui não há conta para ler." }]);
    const run = await createHostedRun(await kitOf("hello-agent"), ports({ model: { mode: "model", runtime: model } }), { commandId: "c", modelMode: "model", executor: "simulator", options: {} });
    await run.turn({ commandId: "t", text: "qual é o meu saldo?" });
    expect(toolResult(model, "codespar_account")).toMatchObject({ available: false, view: "balance" });
  });
});
