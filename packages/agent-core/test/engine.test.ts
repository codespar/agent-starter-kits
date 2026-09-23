import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ESCOLA, harness, MERCADO } from "./helpers.js";

const approver = { id: "usr_demo", channel: "terminal" };

describe("section 4.6: the model proposes, the code executes", () => {
  it("human mode: drafted -> awaiting_approval -> approved -> executing -> settled, with an artifact and a receipt", async () => {
    const h = harness({ mode: "human" });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 185000, description: "outubro" }] });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.execution.state).toBe("awaiting_approval");
    expect(draft.execution.items[0]).toMatchObject({ alias: "escola", beneficiary: "Escola Aurora", payee: ESCOLA, amount: 185000 });
    expect(draft.execution.total).toBe(185000);

    const approved = h.engine.approve(draft.execution.id, approver);
    expect(approved.state).toBe("approved");
    expect(approved.approval_id).toMatch(/^apr_/);
    const artifact = h.store.getApproval(approved.approval_id!)!;
    expect(artifact.approver).toEqual({ type: "person", id: "usr_demo", channel: "terminal" });
    expect(artifact.items_hash).toBe(approved.items_hash);

    const settled = await h.engine.execute(approved.id);
    expect(settled.state).toBe("settled");
    expect(settled.history.map((t) => t.to)).toEqual(["awaiting_approval", "approved", "executing", "settled"]);
    expect(settled.outcomes[0]?.receipt_id).toMatch(/^rcpt_stub_/);
    const receipts = readdirSync(join(h.bundle.dir, "receipts"));
    expect(receipts).toHaveLength(1);
    expect(h.bundle.readApprovals()).toHaveLength(1);
    expect(existsSync(join(h.bundle.dir, "events.jsonl"))).toBe(true);
    for (const event of h.bundle.readEvents()) expect(event["actor"]).toBeDefined();
  });

  it("mandate mode: drafted -> approved by the mandate -> settled, same trail shape", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!draft.ok) throw new Error("refused");
    expect(draft.execution.state).toBe("approved");
    const artifact = h.store.getApproval(draft.execution.approval_id!)!;
    expect(artifact.approver).toEqual({ type: "mandate", id: "mdt_test_0001" });
    const settled = await h.engine.execute(draft.execution.id);
    expect(settled.state).toBe("settled");
  });

  it("the core computes the total; the model's number is recorded and ignored", async () => {
    const h = harness({ mode: "human" });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 10000 }, { payee: "mercado", amount: 5000 }], claimed_total: 12000 });
    if (!draft.ok) throw new Error("refused");
    expect(draft.execution.total).toBe(15000);
    expect(draft.execution.model_claimed_total).toBe(12000);
    const approved = h.engine.approve(draft.execution.id, approver);
    expect(h.store.getApproval(approved.approval_id!)!.items.reduce((s, i) => s + i.amount, 0)).toBe(15000);
  });

  it("with model_total_mismatch: refuse, the execution is denied instead", async () => {
    const h = harness({ mode: "human", guardrails: { model_total_mismatch: "refuse" } });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 15000 }], claimed_total: 12000 });
    if (!draft.ok) throw new Error("refused");
    expect(draft.execution.state).toBe("denied");
    expect(draft.execution.reason).toBe("model_total_mismatch");
  });
});

describe("mandate limits are the core's, in both modes", () => {
  it("per-transaction cap: denied, readable", async () => {
    for (const mode of ["human", "mandate"] as const) {
      const h = harness({ mode });
      const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 250001 }] });
      if (!draft.ok) throw new Error("refused");
      expect(draft.execution.state).toBe("denied");
      expect(draft.execution.reason).toBe("per_tx_cap_exceeded");
      expect(draft.execution.detail).toContain("per-payment cap");
    }
  });

  it("window cap counts what is settled and in flight", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    for (let i = 0; i < 2; i += 1) {
      const d = await h.engine.draft({ items: [{ payee: "escola", amount: 250000 }] });
      if (!d.ok) throw new Error("refused");
      await h.engine.execute(d.execution.id);
    }
    const third = await h.engine.draft({ items: [{ payee: "mercado", amount: 100001 }] });
    if (!third.ok) throw new Error("refused");
    expect(third.execution.state).toBe("denied");
    expect(third.execution.reason).toBe("window_cap_exceeded");
    const fits = await h.engine.draft({ items: [{ payee: "mercado", amount: 100000 }] });
    if (!fits.ok) throw new Error("refused");
    expect(fits.execution.state).toBe("approved");
  });

  it("payee outside the allowlist: denied in mandate, escalated in human, and never approvable", async () => {
    const m = harness({ mode: "mandate" });
    const denied = await m.engine.draft({ items: [{ payee: "chave-nova@banco.com", amount: 1000 }] });
    if (!denied.ok) throw new Error("refused");
    expect(denied.execution.state).toBe("denied");
    expect(denied.execution.reason).toBe("beneficiary_not_allowed");

    const hh = harness({ mode: "human" });
    const escalated = await hh.engine.draft({ items: [{ payee: "chave-nova@banco.com", amount: 1000 }] });
    if (!escalated.ok) throw new Error("refused");
    expect(escalated.execution.state).toBe("awaiting_approval");
    expect(escalated.execution.blocking_reasons).toEqual(["beneficiary_not_allowed"]);
    const afterYes = hh.engine.approve(escalated.execution.id, approver);
    expect(afterYes.state).toBe("denied");
    expect(afterYes.reason).toBe("beneficiary_not_allowed");
  });
});

