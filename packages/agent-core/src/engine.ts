/**
 * Section 4.6: the model proposes, the code executes. The model's only way
 * in is `draft()`, which creates an execution in `drafted` and nothing else.
 * Every check that decides whether money moves lives here, in
 * deterministic code: mandate status, allowlist, per-transaction and window
 * caps, `escalate_above`, the approval artifact and its `items_hash`.
 *
 * The policy runs THREE times, not once: at draft, when a human approves,
 * and immediately before `executing`, inside the same transaction that
 * writes the outbox row. A list that changed after approval, a window that
 * filled up between approval and execution, or a mandate revoked in the
 * meantime is caught at the last gate, which is the only one that matters.
 */
import { checkApprovalArtifact, createApprovalArtifact, type ApprovalSigner } from "./approval.js";
import type { ProofBundle } from "./bundle.js";
import { evaluateEscalation, type Escalation } from "./escalate.js";
import { PAYMENT_FAILED, PAYMENT_SUCCEEDED } from "./events.js";
import type { Guardrails } from "./guardrails.js";
import { itemsHash, sha256Hex } from "./hash.js";
import { newId } from "./ids.js";
import { mandateExpired, payeeAllowed, resolveBeneficiary, windowCap, windowStart, type Mandate } from "./mandate.js";
import type { Manifest } from "./manifest.js";
import type { PaymentRail, RailPayment } from "./rail.js";
import type { MandateStatusSource } from "./revocation.js";
import { isTerminal, transition, type Execution, type ExecutionState } from "./state-machine.js";
import type { StateStore } from "./state/store.js";
import type { Actor, ApprovalArtifact, ApprovalMode, ExecutionItem, ExecutionReason, ItemOutcome } from "./types.js";

export interface ProposedItem {
  /** An alias from the mandate's named payees, or a raw payee key. */
  payee: string;
  amount: number;
  description?: string;
}

export interface Proposal {
  items: ProposedItem[];
  /** What the model said the total was. Recorded; never used to pay. */
  claimed_total?: number;
}

export type DraftResult =
  | { ok: true; execution: Execution }
  | { ok: false; refused_before_draft: true; reason: ExecutionReason; message: string };

export interface EngineDeps {
  store: StateStore;
  rail: PaymentRail;
  status: MandateStatusSource;
  signer: ApprovalSigner;
  manifest: Manifest;
  guardrails: Guardrails;
  mandate: Mandate;
  bundle: ProofBundle;
  mode: ApprovalMode;
  runId: string;
  /** The person the agent acts for. */
  onBehalfOf: string;
  clock?: () => Date;
}

/** What the deterministic policy says about an execution at one of its three gates. */
type Verdict =
  | { kind: "ok" }
  | { kind: "deny"; reason: ExecutionReason; detail: string }
  | { kind: "block"; reason: ExecutionReason; detail: string }
  | { kind: "escalate"; escalation: Escalation };

type Gate = "draft" | "approve" | "execute";

/** Open executions reserve the window: a cap is a ceiling on what may be committed, not a balance. */
const WINDOW_STATES: ExecutionState[] = ["awaiting_approval", "approved", "executing", "settled"];

