/**
 * The timeline `inspect` assembles, against a proof bundle written by hand in
 * the test rather than by the engine: what the command reads is the contract
 * of section 11, so the fixture states that contract instead of inheriting
 * whatever the engine happens to write today.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProofBundle } from "@codespar/agent-core";
import { assembleTimeline, redactorFor, renderHtml, renderText, VERIFY_NOTE } from "../src/inspect.js";

const ESCOLA = "financeiro@escola-aurora.example.com.br";
const MASKED = "fi***@escola-aurora.example.com.br";
const MERCADO = "+5511999990001";
const AGENT = { type: "agent", agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo_titular" };
const PERSON = { type: "human", id: "usr_demo_titular", channel: "terminal" };

/**
 * A run with two executions: one escalated to a person and settled, one the
 * rail refused. Every file the bundle promises except `verify.json`.
 */
function fixtureBundle(): ProofBundle {
  const dir = mkdtempSync(join(tmpdir(), "inspect-fixture-"));
  const bundle = new ProofBundle(dir, "run_fixture_human_abc123");

  bundle.meta({ run_id: "run_fixture_human_abc123", agent: "bills-agent@0.1.0", mode: "mandate", rail: "stub", mandate_id: "cm_fixture", mandate_version: 3, started_at: "2026-09-23T18:00:00.000Z" });

  writeFileSync(
    join(bundle.dir, "mandate.snapshot.json"),
    JSON.stringify({
      id: "cm_fixture",
      version: 3,
      status: "active",
      currency: "BRL",
      cap_minor: 7200000,
      per_tx_cap_minor: 250000,
      periodic_cap: { window: "month", cap_minor: 600000 },
      expires_at: "2027-09-23T00:00:00.000Z",
      // As the bundle writes it: already masked.
      beneficiaries: [{ alias: "escola", name: "Escola Aurora", payee: MASKED }],
      merchant_allowlist: [MASKED],
    }),
  );

  writeFileSync(
    join(bundle.dir, "approval.json"),
    JSON.stringify([
      {
        approval_id: "apr_one",
        execution_id: "exe_one",
        mode: "mandate",
        approver: { type: "person", id: "usr_demo_titular", channel: "terminal" },
        approved_at: "2026-09-23T18:00:15.000Z",
        expires_at: "2026-09-23T18:15:15.000Z",
        mandate: { id: "cm_fixture", version: 3 },
        items: [{ alias: "escola", beneficiary: "Escola Aurora", payee: ESCOLA, amount: 185000, currency: "BRL", description: "mensalidade outubro" }],
        items_hash: "sha256:deadbeef",
        // The detail names the payee in free text: masking the field alone would leave the key readable here.
        escalation: { trigger: "amount", detail: `total 185000 is above the threshold for ${ESCOLA}` },
        actor: PERSON,
        signature: { alg: "HMAC-SHA256", key_id: "local-dev-stub", value: "0".repeat(64) },
      },
    ]),
  );

  for (const event of [
    { seq: 1, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "execution.drafted", payload: { items: [{ alias: "escola", beneficiary: "Escola Aurora", payee: ESCOLA, amount: 185000, currency: "BRL", description: "mensalidade outubro" }], total: 185000, model_claimed_total: 120000, mode: "mandate" }, at: "2026-09-23T18:00:11.000Z", actor: AGENT },
    { seq: 2, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "execution.model_total_ignored", payload: { detail: "the model stated 120000; the core computed 185000" }, at: "2026-09-23T18:00:11.500Z", actor: AGENT },
    { seq: 3, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "execution.transition", payload: { from: "drafted", to: "awaiting_approval", at: "2026-09-23T18:00:12.000Z", actor: AGENT, reason: "escalated", detail: `amount: above the threshold for ${ESCOLA}` }, at: "2026-09-23T18:00:12.000Z", actor: AGENT },
    { seq: 4, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "approval.created", payload: { approval_id: "apr_one", approver: { type: "person", id: "usr_demo_titular", channel: "terminal" }, items_hash: "sha256:deadbeef", escalation: { trigger: "amount", detail: "x" } }, at: "2026-09-23T18:00:16.000Z", actor: AGENT },
    { seq: 5, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "execution.transition", payload: { from: "awaiting_approval", to: "approved", at: "2026-09-23T18:00:15.000Z", actor: PERSON }, at: "2026-09-23T18:00:15.000Z", actor: PERSON },
    { seq: 6, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "execution.transition", payload: { from: "approved", to: "executing", at: "2026-09-23T18:00:17.000Z", actor: AGENT, detail: "idempotency_key idk_one" }, at: "2026-09-23T18:00:17.000Z", actor: AGENT },
    { seq: 7, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "rail.dispatch", payload: { attempt_id: "att_one_0", payee: ESCOLA, amount: 185000, rail: "stub", idempotency_key: "idk_one" }, at: "2026-09-23T18:00:21.000Z", actor: AGENT },
    { seq: 8, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "rail.outcome", payload: { attempt_id: "att_one_0", status: "settled", transaction_id: "tx_one", receipt_id: "rcpt_one", money_moved: false, sandbox: true }, at: "2026-09-23T18:00:23.000Z", actor: AGENT },
    { seq: 9, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "commerce.payment.succeeded", payload: { attempt_id: "att_one_0", amount: 185000, payee: ESCOLA, receipt_id: "rcpt_one", actor: AGENT }, at: "2026-09-23T18:00:24.000Z", actor: AGENT },
    { seq: 10, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "receipt.saved", payload: { receipt_id: "rcpt_one", path: "receipts/rcpt_one.json" }, at: "2026-09-23T18:00:25.000Z", actor: AGENT },
    { seq: 11, run_id: "run_fixture_human_abc123", execution_id: "exe_one", type: "execution.transition", payload: { from: "executing", to: "settled", at: "2026-09-23T18:00:26.000Z", actor: AGENT }, at: "2026-09-23T18:00:26.000Z", actor: AGENT },

    { seq: 12, run_id: "run_fixture_human_abc123", execution_id: "exe_two", type: "execution.drafted", payload: { items: [{ alias: "mercado", beneficiary: "Mercado do Bairro", payee: MERCADO, amount: 64000, currency: "BRL" }], total: 64000, model_claimed_total: null, mode: "mandate" }, at: "2026-09-23T18:01:00.000Z", actor: AGENT },
    { seq: 13, run_id: "run_fixture_human_abc123", execution_id: "exe_two", type: "execution.transition", payload: { from: "drafted", to: "approved", at: "2026-09-23T18:01:01.000Z", actor: AGENT, detail: "within the signed allowance" }, at: "2026-09-23T18:01:01.000Z", actor: AGENT },
    { seq: 14, run_id: "run_fixture_human_abc123", execution_id: "exe_two", type: "execution.transition", payload: { from: "approved", to: "executing", at: "2026-09-23T18:01:02.000Z", actor: AGENT, detail: "idempotency_key idk_two" }, at: "2026-09-23T18:01:02.000Z", actor: AGENT },
    { seq: 15, run_id: "run_fixture_human_abc123", execution_id: "exe_two", type: "rail.dispatch", payload: { attempt_id: "att_two_0", payee: MERCADO, amount: 64000, rail: "stub", idempotency_key: "idk_two" }, at: "2026-09-23T18:01:03.000Z", actor: AGENT },
    { seq: 16, run_id: "run_fixture_human_abc123", execution_id: "exe_two", type: "rail.outcome", payload: { attempt_id: "att_two_0", status: "failed", code: "payee_refused", message: `the rail refused ${MERCADO}` }, at: "2026-09-23T18:01:04.000Z", actor: AGENT },
    { seq: 17, run_id: "run_fixture_human_abc123", execution_id: "exe_two", type: "rail.reconcile", payload: { attempt_id: "att_two_0", found: "failed" }, at: "2026-09-23T18:01:05.000Z", actor: AGENT },
    { seq: 18, run_id: "run_fixture_human_abc123", execution_id: "exe_two", type: "execution.transition", payload: { from: "executing", to: "failed", at: "2026-09-23T18:01:06.000Z", actor: AGENT, reason: "rail_failed" }, at: "2026-09-23T18:01:06.000Z", actor: AGENT },

    { seq: 19, run_id: "run_fixture_human_abc123", execution_id: null, type: "execution.refused_before_draft", payload: { reason: "mandate_revoked", detail: "mandate cm_fixture was revoked" }, at: "2026-09-23T18:02:00.000Z", actor: AGENT },
    { at: "2026-09-23T18:02:01.000Z", type: "tool.refused", tool: "codespar_transfer", reason: "tool_not_allowed", actor: AGENT },
  ]) {
    bundle.event(event as Record<string, unknown>);
  }

  writeFileSync(join(bundle.dir, "receipts", "rcpt_one.json"), JSON.stringify({ receipt_id: "rcpt_one", state: "paid", payment: { amount_minor: 185000, payee: MASKED, money_moved: false, sandbox: true, at: "2026-09-23T18:00:22.000Z" }, actor: AGENT }));

  bundle.transcript({ at: "2026-09-23T18:00:02.000Z", kind: "user", text: "pague a escola de outubro" });
  bundle.transcript({ at: "2026-09-23T18:00:04.000Z", kind: "tool_call", name: "list_bills", input: {} });
  bundle.transcript({ at: "2026-09-23T18:00:07.000Z", kind: "tool_call", name: "codespar_pay", input: {} });
  bundle.transcript({ at: "2026-09-23T18:00:08.000Z", kind: "tool_result", name: "codespar_transfer", refused: true, content: {} });

  return bundle;
}