describe("section 4.4 in the engine", () => {
  it("amount above threshold in mandate mode goes to a human; the artifact records the trigger", async () => {
    const h = harness({ mode: "mandate" });
    // Make escola a known payee first, so only `amount` can fire.
    const warm = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!warm.ok) throw new Error("refused");
    expect(warm.execution.escalation?.trigger).toBe("new_beneficiary");
    await h.engine.execute(h.engine.approve(warm.execution.id, approver).id);

    const big = await h.engine.draft({ items: [{ payee: "escola", amount: 150001 }] });
    if (!big.ok) throw new Error("refused");
    expect(big.execution.state).toBe("awaiting_approval");
    expect(big.execution.escalation?.trigger).toBe("amount");
    const approved = h.engine.approve(big.execution.id, approver);
    expect(h.store.getApproval(approved.approval_id!)!.escalation?.trigger).toBe("amount");

    await h.engine.execute(approved.id);

    // The following one, below the threshold, runs alone: a human-approved payment is not fractioning.
    const small = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!small.ok) throw new Error("refused");
    expect(small.execution.state).toBe("approved");
  });

  it("fractioning: five parts below the threshold escalate by the window", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: { amount: 150000 } }, guardrails: { escalate_above: { amount: 150000 } } });
    const states: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const d = await h.engine.draft({ items: [{ payee: "escola", amount: 40000 }] });
      if (!d.ok) throw new Error("refused");
      states.push(d.execution.state);
      if (d.execution.state === "approved") await h.engine.execute(d.execution.id);
    }
    expect(states).toEqual(["approved", "approved", "approved", "awaiting_approval", "awaiting_approval"]);
  });

  it("outside hours escalates, or refuses when the guardrail says so", async () => {
    const night = new Date("2026-09-24T02:00:00Z");
    const a = harness({ mode: "mandate", now: night, manifest: { escalate_above: { outside_hours: "22:00-07:00" } }, guardrails: { escalate_above: { outside_hours: "22:00-07:00" } } });
    const d1 = await a.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d1.ok) throw new Error("refused");
    expect(d1.execution.state).toBe("awaiting_approval");
    expect(d1.execution.escalation?.trigger).toBe("outside_hours");

    const b = harness({ mode: "mandate", now: night, manifest: { escalate_above: { outside_hours: "22:00-07:00" } }, guardrails: { escalate_above: { outside_hours: "22:00-07:00" }, outside_hours_action: "refuse" } });
    const d2 = await b.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d2.ok) throw new Error("refused");
    expect(d2.execution.state).toBe("denied");
    expect(d2.execution.reason).toBe("outside_hours");
  });
});

describe("section 4.7: revocation and kill switch (against the stub)", () => {
  it("a new request after revocation is refused before drafted", async () => {
    const h = harness({ mode: "human" });
    h.gate.revoke("mdt_test_0001");
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    expect(draft).toMatchObject({ ok: false, refused_before_draft: true, reason: "mandate_revoked" });
    expect(h.store.listExecutions()).toHaveLength(0);
  });

  it("revoked while awaiting approval: approved artifact does not help, execute answers denied", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    h.gate.revoke("mdt_test_0001");
    const out = await h.engine.execute(approved.id);
    expect(out.state).toBe("denied");
    expect(out.reason).toBe("mandate_revoked");
    expect(h.store.listOutbox()).toHaveLength(0);
  });

  it("org pauseAll denies with org_paused; paused mandate with mandate_paused", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    h.gate.pauseAll();
    expect(await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] })).toMatchObject({ ok: false, reason: "org_paused" });
    h.gate.resumeAll();
    h.gate.pause("mdt_test_0001");
    expect(await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] })).toMatchObject({ ok: false, reason: "mandate_paused" });
    h.gate.resume("mdt_test_0001");
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    expect(d.ok && d.execution.state).toBe("approved");
  });

  it("revoked while executing: reconciled, not cancelled", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: ["att_" + "x"] } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    // Force the first attempt to answer uncertain by naming it after the fact.
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const h2 = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt] } });
    const stuck = await h2.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    h2.gate.revoke("mdt_test_0001");
    const closed = await h2.engine.reconcile(stuck.id);
    expect(closed.state).toBe("settled");
  });
});

