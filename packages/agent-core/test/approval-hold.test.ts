import { describe, expect, it } from "vitest";
import type { PaymentRail, RailPayment } from "../src/rail.js";
import { ESCOLA, harness, MERCADO } from "./helpers.js";

describe("provider approval holds", () => {
  it("keeps each provider approval beside the local artifact", async () => {
    const attempts: string[] = [];
    const rail: PaymentRail = {
      name: "stub",
      async pay(payment) {
        attempts.push(payment.attempt_id);
        return { status: "awaiting_approval" as const, approval_id: `apr_api_${payment.payee}`, raw: {} };
      },
      async lookup(_attemptId, payment) { return { status: "awaiting_approval" as const, approval_id: `apr_api_${payment.payee}`, raw: {} }; },
      async receipt() { return undefined; },
    };
    const h = harness({ wrapRail: () => rail });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const approved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });

    const held = await h.engine.execute(approved.id);
    const stored = h.store.getExecution(held.id)!;

    expect(stored).toMatchObject({
      state: "executing",
      reason: "rail_awaiting_approval",
      approval_id: approved.approval_id,
      outcomes: [],
      rail_approvals: [
        { attempt_id: attempts[0], approval_id: `apr_api_${ESCOLA}` },
        { attempt_id: attempts[1], approval_id: `apr_api_${MERCADO}` },
      ],
    });
    expect(stored.detail).toContain(`apr_api_${ESCOLA}`);
    expect(stored.detail).toContain(`apr_api_${MERCADO}`);
    expect(h.store.getOutbox(stored.idempotency_key)?.status).toBe("sent");
    expect(h.store.getApproval(stored.approval_id!)?.approval_id).toBe(stored.approval_id);
    expect(stored.rail_approvals?.every((approval) => approval.approval_id !== stored.approval_id)).toBe(true);
  });

  it("keeps the local approval separate, reuses its attempt, and closes after the provider settles", async () => {
    let approved = false;
    const attempts: string[] = [];
    const rail: PaymentRail = {
      name: "stub",
      async pay(payment) {
        attempts.push(payment.attempt_id);
        return { status: "awaiting_approval", approval_id: "apr_api", raw: {} };
      },
      async lookup(_attemptId: string, payment: RailPayment) {
        attempts.push(payment.attempt_id);
        return approved
          ? { status: "settled" as const, transaction_id: "tx_api", receipt_id: null, money_moved: false, sandbox: true, raw: {} }
          : { status: "awaiting_approval" as const, approval_id: "apr_api", raw: {} };
      },
      async receipt() { return undefined; },
    };
    const h = harness({ wrapRail: () => rail });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const locallyApproved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });
    const held = await h.engine.execute(locallyApproved.id);
    expect(held).toMatchObject({ state: "executing", reason: "rail_awaiting_approval", approval_id: locallyApproved.approval_id, rail_approvals: [{ approval_id: "apr_api" }] });
    expect((await h.engine.reconcile(held.id)).reason).toBe("rail_awaiting_approval");
    approved = true;
    const settled = await h.engine.reconcile(held.id);
    expect(settled).toMatchObject({ state: "settled" });
    expect(settled.rail_approvals).toBeUndefined();
    expect(new Set(attempts)).toHaveLength(1);
  });

  it("records each distinct provider hold once while other attempts resolve", async () => {
    let expiry = "2026-11-13T02:04:49.000Z";
    const rail: PaymentRail = {
      name: "stub",
      async pay(payment) {
        return { status: "awaiting_approval", approval_id: `apr_${payment.payee}`, expires_at: expiry, raw: {} };
      },
      async lookup(_attemptId, payment) {
        if (payment.payee === ESCOLA) return { status: "settled" as const, transaction_id: "tx_escola", receipt_id: null, money_moved: false, sandbox: true, raw: {} };
        return { status: "awaiting_approval" as const, approval_id: "apr_mercado", expires_at: expiry, raw: {} };
      },
      async receipt() { return undefined; },
    };
    const h = harness({ wrapRail: () => rail });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const approved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });
    const held = await h.engine.execute(approved.id);
    const first = await h.engine.reconcile(held.id);
    expect(first).toMatchObject({ state: "executing", reason: "rail_awaiting_approval", outcomes: [{ status: "settled" }], rail_approvals: [{ approval_id: "apr_mercado", expires_at: expiry }] });
    await h.engine.reconcile(held.id);
    expiry = "2026-11-14T02:04:49.000Z";
    const changed = await h.engine.reconcile(held.id);
    expect(changed).toMatchObject({ state: "executing", reason: "rail_awaiting_approval", rail_approvals: [{ approval_id: "apr_mercado", expires_at: expiry }] });
    expect(h.store.listEvents({ execution_id: held.id }).filter((event) => event.type === "rail.reconcile" && (event.payload as { found?: string }).found === "awaiting_approval")).toHaveLength(2);
  });

  it("reconciles each unresolved held attempt once and leaves a failed sibling final", async () => {
    const calls: string[] = [];
    const rail: PaymentRail = {
      name: "stub",
      async pay(payment) { return { status: "awaiting_approval" as const, approval_id: `apr_${payment.payee}`, raw: {} }; },
      async lookup(attemptId, payment) {
        calls.push(attemptId);
        return payment.payee === ESCOLA
          ? { status: "failed" as const, code: "psp_attempt_conflict", message: "denied", spent: true }
          : { status: "awaiting_approval" as const, approval_id: "apr_mercado", raw: {} };
      },
      async receipt() { return undefined; },
    };
    const h = harness({ wrapRail: () => rail });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const approved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });
    const held = await h.engine.execute(approved.id);

    const first = await h.engine.reconcile(held.id);
    const callsAfterFirst = [...calls];
    const second = await h.engine.reconcile(held.id);

    expect(first).toMatchObject({ state: "executing", reason: "rail_awaiting_approval", outcomes: [{ status: "failed", code: "psp_attempt_conflict" }], rail_approvals: [{ approval_id: "apr_mercado" }] });
    expect(second.state).toBe("executing");
    expect(callsAfterFirst).toHaveLength(2);
    expect(calls).toEqual([callsAfterFirst[0], callsAfterFirst[1], callsAfterFirst[1]]);
  });

  it("closes failed on a denied hold and never presents another attempt", async () => {
    const presented: string[] = [];
    const looked: string[] = [];
    const rail: PaymentRail = {
      name: "stub",
      async pay(payment) {
        presented.push(payment.attempt_id);
        return { status: "awaiting_approval" as const, approval_id: "apr_api", raw: {} };
      },
      async lookup(attemptId) {
        looked.push(attemptId);
        return { status: "failed" as const, code: "psp_attempt_conflict", message: "denied", spent: true };
      },
      async receipt() { return undefined; },
    };
    const h = harness({ wrapRail: () => rail });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const approved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });
    const held = await h.engine.execute(approved.id);

    const denied = await h.engine.reconcile(held.id);
    await h.engine.reconcile(held.id);

    expect(denied).toMatchObject({ state: "failed", outcomes: [{ status: "failed", code: "psp_attempt_conflict" }] });
    expect(denied.rail_approvals).toBeUndefined();
    // One payment presented, and every later look names that same attempt.
    expect(presented).toHaveLength(1);
    expect(looked.length).toBeGreaterThan(0);
    expect(new Set(looked)).toEqual(new Set(presented));
  });

  it("saves one receipt when the provider settles a held attempt", async () => {
    const h = harness({ rail: { approvalPayees: [ESCOLA] } });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const approved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });
    const held = await h.engine.execute(approved.id);
    h.rail.setApprovalDecision(held.rail_approvals![0]!.attempt_id, "approved");

    const settled = await h.engine.reconcile(held.id);
    await h.engine.reconcile(held.id);

    expect(settled).toMatchObject({ state: "settled", outcomes: [{ status: "settled", receipt_id: expect.stringMatching(/^rcpt_stub_/) }] });
    expect(h.store.listEvents({ execution_id: held.id }).filter((event) => event.type === "receipt.saved")).toHaveLength(1);
    expect(h.store.listEvents({ execution_id: held.id }).filter((event) => event.type === "commerce.payment.succeeded")).toHaveLength(1);
  });

  it("removes a resolved provider approval while another attempt remains unresolved", async () => {
    let reconciled = false;
    const rail: PaymentRail = {
      name: "stub",
      async pay(payment) {
        return payment.payee === ESCOLA
          ? { status: "awaiting_approval" as const, approval_id: "apr_escola", raw: {} }
          : { status: "uncertain" as const, code: "provider_error", message: "answer lost" };
      },
      async lookup(_attemptId, payment) {
        if (payment.payee !== ESCOLA) return undefined;
        return reconciled
          ? { status: "settled" as const, transaction_id: "tx_escola", receipt_id: null, money_moved: false, sandbox: true, raw: {} }
          : { status: "awaiting_approval" as const, approval_id: "apr_escola", raw: {} };
      },
      async receipt() { return undefined; },
    };
    const h = harness({ wrapRail: () => rail });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const approved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });
    const held = await h.engine.execute(approved.id);
    reconciled = true;
    const open = await h.engine.reconcile(held.id);
    expect(open).toMatchObject({ state: "executing", reason: "rail_uncertain", outcomes: [{ status: "settled" }] });
    expect(open.rail_approvals).toBeUndefined();
  });

  it("keeps an unknown attempt ahead of a provider hold", async () => {
    const rail: PaymentRail = {
      name: "stub",
      async pay(payment) {
        return payment.payee === ESCOLA
          ? { status: "awaiting_approval" as const, approval_id: "apr_escola", raw: {} }
          : { status: "uncertain" as const, code: "provider_error", message: "answer lost" };
      },
      async lookup() { return undefined; },
      async receipt() { return undefined; },
    };
    const h = harness({ wrapRail: () => rail });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const approved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });

    const open = await h.engine.execute(approved.id);

    expect(open).toMatchObject({ state: "executing", reason: "rail_uncertain", rail_approvals: [{ approval_id: "apr_escola" }] });
    expect(open.detail).toContain("provider_error");
  });

  it("records no reconcile event id for an unknown attempt the rail never saw", async () => {
    const rail: PaymentRail = {
      name: "stub",
      async pay() { return { status: "uncertain" as const, code: "provider_error", message: "answer lost" }; },
      async lookup() { return undefined; },
      async receipt() { return undefined; },
    };
    const h = harness({ wrapRail: () => rail });
    const drafted = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!drafted.ok) throw new Error("draft refused");
    const approved = h.engine.approve(drafted.execution.id, { id: "usr_demo", channel: "terminal" });
    const open = await h.engine.execute(approved.id);

    await h.engine.reconcile(open.id);
    await h.engine.reconcile(open.id);

    expect(h.store.listEvents({ execution_id: open.id }).filter((event) => event.type === "rail.reconcile")).toHaveLength(2);
  });
});