describe("the timeline `inspect` assembles from a bundle", () => {
  it("reads the run's mode, rail, mandate and the version it ran under", () => {
    const report = assembleTimeline(fixtureBundle());
    expect(report.run).toMatchObject({ run_id: "run_fixture_human_abc123", agent: "bills-agent@0.1.0", mode: "mandate", rail: "stub", mandate_id: "cm_fixture", mandate_version: 3 });
    expect(report.mandate).toMatchObject({ id: "cm_fixture", version: 3, status: "active", per_tx_cap_minor: 250000, cap_minor: 7200000, periodic_cap: { window: "month", cap_minor: 600000 } });
  });

  it("names who proposed what, with the total the core computed and the one the model claimed", () => {
    const report = assembleTimeline(fixtureBundle());
    const one = report.executions.find((e) => e.execution_id === "exe_one")!;
    expect(one.proposed_at).toBe("2026-09-23T18:00:11.000Z");
    expect(one.total_minor).toBe(185000);
    expect(one.model_claimed_total).toBe(120000);
    expect(one.items).toEqual([{ beneficiary: "Escola Aurora", payee: MASKED, amount_minor: 185000, currency: "BRL", description: "mensalidade outubro", due_date: null }]);
    expect(one.notes.some((n) => n.type === "execution.model_total_ignored")).toBe(true);
  });

  it("names who approved it and when, with the items_hash, the mandate version and the escalation trigger", () => {
    const report = assembleTimeline(fixtureBundle());
    const approval = report.executions.find((e) => e.execution_id === "exe_one")!.approval!;
    expect(approval).toMatchObject({ approval_id: "apr_one", approved_at: "2026-09-23T18:00:15.000Z", expires_at: "2026-09-23T18:15:15.000Z", items_hash: "sha256:deadbeef", mandate: { id: "cm_fixture", version: 3 } });
    expect(approval.approver).toEqual({ type: "person", id: "usr_demo_titular", channel: "terminal" });
    expect(approval.escalation?.trigger).toBe("amount");
  });

  it("carries every transition with its actor, in order", () => {
    const report = assembleTimeline(fixtureBundle());
    const one = report.executions.find((e) => e.execution_id === "exe_one")!;
    expect(one.transitions.map((t) => t.to)).toEqual(["awaiting_approval", "approved", "executing", "settled"]);
    expect(one.final_state).toBe("settled");
    expect(one.transitions[0]?.actor).toBe("agent bills-agent@0.1.0 for usr_demo_titular");
    expect(one.transitions[1]?.actor).toBe("usr_demo_titular (person, terminal)");
    expect(one.transitions[0]?.reason).toBe("escalated");
  });

  it("names the call that went out and what the rail answered, per attempt", () => {
    const report = assembleTimeline(fixtureBundle());
    const settled = report.executions.find((e) => e.execution_id === "exe_one")!.attempts[0]!;
    expect(settled).toMatchObject({ attempt_id: "att_one_0", idempotency_key: "idk_one", rail: "stub", amount_minor: 185000, payee: MASKED });
    expect(settled.answer).toMatchObject({ status: "settled", transaction_id: "tx_one", receipt_id: "rcpt_one", money_moved: false, sandbox: true });

    const refused = report.executions.find((e) => e.execution_id === "exe_two")!.attempts[0]!;
    expect(refused.answer).toMatchObject({ status: "failed", code: "payee_refused" });
    expect(refused.reconciles).toEqual([{ at: "2026-09-23T18:01:05.000Z", found: "failed" }]);
  });

  it("lists the receipts that came back, and the events that belong to no execution", () => {
    const report = assembleTimeline(fixtureBundle());
    expect(report.receipts).toEqual([{ receipt_id: "rcpt_one", file: "receipts/rcpt_one.json", state: "paid", amount_minor: 185000, payee: MASKED, money_moved: false, sandbox: true, at: "2026-09-23T18:00:22.000Z" }]);
    expect(report.executions.find((e) => e.execution_id === "exe_one")!.receipts).toEqual(["rcpt_one"]);
    expect(report.run_events.map((e) => e.type)).toEqual(["execution.refused_before_draft", "tool.refused"]);
  });

  it("reports the conversation as counts and never as text", () => {
    const report = assembleTimeline(fixtureBundle());
    expect(report.conversation).toEqual({ turns: 1, tool_calls: 2, tools: ["list_bills", "codespar_pay"], refused_tools: ["codespar_transfer"] });
    expect(JSON.stringify(report)).not.toContain("pague a escola de outubro");
  });

  it("says why verify.json is absent instead of pretending it is optional", () => {
    const report = assembleTimeline(fixtureBundle());
    expect(report.verify).toEqual({ present: false, note: VERIFY_NOTE });
    expect(report.verify.note).toContain("codespar audit replay");
  });
});

