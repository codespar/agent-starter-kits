/**
 * Recarga (topup-agent) on the integrated Test (CONTRATO v1.6), through the
 * hosted channel with a scripted model and IN-MEMORY ports: the pulls and the
 * state here are a SIMULATION of the host, not the platform and not the
 * provider's sandbox. What they prove is the kit's side: that a pull goes
 * through the host's pull port under the consent's own mandate (never the
 * Playground's spending mandate, never a proposal), that the signing page
 * never enters the run, and that a resume or a lost answer sends nothing twice.
 * The platform's side (the consent, the pull at the provider) is proved on the
 * enterprise, against its own records.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Mandate } from "@codespar/agent-core";
import { createHostedRun, HostedRefusal, type HostedEvent } from "@codespar/agent-runtime";
import { FakeProposals, FakePulls, hostedKit, MemoryState, ports, ScriptedRuntime } from "../packages/agent-runtime/test/hosted-ports.js";

const ROOT = resolve(import.meta.dirname, "..");
const kitOf = (name: string) => hostedKit(join(ROOT, "agents", name), ROOT);

/** The person's own account the consent pulls into: a funding source id, not an account number. */
const OWN_ACCOUNT = "fs_fixture_own_account";

/** The mandate the host builds from the person's consent at the bank: one account, the platform's Test limits. */
function consentMandate(): Mandate {
  return {
    id: "ofb_fixture_consent",
    version: 1,
    consumer_id: "sbx_prj_fixture",
    agent_id: "topup-agent",
    purpose: "recarga da própria conta: consentimento Pix com biometria no banco",
    currency: "BRL",
    cap_minor: 100000,
    per_tx_cap_minor: 10000,
    merchant_pin_kind: "merchant-id",
    merchant_allowlist: [OWN_ACCOUNT],
    // The host's alias for the project's own account; the run names it by the kit's own alias (minha-conta).
    beneficiaries: [{ alias: "conta-propria", name: "Sua conta de teste", payee: OWN_ACCOUNT }],
    status: "active",
    expires_at: "2027-11-08T00:00:00.000Z",
    source: "consent",
  };
}

function toolResults(model: ScriptedRuntime, name: string): Array<Record<string, unknown>> {
  const seen = new Map<string, Record<string, unknown>>();
  for (const step of model.seen) for (const m of step) if (m.role === "tool" && m.name === name) seen.set(m.tool_call_id, JSON.parse(m.content) as Record<string, unknown>);
  return [...seen.values()];
}

const count = (state: MemoryState, runId: string, type: HostedEvent["type"]) => (state.log.get(runId) ?? []).filter((e) => e.type === type).length;

/** The recommended run's two turns: the request, a yes, one pull of R$ 1,00. */
function happyModel(): ScriptedRuntime {
  return new ScriptedRuntime([
    [{ id: "tc_1", name: "account_status", input: {} }],
    { text: "Posso pedir ao seu banco para puxar R$ 1,00 para a sua conta? Responda sim ou não." },
    [{ id: "tc_2", name: "codespar_charge", input: { action: "create", account: "minha-conta", amount_minor: 100 } }],
    { text: "Pedi ao seu banco. Confirme a recarga com a sua biometria no painel desta execução." },
  ]);
}

async function startHappy(pulls: FakePulls, state = new MemoryState()) {
  const kit = await kitOf("topup-agent");
  const proposals = new FakeProposals();
  const model = happyModel();
  const run = await createHostedRun(kit, ports({ state, rail: { executor: "codespar-test", pulls, mandate: consentMandate() }, model: { mode: "model", runtime: model } }), {
    commandId: "c",
    modelMode: "model",
    executor: "codespar-test",
    options: { exampleId: "happy-path" },
  });
  await run.turn({ commandId: "t-1", exampleTurn: 0 });
  await run.turn({ commandId: "t-2", text: "sim" });
  return { kit, run, state, model, proposals };
}

