/**
 * STUB rail. A deterministic stand-in for the CodeSpar sandbox so the
 * scenarios, the adversarial suite and the restart test run offline. Every
 * attempt is persisted in state.db before the outcome is returned, which is
 * what lets a process killed right after "the money left" be reconciled on
 * `resume` instead of paying again. Receipts here are HMAC-shaped only in
 * form; nothing about them is verifiable by anyone.
 */
import { sha256Hex } from "../hash.js";
import type { PaymentRail, RailOutcome, RailPayment, RailReceipt } from "../rail.js";
import type { StateStore } from "../state/store.js";
import type { Actor } from "../types.js";

export interface StubRailOptions {
  clock?: () => Date;
  /** Payees the stub refuses, to script a `failed` outcome. */
  refusePayees?: string[];
  /** Attempt ids the stub answers `uncertain` for, once. */
  uncertainOnce?: string[];
  /** Test hook: called after the attempt is persisted and before the outcome is returned. */
  afterDispatch?: (attemptId: string) => void;
}

export class StubRail implements PaymentRail {
  readonly name = "stub" as const;
  private readonly clock: () => Date;
  private readonly uncertainPending: Set<string>;

  constructor(
    private readonly store: StateStore,
    private readonly options: StubRailOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.uncertainPending = new Set(options.uncertainOnce ?? []);
  }

  private uncertainArmed = false;

  /** The NEXT new attempt answers `uncertain` once, whatever its id. For scenarios that reconcile. */
  armUncertainOnce(): void {
    this.uncertainArmed = true;
  }

  async pay(payment: RailPayment): Promise<RailOutcome> {
    const existing = this.store.stubRailGet(payment.attempt_id);
    if (existing) return existing.outcome as RailOutcome;

    if (this.uncertainArmed || this.uncertainPending.has(payment.attempt_id)) {
      this.uncertainArmed = false;
      this.uncertainPending.delete(payment.attempt_id);
      return { status: "uncertain", code: "psp_dispatch_uncertain", message: "stub: outcome unknown on first presentation" };
    }

    const at = this.clock().toISOString();
    const outcome: RailOutcome = this.options.refusePayees?.includes(payment.payee)
      ? { status: "failed", code: "psp_dispatch_failed", message: `stub: provider refused payee ${payment.payee}` }
      : {
          status: "settled",
          transaction_id: `stubtx_${sha256Hex(payment.attempt_id).slice(0, 16)}`,
          receipt_id: `rcpt_stub_${sha256Hex(`receipt:${payment.attempt_id}`).slice(0, 16)}`,
          money_moved: false,
          sandbox: true,
          raw: { stub: true, attempt_id: payment.attempt_id, at },
        };
    const { actor: _actor, ...request } = payment;
    this.store.stubRailPut(payment.attempt_id, request, outcome, at);
    this.options.afterDispatch?.(payment.attempt_id);
    return outcome;
  }

  async lookup(attemptId: string): Promise<RailOutcome | undefined> {
    return this.store.stubRailGet(attemptId)?.outcome as RailOutcome | undefined;
  }

  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    const sealed = this.store.stubRailFindByReceipt(receiptId);
    if (!sealed) return undefined;
    const req = sealed.request as Omit<RailPayment, "actor">;
    const out = sealed.outcome as Extract<RailOutcome, { status: "settled" }>;
    const body = {
      receipt_id: receiptId,
      state: "paid",
      mandate: { id: req.mandate_id },
      payment: { amount_minor: req.amount_minor, payee: req.payee, attempt_id: req.attempt_id, money_moved: false, sandbox: true, at: sealed.at },
    };
    const chain = `sha256:${sha256Hex(JSON.stringify(body))}`;
    return {
      ...body,
      chain,
      receipt_sig: `stub:${sha256Hex(`sig:${chain}`).slice(0, 32)}`,
      actor,
      raw: { stub: true, transaction_id: out.transaction_id },
    };
  }
}