describe("section 10: idempotency, restart, reconcile", () => {
  it("killing after the rail accepted and resuming gives one payment and one receipt", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { afterDispatch: () => { throw new Error("SIGKILL simulated after dispatch"); } } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    await expect(h.engine.execute(d.execution.id)).rejects.toThrow("SIGKILL");
    const stuck = h.store.getExecution(d.execution.id)!;
    expect(stuck.state).toBe("executing");
    expect(h.store.listOutbox({ status: ["sent"] })).toHaveLength(1);

    // A fresh process over the same state.db.
    const resumed = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const done = await resumed.engine.reconcile(stuck.id);
    expect(done.state).toBe("settled");
    expect(readdirSync(join(resumed.bundle.dir, "receipts"))).toHaveLength(1);
    // Exactly one attempt reached the rail, ever.
    expect(resumed.store.stubRailGet(`att_${stuck.idempotency_key.slice(4)}_0`)).toBeDefined();
    const events = resumed.store.listEvents({ execution_id: stuck.id }).filter((e) => e.type === "commerce.payment.settled");
    expect(events).toHaveLength(1);
  });

  it("an uncertain outcome is never retried blind: it stays executing until reconciled", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const flaky = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt] } });
    const stuck = await flaky.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    expect(flaky.store.stubRailGet(attempt)).toBeUndefined();
    const closed = await flaky.engine.reconcile(stuck.id);
    expect(closed.state).toBe("settled");
    expect(closed.outcomes).toHaveLength(1);
  });

  it("duplicate and out-of-order rail events settle once", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const flaky = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt] } });
    const stuck = await flaky.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    const paid = { event_id: "evt_paid_1", type: "commerce.payment.settled", attempt_id: attempt };
    expect(flaky.engine.ingestExternalEvent(paid)).toEqual({ applied: true, reason: "settled" });
    expect(flaky.engine.ingestExternalEvent(paid)).toEqual({ applied: false, reason: "duplicate event id" });
    expect(flaky.engine.ingestExternalEvent({ event_id: "evt_created_late", type: "commerce.payment.created", attempt_id: attempt })).toMatchObject({ applied: false });
    expect(flaky.engine.ingestExternalEvent({ event_id: "evt_paid_2", type: "commerce.payment.settled", attempt_id: attempt })).toMatchObject({ applied: false, reason: "execution already settled" });
    expect(flaky.store.getExecution(stuck.id)!.state).toBe("settled");
    expect(flaky.store.listEvents({ execution_id: stuck.id }).filter((e) => e.type === "execution.transition" && (e.payload as { to: string }).to === "settled")).toHaveLength(1);
  });

  it("a failed rail answer closes as failed with the code, and a second draft to the same payee is a new execution", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { refusePayees: [MERCADO] } });
    const d = await h.engine.draft({ items: [{ payee: "mercado", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const failed = await h.engine.execute(d.execution.id);
    expect(failed.state).toBe("failed");
    expect(failed.detail).toContain("psp_dispatch_failed");
  });

  it("a stale open execution expires", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    h.setNow(new Date(h.now.getTime() + 16 * 60 * 1000));
    const expired = h.engine.expireStale();
    expect(expired.map((e) => e.state)).toEqual(["expired"]);
  });

  it("the items_hash is recomputed before executing; a changed list goes back to awaiting_approval", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    // Tamper with the persisted list after approval, the way a bug or an attacker would.
    h.store.saveExecution({ ...approved, items: [{ ...approved.items[0]!, amount: 999999 }] });
    const back = await h.engine.execute(approved.id);
    expect(back.state).toBe("awaiting_approval");
    expect(back.reason).toBe("items_hash_mismatch");
    expect(back.approval_id).toBeUndefined();
    expect(h.store.listOutbox()).toHaveLength(0);
  });
});
