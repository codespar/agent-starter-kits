/**
 * What the person reads about a payment that became a platform proposal, and
 * where the hosted channel says the result is. In the 07/11 acceptance the
 * bills-agent (codespar-test, model) answered "O pagamento foi aprovado pelo
 * titular e está aguardando a liquidação" while the proposal was still
 * `drafted`, waiting for the person to press Pagar: the tool result said
 * `approved_by: "human"` (the forward) and the reason `awaiting_settlement`.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Mandate } from "@codespar/agent-core";
import { createHostedRun } from "@codespar/agent-runtime";
import { FakeProposals, hostedKit, MemoryState, ports, ScriptedRuntime } from "../packages/agent-runtime/test/hosted-ports.js";

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

describe("a proposal still waiting for the person is never reported as approved", () => {
  it("bills-agent: the drafted proposal reaches the model as approved by nobody, awaiting the person's decision, and the prompt says what that means", async () => {
    const proposals = new FakeProposals();
    proposals.initialState = "drafted";
    const model = new ScriptedRuntime([
      [{ id: "tc_1", name: "codespar_pay", input: { action: "pix", items: [{ payee: "conta-teste", amount_minor: 1000, description: "conta de teste" }], total_minor: 1000 } }],
      { text: "Criei a proposta de R$ 10,00; ela aguarda a sua decisão no card." },
    ]);
    const run = await createHostedRun(await kitOf("bills-agent"), ports({ state: new MemoryState(), rail: { executor: "codespar-test", proposals, mandate: playgroundMandate("bills-agent") }, model: { mode: "model", runtime: model } }), {
      commandId: "c",
      modelMode: "model",
      executor: "codespar-test",
      options: { exampleId: "conta-teste" },
    });
    await run.turn({ commandId: "t", exampleTurn: 0 });

    const result = toolResult(model, "codespar_pay");
    expect(result["approved_by"]).toBeNull();
    expect(result["awaiting"]).toBe("person_decision_on_proposal");
    expect(result["paid"]).toBe(false);
    expect(model.systems.at(-1)).toContain('`awaiting: "person_decision_on_proposal"`');
    const s = await run.snapshot();
    expect(s.pending).toEqual([expect.objectContaining({ kind: "payment_proposal", proposalState: "drafted" })]);

    // Once the person paid it, the platform's settlement is their decision: approved by the person.
    proposals.pay(`prop_${proposals.submitted[0]!.attemptId}`, "rcpt_platform");
    const done = await run.resume({ commandId: "r" });
    expect(done.executions[0]!.state).toBe("settled");
  });

  it("supplier-payments-agent: lines that became proposals are waiting for a decision, not uncertain and not failed", async () => {
    const proposals = new FakeProposals();
    proposals.initialState = "drafted";
    const model = new ScriptedRuntime([[{ id: "tc_1", name: "codespar_pay", input: { action: "pix", batch_ref: "teste-2026-10" } }], { text: "Propostas criadas." }]);
    const run = await createHostedRun(await kitOf("supplier-payments-agent"), ports({ rail: { executor: "codespar-test", proposals, mandate: playgroundMandate("supplier-payments-agent") }, model: { mode: "model", runtime: model } }), {
      commandId: "c",
      modelMode: "model",
      executor: "codespar-test",
      options: {},
    });
    await run.turn({ commandId: "t", text: "paga o lote de teste" });
    const report = toolResult(model, "codespar_pay") as { lines: Array<{ dispatch: string }>; failed: string[]; awaiting_proposal_decision: string[] };
    expect(report.lines.map((l) => l.dispatch)).toEqual(["awaiting_proposal_decision", "awaiting_proposal_decision"]);
    expect(report.failed).toEqual([]);
    expect(report.awaiting_proposal_decision).toEqual(["conta-teste", "conta-teste-projeto"]);
  });
});

describe("the hosted channel says where the result is", () => {
  it("a recorded reply that points at the terminal names the run's panel; the recording and the bundle keep the original", async () => {
    const state = new MemoryState();
    const run = await createHostedRun(await kitOf("bills-agent"), ports({ state }), { commandId: "c", modelMode: "replay", executor: "simulator", options: { exampleId: "happy-path" } });
    await run.turn({ commandId: "t", exampleTurn: 0 });
    const replied = (state.log.get(run.runId) ?? []).filter((e) => e.type === "assistant.replied").map((e) => (e.data as { text: string }).text);
    expect(replied).toHaveLength(1);
    expect(replied[0]).toContain("no painel desta execução");
    expect(replied[0]).not.toMatch(/terminal/i);
    const s = await run.snapshot();
    expect(s.turns[0]!.reply).toBe(replied[0]);
    const exported = await run.export();
    expect(JSON.stringify(exported.transcript)).toContain("O resultado está no terminal");
  });
});
