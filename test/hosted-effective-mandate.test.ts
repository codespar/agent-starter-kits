/**
 * A hosted Test run is bound to the mandate the host confirmed (the platform's
 * test receivers and the Playground's caps), not to the kit's example. The
 * model must read THAT mandate's payees and caps, and the kit's data must name
 * payees that mandate can pay, or a real model refuses everything before any
 * tool runs (pkr_2Z9EIHQEt8XYavuO, 07/11). The replays stay as recorded.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Mandate } from "@codespar/agent-core";
import { createHostedRun } from "@codespar/agent-runtime";
import { FakeProposals, hostedKit, MemoryState, ports, ScriptedRuntime } from "../packages/agent-runtime/test/hosted-ports.js";

const ROOT = resolve(import.meta.dirname, "..");
const kitOf = (name: string) => hostedKit(join(ROOT, "agents", name), ROOT);
const EXAMPLE_PAYEES = /\b(escola|mercado|funcionaria|contas)\b/i;

/** The shape of the Playground's confirmed mandate in Test: two platform test receivers, R$ 30 per payment, R$ 100 a month, R$ 200 in all. */
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

describe("a Test run under the mandate the host confirmed, with a model", () => {
  it("bills-agent: the model reads conta-teste and the Playground's caps, never the example's payees, and list_bills offers what that mandate can pay", async () => {
    const mandate = playgroundMandate("bills-agent");
    const model = new ScriptedRuntime([[{ id: "tc_1", name: "list_bills", input: {} }], { text: "Há uma conta de teste de R$ 10,00." }]);
    const run = await createHostedRun(await kitOf("bills-agent"), ports({ rail: { executor: "codespar-test", proposals: new FakeProposals(), mandate }, model: { mode: "model", runtime: model } }), {
      commandId: "c",
      modelMode: "model",
      executor: "codespar-test",
      options: {},
    });
    await run.turn({ commandId: "t", text: "quais contas tenho para pagar?" });

    const system = model.systems[0]!;
    expect(system).toContain("`conta-teste`");
    expect(system).toContain("R$ 30,00");
    expect(system).toContain("R$ 100,00");
    expect(system).not.toMatch(EXAMPLE_PAYEES);

    const bills = toolResult(model, "list_bills")["bills"] as Array<{ alias: string; amount_minor: number }>;
    expect(bills.map((b) => b.alias)).toEqual(["conta-teste", "conta-teste-projeto"]);
    for (const bill of bills) expect(bill.amount_minor).toBeLessThanOrEqual(mandate.per_tx_cap_minor);
    expect(bills.reduce((sum, b) => sum + b.amount_minor, 0)).toBeLessThanOrEqual(mandate.periodic_cap!.cap_minor);
    expect(bills[0]!.amount_minor).toBe(1000);
  });

  it("supplier-payments-agent: list_payables offers one batch of the mandate's receivers, within its caps", async () => {
    const mandate = playgroundMandate("supplier-payments-agent");
    const model = new ScriptedRuntime([[{ id: "tc_1", name: "list_payables", input: {} }], { text: "Há um lote de teste." }]);
    const run = await createHostedRun(await kitOf("supplier-payments-agent"), ports({ rail: { executor: "codespar-test", proposals: new FakeProposals(), mandate }, model: { mode: "model", runtime: model } }), {
      commandId: "c",
      modelMode: "model",
      executor: "codespar-test",
      options: {},
    });
    await run.turn({ commandId: "t", text: "o que temos para pagar?" });
    expect(model.systems[0]).toContain("`conta-teste`");
    const batches = toolResult(model, "list_payables")["batches"] as Array<{ batch_ref: string; total_minor: number; lines: Array<{ alias: string; amount_minor: number }> }>;
    expect(batches).toHaveLength(1);
    expect(batches[0]!.lines.map((l) => l.alias)).toEqual(["conta-teste", "conta-teste-projeto"]);
    expect(batches[0]!.total_minor).toBeLessThanOrEqual(mandate.periodic_cap!.cap_minor);
    for (const line of batches[0]!.lines) expect(line.amount_minor).toBeLessThanOrEqual(mandate.per_tx_cap_minor);
  });

  it("the recommended Test example (bills conta-teste) replays to one platform proposal under that mandate", async () => {
    const proposals = new FakeProposals();
    const state = new MemoryState();
    const kit = await kitOf("bills-agent");
    expect(kit.descriptor.recommendations).toContainEqual({ example: "conta-teste", rank: 1, executor: "codespar-test" });
    const run = await createHostedRun(kit, ports({ state, rail: { executor: "codespar-test", proposals, mandate: playgroundMandate("bills-agent") } }), {
      commandId: "c",
      modelMode: "replay",
      executor: "codespar-test",
      options: { exampleId: "conta-teste" },
    });
    await run.turn({ commandId: "t", exampleTurn: 0 });
    const s = await run.snapshot();
    expect(s.pending.map((p) => p.kind)).toEqual(["payment_proposal"]);
    expect(proposals.submitted).toHaveLength(1);
    expect(proposals.submitted[0]).toMatchObject({ totalMinor: 1000, items: [{ amountMinor: 1000 }] });
  });

  it("under the example mandate nothing changes: the prompt names the example's payees and list_bills is the month's", async () => {
    const model = new ScriptedRuntime([[{ id: "tc_1", name: "list_bills", input: {} }], { text: "ok" }]);
    const run = await createHostedRun(await kitOf("bills-agent"), ports({ model: { mode: "model", runtime: model } }), { commandId: "c", modelMode: "model", executor: "simulator", options: {} });
    await run.turn({ commandId: "t", text: "quais contas vencem?" });
    expect(model.systems[0]).toContain("`escola`");
    const bills = toolResult(model, "list_bills")["bills"] as Array<{ alias: string; amount_minor: number }>;
    expect(bills.map((b) => b.alias)).toEqual(["escola", "mercado", "funcionaria", "contas"]);
    expect(bills[0]!.amount_minor).toBe(185000);
  });
});