describe("Recarga (topup-agent) on the integrated Test", () => {
  it("is offered there with the person's consent as its authority: no spending mandate, a rail record, never a CodeSpar receipt", async () => {
    const { descriptor } = await kitOf("topup-agent");
    expect(descriptor.recommendedRuns).toEqual([{ executor: "codespar-test", modelMode: "model", example: "happy-path", rank: 6 }]);
    const integrated = descriptor.executors.find((e) => e.id === "codespar-test")!;
    expect(integrated).toEqual({ id: "codespar-test", evidence: "rail_record", requires: ["platform.test_project", "platform.consent_pulls"], blockedBy: [] });
    expect(integrated.requires).not.toContain("platform.consumer_mandate");
  });

  it("consent → one pull at the bank → the person signs → settled with the end-to-end id, and a resume after that sends nothing again", async () => {
    const pulls = new FakePulls(OWN_ACCOUNT);
    const { run, state, model, proposals } = await startHappy(pulls);
    expect(model.seen[0]!.at(-1)).toEqual({ role: "user", content: "oi, quero colocar R$ 1 na minha conta" });

    // One pull, to the consent's one account, for the amount the person said yes to. No proposal: this is not a spend.
    expect(pulls.sent.map((r) => [r.payee, r.amountMinor, r.currency])).toEqual([[OWN_ACCOUNT, 100, "BRL"]]);
    expect(proposals.submitted).toEqual([]);
    expect(toolResults(model, "codespar_charge")[0]).toMatchObject({ status: "executing", waiting_for_bank: true, paid: false, bank_asked: true });

    const waiting = await run.snapshot();
    expect(waiting.run.status).toBe("awaiting_payer");
    const [pullId] = pulls.ids;
    // The person acts at the bank; the run cannot simulate them and holds no link to their page.
    expect(waiting.pending).toEqual([
      { kind: "payer", executionId: waiting.executions[0]!.id, chargeId: pullId, instalment: 1, instrument: { payable: true, status: "pending", dueDate: null, pixCopyPaste: null, boletoLine: null, consentUrl: null }, simulatable: false },
    ]);
    await expect(run.simulatePayer({ commandId: "sp", executionId: waiting.executions[0]!.id, behaviour: "pays" })).rejects.toMatchObject({ code: "payer_not_simulatable" });
    expect(waiting.executions[0]!.evidence).toEqual([{ kind: "rail_record", id: pullId, detail: "pull pending; waiting for the person at their bank, nothing moved" }]);
    const presented = (state.log.get(run.runId) ?? []).filter((e) => e.type === "instrument.presented");
    expect(presented.map((e) => (e.data as { consentUrl: string | null }).consentUrl)).toEqual([null]);
    expect(JSON.stringify(state.log.get(run.runId))).not.toMatch(/https?:\/\//);

    pulls.sign(pullId!, "E44471172202611082256U8b4e759cc1");
    const settled = await run.resume({ commandId: "r-1" });
    expect(settled.run.status).toBe("idle");
    expect(settled.executions.map((e) => [e.state, e.reason])).toEqual([["settled", null]]);
    expect(settled.executions[0]!.evidence).toEqual([{ kind: "rail_record", id: pullId, detail: null }]);

    // Resume again: nothing sent, dispatched or settled twice.
    const before = { sent: pulls.sent.length, dispatches: count(state, run.runId, "dispatch.attempted"), confirmed: count(state, run.runId, "outcome.confirmed"), proposals: proposals.submitted.length };
    await run.resume({ commandId: "r-2" });
    expect({ sent: pulls.sent.length, dispatches: count(state, run.runId, "dispatch.attempted"), confirmed: count(state, run.runId, "outcome.confirmed"), proposals: proposals.submitted.length }).toEqual(before);
    expect(before).toEqual({ sent: 1, dispatches: 1, confirmed: 1, proposals: 0 });
  });

  it("a pull whose answer was lost is asked for again under the same attempt, which the host answers with the same pull", async () => {
    const pulls = new FakePulls(OWN_ACCOUNT);
    pulls.loseNextAnswer = true;
    const { run } = await startHappy(pulls);
    expect(pulls.sent).toHaveLength(1);

    // Whichever look learns the pull (the turn's own look or this resume), it asks under the same attempt and gets the same pull.
    const looked = await run.resume({ commandId: "r-1" });
    expect(looked.run.status).toBe("awaiting_payer");
    expect(looked.pending.map((p) => p.kind)).toEqual(["payer"]);
    expect(pulls.submits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pulls.submits).size).toBe(1);
    expect(pulls.sent).toHaveLength(1);

    pulls.sign(pulls.ids[0]!, "E44471172202611082256U8b4e759cc2");
    const settled = await run.resume({ commandId: "r-2" });
    expect(settled.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(pulls.sent).toHaveLength(1);
  });

  it("a pull the person never signs ends expired, nothing moved, and is never sent again", async () => {
    const pulls = new FakePulls(OWN_ACCOUNT);
    const { run, state } = await startHappy(pulls);
    pulls.timeOut(pulls.ids[0]!);
    const ended = await run.resume({ commandId: "r-1" });
    expect(ended.executions.map((e) => [e.state, e.reason])).toEqual([["failed", "charge_expired"]]);
    await run.resume({ commandId: "r-2" });
    expect(pulls.sent).toHaveLength(1);
    expect(count(state, run.runId, "dispatch.attempted")).toBe(1);
  });

  it("without a consent registered at the bank, the host refuses before anything is sent, and the model is told why", async () => {
    const pulls = new FakePulls(OWN_ACCOUNT);
    pulls.consent = false;
    const { run, model } = await startHappy(pulls);
    expect(pulls.sent).toEqual([]);
    const s = await run.snapshot();
    expect(s.executions.map((e) => [e.state, e.reason])).toEqual([["failed", "rail_failed"]]);
    expect(String(toolResults(model, "codespar_charge")[0]!["detail"])).toContain("consent_required");
    expect(s.pending).toEqual([]);
  });

  it("an amount above the kit's threshold is the person's decision inside the run, then one pull", async () => {
    const pulls = new FakePulls(OWN_ACCOUNT);
    const model = new ScriptedRuntime([[{ id: "tc_1", name: "codespar_charge", input: { action: "create", account: "minha-conta", amount_minor: 400 } }], { text: "Esse valor pede a sua confirmação." }]);
    const host = ports({ rail: { executor: "codespar-test", pulls, mandate: consentMandate() }, model: { mode: "model", runtime: model } });
    const run = await createHostedRun(await kitOf("topup-agent"), host, { commandId: "c", modelMode: "model", executor: "codespar-test", options: {} });
    await run.turn({ commandId: "t", text: "sim, R$ 4,00" });
    const asked = await run.snapshot();
    expect(asked.run.status).toBe("awaiting_decision");
    const decision = asked.pending.find((p) => p.kind === "decision");
    expect(decision).toBeDefined();
    expect(pulls.sent).toEqual([]);
    if (decision?.kind !== "decision") throw new Error("no decision pending");
    const decided = await run.decide({ commandId: "d", executionId: decision.executionId, decision: "approve", binding: decision.binding });
    expect(host.decisions).toEqual([{ executionId: decision.executionId, decision: "approve" }]);
    expect(pulls.sent.map((r) => r.amountMinor)).toEqual([400]);
    expect(decided.run.status).toBe("awaiting_payer");
  });

  it("a host that offers the other port is refused, never adapted: proposals to a pull kit, pulls to a proposal kit", async () => {
    const topup = await kitOf("topup-agent");
    await expect(
      createHostedRun(topup, ports({ rail: { executor: "codespar-test", proposals: new FakeProposals() }, model: { mode: "model", runtime: new ScriptedRuntime([]) } }), { commandId: "c", modelMode: "model", executor: "codespar-test", options: {} }),
    ).rejects.toBeInstanceOf(HostedRefusal);
    const bills = await kitOf("bills-agent");
    await expect(
      createHostedRun(bills, ports({ rail: { executor: "codespar-test", pulls: new FakePulls(OWN_ACCOUNT), mandate: consentMandate() }, model: { mode: "model", runtime: new ScriptedRuntime([]) } }), { commandId: "c", modelMode: "model", executor: "codespar-test", options: {} }),
    ).rejects.toMatchObject({ code: "executor_unsupported" });
  });
});