describe("masking: inspect never un-masks and never leaks a key it read raw", () => {
  it("no raw payee survives into the report, the text or the HTML", () => {
    const report = assembleTimeline(fixtureBundle());
    for (const rendering of [JSON.stringify(report), renderText(report), renderHtml(report)]) {
      expect(rendering).not.toContain(ESCOLA);
      expect(rendering).not.toContain(MERCADO);
      expect(rendering).toContain(MASKED);
    }
  });

  it("masks the payee named inside free text, not only the payee field", () => {
    const report = assembleTimeline(fixtureBundle());
    const one = report.executions.find((e) => e.execution_id === "exe_one")!;
    expect(one.approval?.escalation?.detail).toBe(`total 185000 is above the threshold for ${MASKED}`);
    expect(one.transitions[0]?.detail).toBe(`amount: above the threshold for ${MASKED}`);
    const two = report.executions.find((e) => e.execution_id === "exe_two")!;
    expect(two.attempts[0]?.answer?.message).toBe("the rail refused +551***0001");
  });

  it("leaves a value the bundle already masked alone", () => {
    const redact = redactorFor([ESCOLA, MERCADO]);
    expect(redact(`paid ${MASKED} today`)).toBe(`paid ${MASKED} today`);
    expect(redact(null)).toBeNull();
  });
});