export class ExecutionEngine {
  readonly clock: () => Date;
  readonly agentActor: Actor;

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.agentActor = { type: "agent", agent: `${deps.manifest.name}@${deps.manifest.version}`, on_behalf_of: deps.onBehalfOf };
  }

  get mode(): ApprovalMode {
    return this.deps.mode;
  }

  get mandate(): Mandate {
    return this.deps.mandate;
  }

  // ---- the model's only entry point -------------------------------------

  async draft(proposal: Proposal): Promise<DraftResult> {
    const now = this.clock();
    const gate = await this.mandateGate();
    if (gate) {
      this.record("execution.refused_before_draft", null, { reason: gate.reason, detail: gate.detail });
      return { ok: false, refused_before_draft: true, reason: gate.reason, message: gate.detail };
    }

    const items = proposal.items.map((p) => this.resolveItem(p));
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    const id = newId("exe");
    const execution: Execution<"drafted"> = {
      id,
      run_id: this.deps.runId,
      state: "drafted",
      mode: this.deps.mode,
      actor: this.agentActor,
      items,
      total,
      currency: this.deps.mandate.currency,
      ...(proposal.claimed_total !== undefined ? { model_claimed_total: proposal.claimed_total } : {}),
      items_hash: itemsHash(items),
      mandate: { id: this.deps.mandate.id, version: this.deps.mandate.version },
      idempotency_key: `idk_${sha256Hex(`${this.deps.runId}:${id}`).slice(0, 32)}`,
      blocking_reasons: [],
      outcomes: [],
      history: [],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.deps.store.saveExecution(execution);
    this.record("execution.drafted", id, { items: execution.items, total, model_claimed_total: proposal.claimed_total ?? null, mode: this.deps.mode });

    return { ok: true, execution: await this.evaluateDraft(execution) };
  }

  // ---- deterministic policy ---------------------------------------------

  /**
   * The one policy, run at every gate. `humanApproved` is true when a person
   * already decided this execution: their decision satisfies `escalate_above`,
   * and only that. Everything else — allowlist, caps, window — is the
   * mandate's and no approval widens it.
   */
  private policy(execution: Execution, now: Date, gate: Gate, humanApproved: boolean): Verdict {
    const { mandate, guardrails, manifest } = this.deps;

    if (gate === "draft" && execution.model_claimed_total !== undefined && execution.model_claimed_total !== execution.total) {
      const detail = `the model stated ${execution.model_claimed_total}; the core computed ${execution.total} and that is the only number that counts`;
      if (guardrails.model_total_mismatch === "refuse") return { kind: "deny", reason: "model_total_mismatch", detail };
      this.record("execution.model_total_ignored", execution.id, { detail });
    }

    const blocked = execution.items.filter((i) => !payeeAllowed(mandate, i.payee));
    if (blocked.length > 0) {
      const detail = `payee not named in the signed allowlist: ${blocked.map((i) => i.beneficiary).join(", ")}`;
      // At draft in `human` the person is told; at any later gate, or in `mandate`, it is a refusal. escalate_above never widens the allowlist.
      if (gate === "draft" && this.deps.mode === "human") return { kind: "block", reason: "beneficiary_not_allowed", detail };
      return { kind: "deny", reason: "beneficiary_not_allowed", detail };
    }

    const over = execution.items.find((i) => i.amount > mandate.per_tx_cap_minor);
    if (over) return { kind: "deny", reason: "per_tx_cap_exceeded", detail: `${over.beneficiary}: ${over.amount} is above the per-payment cap ${mandate.per_tx_cap_minor}` };

    const committed = this.committedInWindow(now, execution.id);
    if (committed + execution.total > windowCap(mandate)) {
      return {
        kind: "deny",
        reason: "window_cap_exceeded",
        detail: `${committed} already committed this ${mandate.periodic_cap?.window ?? "month"} (settled, in flight and awaiting a decision) plus ${execution.total} exceeds the cap ${windowCap(mandate)}`,
      };
    }

    if (this.deps.mode === "mandate" && !humanApproved) {
      const escalation = evaluateEscalation(manifest.escalate_above, guardrails, execution.items, {
        now,
        timezone: guardrails.timezone,
        knownPayees: this.knownPayees(),
        recentByPayee: this.recentByPayee(now, execution.id),
      });
      if (escalation) {
        if (escalation.trigger === "outside_hours" && guardrails.outside_hours_action === "refuse") return { kind: "deny", reason: "outside_hours", detail: escalation.detail };
        return { kind: "escalate", escalation };
      }
    }

    return { kind: "ok" };
  }

  private async evaluateDraft(execution: Execution<"drafted">): Promise<Execution> {
    const now = this.clock();
    const at = now.toISOString();
    const gate = await this.mandateGate();
    if (gate) return this.persist(transition(execution, "denied", { at, actor: this.agentActor, reason: gate.reason, detail: gate.detail }));

    const verdict = this.policy(execution, now, "draft", false);
    switch (verdict.kind) {
      case "deny":
        return this.persist(transition(execution, "denied", { at, actor: this.agentActor, reason: verdict.reason, detail: verdict.detail }));
      case "block":
        return this.persist(transition({ ...execution, blocking_reasons: [verdict.reason] }, "awaiting_approval", { at, actor: this.agentActor, reason: verdict.reason, detail: verdict.detail }));
      case "escalate":
        return this.persist(transition({ ...execution, escalation: verdict.escalation }, "awaiting_approval", { at, actor: this.agentActor, reason: "escalated", detail: `${verdict.escalation.trigger}: ${verdict.escalation.detail}` }));
      case "ok":
        break;
    }
    if (this.deps.mode === "human") return this.persist(transition(execution, "awaiting_approval", { at, actor: this.agentActor }));

    // The allowance covers it: the approver is the mandate, and the artifact says so.
    const artifact = createApprovalArtifact(this.deps.signer, {
      execution,
      approver: { type: "mandate", id: this.deps.mandate.id },
      actor: this.agentActor,
      now,
      ttlMs: this.deps.guardrails.approval_ttl_minutes * 60_000,
    });
    this.storeApproval(artifact);
    return this.persist(transition({ ...execution, approval_id: artifact.approval_id }, "approved", { at, actor: this.agentActor, detail: "within the signed allowance" }));
  }

  // ---- the human's entry points -----------------------------------------

  approve(executionId: string, approver: { id: string; channel: string }): Execution {
    const execution = this.mustGet(executionId);
    if (execution.state !== "awaiting_approval") throw new Error(`execution ${executionId} is ${execution.state}, not awaiting_approval`);
    const now = this.clock();
    const at = now.toISOString();
    const humanActor: Actor = { type: "human", id: approver.id, channel: approver.channel };
    const awaiting = execution as Execution<"awaiting_approval">;
    if (execution.blocking_reasons.length > 0) {
      const reason = execution.blocking_reasons[0] as ExecutionReason;
      return this.persist(transition(awaiting, "denied", { at, actor: humanActor, reason, detail: `a human said yes, but ${reason} cannot be approved: the mandate does not authorize it` }));
    }
    // A yes does not skip the policy: the list may have changed since it was presented (4.2), or the window may have filled.
    const verdict = this.policy(execution, now, "approve", true);
    if (verdict.kind === "deny") return this.persist(transition(awaiting, "denied", { at, actor: humanActor, reason: verdict.reason, detail: `a human said yes, but ${verdict.detail}` }));

    const artifact = createApprovalArtifact(this.deps.signer, {
      execution,
      approver: { type: "person", id: approver.id, channel: approver.channel },
      actor: humanActor,
      now,
      ttlMs: this.deps.guardrails.approval_ttl_minutes * 60_000,
      ...(execution.escalation ? { escalation: execution.escalation } : {}),
    });
    this.storeApproval(artifact);
    return this.persist(transition({ ...awaiting, approval_id: artifact.approval_id }, "approved", { at, actor: humanActor }));
  }

  deny(executionId: string, approver: { id: string; channel: string }, detail = "denied by the approver"): Execution {
    const execution = this.mustGet(executionId);
    if (execution.state !== "awaiting_approval") throw new Error(`execution ${executionId} is ${execution.state}, not awaiting_approval`);
    const humanActor: Actor = { type: "human", id: approver.id, channel: approver.channel };
    return this.persist(transition(execution as Execution<"awaiting_approval">, "denied", { at: this.clock().toISOString(), actor: humanActor, reason: "denied_by_approver", detail }));
  }

  // ---- the only path to `executing` -------------------------------------

  async execute(executionId: string): Promise<Execution> {
    const execution = this.mustGet(executionId);
    if (execution.state !== "approved") throw new Error(`execution ${executionId} is ${execution.state}, not approved`);
    const now = this.clock();
    const at = now.toISOString();
    const approved = execution as Execution<"approved">;

    // 4.7: the artifact may predate a revocation. Ask the source, every time.
    const gate = await this.mandateGate();
    if (gate) return this.persist(transition(approved, "denied", { at, actor: this.agentActor, reason: gate.reason, detail: gate.detail }));

    const artifact = execution.approval_id ? this.deps.store.getApproval(execution.approval_id) : undefined;
    if (!artifact) throw new Error(`execution ${executionId} is approved without an approval artifact`);

    // Everything below is one transaction: the last policy run, the artifact check, the outbox row and the state change land together or not at all.
    const payments = this.paymentsFor(execution);
    const decided = this.deps.store.transaction((): Execution => {
      // The approval was given under one mandate; a re-signed one (new version) is a new authorization, and the person decides again under it.
      const current = { id: this.deps.mandate.id, version: this.deps.mandate.version };
      if (execution.mandate.id !== current.id || execution.mandate.version !== current.version) {
        return this.persist(transition({ ...this.withoutApproval(approved), mandate: current }, "awaiting_approval", { at, actor: this.agentActor, reason: "mandate_changed", detail: `approved under mandate ${execution.mandate.id} v${execution.mandate.version}; the mandate is now ${current.id} v${current.version}` }));
      }
      // 4.2: recompute the hash of what is about to be executed and compare.
      const check = checkApprovalArtifact(this.deps.signer, artifact, execution, now);
      if (!check.ok) {
        if (check.problem === "expired") {
          return this.persist(transition(approved, "expired", { at, actor: this.agentActor, reason: "approval_expired", detail: `approval ${artifact.approval_id} expired at ${artifact.expires_at}` }));
        }
        return this.persist(transition(this.withoutApproval(approved), "awaiting_approval", { at, actor: this.agentActor, reason: "items_hash_mismatch", detail: `approval ${artifact.approval_id} does not match what would be executed (${check.problem})` }));
      }

      const verdict = this.policy(execution, now, "execute", artifact.approver.type === "person");
      if (verdict.kind === "deny" || verdict.kind === "block") {
        return this.persist(transition(approved, "denied", { at, actor: this.agentActor, reason: verdict.reason, detail: verdict.detail }));
      }
      if (verdict.kind === "escalate") {
        return this.persist(transition({ ...this.withoutApproval(approved), escalation: verdict.escalation }, "awaiting_approval", { at, actor: this.agentActor, reason: "escalated", detail: `${verdict.escalation.trigger}: ${verdict.escalation.detail}` }));
      }

      this.deps.store.putOutbox({
        idempotency_key: execution.idempotency_key,
        execution_id: execution.id,
        kind: "rail.pay",
        payload: { attempts: payments.map((p) => p.attempt_id), items: execution.items },
        status: "pending",
        response: undefined,
        created_at: at,
      });
      return this.persist(transition(approved, "executing", { at, actor: this.agentActor, detail: `idempotency_key ${execution.idempotency_key}` }));
    });
    if (decided.state !== "executing") return decided;

    return this.dispatch(decided as Execution<"executing">, payments);
  }

  /**
   * Sends the attempts of an `executing` execution to the rail. The outbox row
   * flips to `sent` BEFORE the first call, so a crash after that point is
   * reconciled and never re-sent.
   */
  private async dispatch(execution: Execution<"executing">, payments: RailPayment[]): Promise<Execution> {
    const outcomes: ItemOutcome[] = [...execution.outcomes];
    this.deps.store.updateOutbox(execution.idempotency_key, "sent", undefined, this.clock().toISOString());

    for (const [index, payment] of payments.entries()) {
      if (outcomes.some((o) => o.index === index)) continue;
      this.record("rail.dispatch", execution.id, { attempt_id: payment.attempt_id, payee: payment.payee, amount: payment.amount_minor, rail: this.deps.rail.name });
      const outcome = await this.deps.rail.pay(payment);
      this.record("rail.outcome", execution.id, { attempt_id: payment.attempt_id, status: outcome.status, ...(outcome.status !== "settled" ? { code: outcome.code } : {}) });
      if (outcome.status === "uncertain") {
        this.record("rail.uncertain", execution.id, { attempt_id: payment.attempt_id, code: outcome.code, message: outcome.message });
        return this.leaveUnresolved({ ...execution, outcomes }, `attempt ${payment.attempt_id}: ${outcome.code} — outcome unknown, kept for reconciliation`);
      }
      if (outcome.status === "failed") {
        outcomes.push({ index, attempt_id: payment.attempt_id, status: "failed", error: `${outcome.code}: ${outcome.message}` });
        break;
      }
      outcomes.push({ index, attempt_id: payment.attempt_id, status: "settled", transaction_id: outcome.transaction_id, ...(outcome.receipt_id ? { receipt_id: outcome.receipt_id } : {}) });
      await this.ingestSettlement(execution, index, payment, outcome.receipt_id);
    }
    return this.close({ ...execution, outcomes }, payments.length);
  }

  /** Closes an `executing` execution from its recorded outcomes: failed if any failed, settled when every attempt settled, otherwise stays. */
  private close(execution: Execution<"executing">, attempts: number): Execution {
    const at = this.clock().toISOString();
    const updated: Execution<"executing"> = { ...execution, updated_at: at };
    const failed = execution.outcomes.find((o) => o.status === "failed");
    if (failed) {
      this.deps.store.updateOutbox(execution.idempotency_key, "failed", execution.outcomes, at);
      return this.persist(transition(updated, "failed", { at, actor: this.agentActor, reason: "rail_failed", detail: failed.error ?? "rail refused" }));
    }
    if (execution.outcomes.filter((o) => o.status === "settled").length === attempts) {
      this.deps.store.updateOutbox(execution.idempotency_key, "done", execution.outcomes, at);
      return this.persist(transition(updated, "settled", { at, actor: this.agentActor }));
    }
    return this.leaveUnresolved(updated, `${execution.outcomes.length} of ${attempts} attempt(s) have an outcome`);
  }

  private leaveUnresolved(execution: Execution<"executing">, detail: string): Execution {
    const kept: Execution<"executing"> = { ...execution, reason: "rail_uncertain", detail, updated_at: this.clock().toISOString() };
    this.deps.store.saveExecution(kept);
    this.record("execution.uncertain", execution.id, { detail });
    return kept;
  }

  private async ingestSettlement(execution: Execution, index: number, payment: RailPayment, receiptId: string | null): Promise<void> {
    // The rail's answer is the `commerce.payment.succeeded` event the API publishes (section 4.3), keyed by attempt so a replay is a no-op.
    const appended = this.deps.store.appendEvent({
      run_id: this.deps.runId,
      execution_id: execution.id,
      event_id: `succeeded:${payment.attempt_id}`,
      type: PAYMENT_SUCCEEDED,
      payload: { attempt_id: payment.attempt_id, amount: payment.amount_minor, payee: payment.payee, receipt_id: receiptId, actor: this.agentActor },
      at: this.clock().toISOString(),
    });
    if (appended) this.deps.bundle.event({ ...appended, actor: this.agentActor, item_index: index });
    if (receiptId) {
      const receipt = await this.deps.rail.receipt(receiptId, this.agentActor);
      if (receipt) {
        const path = this.deps.bundle.receipt(receipt);
        this.record("receipt.saved", execution.id, { receipt_id: receiptId, path });
      }
    }
  }

  // ---- section 10: resume and reconcile ---------------------------------

  /**
   * An execution left in `executing` is reconciled, NEVER dispatched. Each
   * attempt without an outcome is looked up on the rail; a recorded settled
   * or failed answer is taken, and anything else (in flight, uncertain,
   * unknown) leaves the execution in `executing` with an `execution.uncertain`
   * event, for a human. "Unknown" is not "never sent": on the real rail a
   * receipt is indexed seconds after settlement (~43 s measured on Celcoin).
   */
  async reconcile(executionId: string): Promise<Execution> {
    const execution = this.mustGet(executionId);
    if (execution.state !== "executing") return execution;
    const payments = this.paymentsFor(execution);
    const outbox = this.deps.store.getOutbox(execution.idempotency_key);
    if (outbox?.status === "pending") {
      return this.leaveUnresolved(execution as Execution<"executing">, "outbox pending: nothing was ever sent; `resume` dispatches it, reconcile does not");
    }

    const outcomes: ItemOutcome[] = [...execution.outcomes];
    let unresolved: string | undefined;
    for (const [index, payment] of payments.entries()) {
      if (outcomes.some((o) => o.index === index)) continue;
      const seen = await this.deps.rail.lookup(payment.attempt_id, payment);
      this.record("rail.reconcile", execution.id, { attempt_id: payment.attempt_id, found: seen ? seen.status : "absent" });
      if (!seen || seen.status === "uncertain" || seen.status === "in_flight") {
        unresolved = `attempt ${payment.attempt_id}: ${seen ? seen.status : "unknown to the rail"}; a human decides, nothing is re-sent`;
        break;
      }
      if (seen.status === "failed") {
        outcomes.push({ index, attempt_id: payment.attempt_id, status: "failed", error: `${seen.code}: ${seen.message}` });
        break;
      }
      outcomes.push({ index, attempt_id: payment.attempt_id, status: "settled", transaction_id: seen.transaction_id, ...(seen.receipt_id ? { receipt_id: seen.receipt_id } : {}) });
      await this.ingestSettlement(execution, index, payment, seen.receipt_id);
    }
    const updated: Execution<"executing"> = { ...(execution as Execution<"executing">), outcomes };
    if (unresolved) return this.leaveUnresolved(updated, unresolved);
    return this.close(updated, payments.length);
  }

  /**
   * `resume` only: dispatches the attempts of an `executing` execution whose
   * outbox row is still `pending`. `pending` flips to `sent` before the first
   * rail call, so a `pending` row proves nothing ever left; anything `sent`
   * goes through `reconcile()` instead and is never re-sent.
   */
  async resumePending(executionId: string): Promise<Execution> {
    const execution = this.mustGet(executionId);
    if (execution.state !== "executing") return execution;
    const outbox = this.deps.store.getOutbox(execution.idempotency_key);
    if (outbox?.status !== "pending") return this.reconcile(executionId);
    this.record("rail.resume", execution.id, { detail: "outbox pending: nothing was ever sent; dispatching once under the same attempt ids" });
    return this.dispatch(execution as Execution<"executing">, this.paymentsFor(execution));
  }

  /** Time-based exits: an open execution past its approval TTL closes as `expired`. */
  expireStale(): Execution[] {
    const now = this.clock();
    const ttl = this.deps.guardrails.approval_ttl_minutes * 60_000;
    const out: Execution[] = [];
    for (const execution of this.deps.store.listExecutions({ state: ["awaiting_approval", "approved"] })) {
      const opened = new Date(execution.updated_at).getTime();
      if (now.getTime() - opened <= ttl) continue;
      out.push(this.persist(transition(execution as Execution<"awaiting_approval">, "expired", { at: now.toISOString(), actor: this.agentActor, reason: "approval_expired", detail: `no decision within ${this.deps.guardrails.approval_ttl_minutes} minutes` })));
    }
    return out;
  }

  /**
   * An event arriving from outside (a trigger, a webhook): deduplicated by
   * id, applied to the ONE attempt it names, and the execution closes only
   * when every attempt has its outcome. `paid` before `created` is fine;
   * `paid` twice settles once.
   */
  ingestExternalEvent(event: { event_id: string; type: string; attempt_id: string; at?: string }): { applied: boolean; reason: string } {
    const row = this.deps.store.listOutbox().find((o) => ((o.payload as { attempts?: string[] }).attempts ?? []).includes(event.attempt_id));
    if (!row) return { applied: false, reason: "unknown attempt" };
    const stored = this.deps.store.appendEvent({ run_id: this.deps.runId, execution_id: row.execution_id, event_id: event.event_id, type: event.type, payload: event, at: event.at ?? this.clock().toISOString() });
    if (!stored) return { applied: false, reason: "duplicate event id" };
    this.deps.bundle.event({ ...stored, actor: this.agentActor });
    const execution = this.mustGet(row.execution_id);
    if (isTerminal(execution.state)) return { applied: false, reason: `execution already ${execution.state}` };
    if (execution.state !== "executing") return { applied: false, reason: `execution is ${execution.state}; the rail event cannot move it` };
    const attempts = (row.payload as { attempts: string[] }).attempts;
    const index = attempts.indexOf(event.attempt_id);
    if (execution.outcomes.some((o) => o.index === index)) return { applied: false, reason: "attempt already has an outcome" };

    let outcome: ItemOutcome;
    if (event.type === PAYMENT_SUCCEEDED) outcome = { index, attempt_id: event.attempt_id, status: "settled" };
    else if (event.type === PAYMENT_FAILED) outcome = { index, attempt_id: event.attempt_id, status: "failed", error: `event ${event.event_id}` };
    else return { applied: false, reason: `event type ${event.type} moves nothing` };

    const closed = this.close({ ...(execution as Execution<"executing">), outcomes: [...execution.outcomes, outcome] }, attempts.length);
    return { applied: true, reason: closed.state === "executing" ? `attempt recorded; ${closed.detail}` : closed.state };
  }

  // ---- reads --------------------------------------------------------------

  get(executionId: string): Execution | undefined {
    return this.deps.store.getExecution(executionId);
  }

  list(filter: { state?: ExecutionState | ExecutionState[] } = {}): Execution[] {
    return this.deps.store.listExecutions({ ...filter, mandate_id: this.deps.mandate.id });
  }

  // ---- helpers ------------------------------------------------------------

  private async mandateGate(): Promise<{ reason: ExecutionReason; detail: string } | undefined> {
    const { mandate } = this.deps;
    const report = await this.deps.status.check(mandate.id);
    if (report.org_paused) return { reason: "org_paused", detail: "the organization paused every mandate (kill switch)" };
    if (report.status === "revoked") return { reason: "mandate_revoked", detail: `mandate ${mandate.id} was revoked` };
    if (report.status === "paused") return { reason: "mandate_paused", detail: `mandate ${mandate.id} is paused` };
    if (report.status === "expired" || mandateExpired(mandate, this.clock())) return { reason: "mandate_expired", detail: `mandate ${mandate.id} expired at ${mandate.expires_at}` };
    return undefined;
  }

  private resolveItem(proposed: ProposedItem): ExecutionItem {
    const known = resolveBeneficiary(this.deps.mandate, proposed.payee);
    const amount = Math.trunc(proposed.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`amount must be a positive integer in minor units, got ${proposed.amount}`);
    return {
      ...(known ? { alias: known.alias } : {}),
      beneficiary: known?.name ?? proposed.payee,
      payee: known?.payee ?? proposed.payee,
      amount,
      currency: this.deps.mandate.currency,
      ...(proposed.description ? { description: proposed.description } : {}),
    };
  }

  private paymentsFor(execution: Execution): RailPayment[] {
    return execution.items.map((item, index) => ({
      attempt_id: `att_${execution.idempotency_key.slice(4)}_${index}`,
      mandate_id: execution.mandate.id,
      amount_minor: item.amount,
      currency: item.currency,
      payee: item.payee,
      purpose: this.deps.mandate.purpose,
      agent_id: this.deps.mandate.agent_id,
      ...(item.description ? { description: item.description } : {}),
      actor: this.agentActor,
    }));
  }

  private withoutApproval(execution: Execution<"approved">): Execution<"approved"> {
    const { approval_id: _stale, ...rest } = execution;
    return rest as Execution<"approved">;
  }

  /** Settled, in flight or awaiting a decision under this mandate inside the cap window, excluding the execution being judged. */
  private committedInWindow(now: Date, excludeId: string): number {
    const start = windowStart(this.deps.mandate, now).getTime();
    return this.list({ state: WINDOW_STATES })
      .filter((e) => e.id !== excludeId && new Date(e.created_at).getTime() >= start)
      .reduce((sum, e) => sum + e.total, 0);
  }

  private knownPayees(): Set<string> {
    const out = new Set<string>();
    for (const e of this.list({ state: "settled" })) for (const i of e.items) out.add(i.payee);
    return out;
  }

  /**
   * What the agent ran ALONE per payee inside the velocity window: mandate-mode
   * executions the allowance approved without a human. A payment a human
   * approved is not fractioning, so it does not count against the threshold.
   */
  private recentByPayee(now: Date, excludeId: string): Map<string, number> {
    const out = new Map<string, number>();
    const hours = this.deps.guardrails.velocity?.window_hours;
    if (!hours) return out;
    const since = now.getTime() - hours * 3_600_000;
    for (const e of this.list({ state: ["approved", "executing", "settled"] })) {
      if (e.id === excludeId || e.mode !== "mandate" || e.escalation !== undefined) continue;
      if (new Date(e.created_at).getTime() < since) continue;
      for (const i of e.items) out.set(i.payee, (out.get(i.payee) ?? 0) + i.amount);
    }
    return out;
  }

  private storeApproval(artifact: ApprovalArtifact): void {
    this.deps.store.saveApproval(artifact);
    this.deps.bundle.approval(artifact);
    this.record("approval.created", artifact.execution_id, { approval_id: artifact.approval_id, approver: artifact.approver, items_hash: artifact.items_hash, escalation: artifact.escalation ?? null });
  }

  private persist<S extends ExecutionState>(execution: Execution<S>): Execution<S> {
    this.deps.store.saveExecution(execution);
    const last = execution.history[execution.history.length - 1];
    if (last) {
      const stored = this.deps.store.appendEvent({ run_id: this.deps.runId, execution_id: execution.id, type: "execution.transition", payload: last, at: last.at });
      if (stored) this.deps.bundle.event({ ...stored, actor: last.actor });
    }
    return execution;
  }

  private record(type: string, executionId: string | null, payload: Record<string, unknown>): void {
    const stored = this.deps.store.appendEvent({ run_id: this.deps.runId, execution_id: executionId, type, payload, at: this.clock().toISOString() });
    if (stored) this.deps.bundle.event({ ...stored, actor: this.agentActor });
  }

  private mustGet(executionId: string): Execution {
    const execution = this.deps.store.getExecution(executionId);
    if (!execution) throw new Error(`unknown execution ${executionId}`);
    return execution;
  }
}