describe("the renderings", () => {
  it("the terminal rendering shows the whole chain for one execution", () => {
    const text = renderText(assembleTimeline(fixtureBundle()));
    expect(text).toContain("mode mandate · rail stub · mandate cm_fixture v3");
    expect(text).toContain("execution exe_one — settled");
    expect(text).toContain("proposed");
    expect(text).toContain("items_hash sha256:deadbeef");
    expect(text).toContain("escalated by amount");
    expect(text).toContain("idempotency_key idk_one");
    expect(text).toContain("rail says   settled");
    expect(text).toContain("receipts/rcpt_one.json");
    expect(text).toContain("outside any execution");
  });

  it("the HTML is one standalone file: no script, no fetch, no external src or href", () => {
    const html = renderHtml(assembleTimeline(fixtureBundle()));
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("</html>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    // Same content as the terminal rendering.
    expect(html).toContain("exe_one");
    expect(html).toContain("sha256:deadbeef");
    expect(html).toContain("rcpt_one");
  });

  it("escapes what it puts in the HTML", () => {
    const bundle = fixtureBundle();
    bundle.event({ at: "2026-09-23T18:03:00.000Z", type: "tool.error", tool: "<img onerror=alert(1)>", message: "boom", actor: AGENT });
    const html = renderHtml(assembleTimeline(bundle));
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img onerror=alert(1)&gt;");
  });
});
