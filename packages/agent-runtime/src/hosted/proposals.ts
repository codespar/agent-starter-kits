/**
 * The `codespar-test` executor (CONTRATO.md v1.1): the kit's attempt becomes
 * a platform payment proposal, and the platform is the only thing that pays.
 *
 * To the engine this is a rail like any other, which is the point: the last
 * gate, the outbox row and the `beforeDispatch` checkpoint all run before
 * `pay`, exactly as before a real payout. What `pay` does is draft ONE
 * proposal for the attempt through the host's port, and answer `accepted`:
 * the attempt is out, and somebody else acts on it. That somebody is a
 * verified person paying it (`POST /v1/proposals/:id/pay`), or Aprovações
 * when the platform's policy parks it. `lookup` reads the proposal back and
 * answers what it became. The kit holds no client, no key and no way to pay.
 */
import type { ChargeInstrument, Execution, PaymentRail, RailLookup, RailOutcome, RailPayment, RailReceipt, StateStore } from "@codespar/agent-core";

/** The approver channel of a kit approval the hosted run forwarded to a platform proposal: it approves the draft, never the payment. */
export const PROPOSAL_FORWARD_CHANNEL = "platform-proposal";

/** Whether the kit's approval of `execution` was a forward to a platform proposal (`codespar-test`), not a person's or the mandate's decision. */
export function forwardedToProposal(execution: Execution): boolean {
  return execution.history.some((h) => h.to === "approved" && h.actor.type === "human" && h.actor.channel === PROPOSAL_FORWARD_CHANNEL);
}

/**
 * A payment that became a platform proposal and waits for a person to decide it (pay or decline, on its card). Nothing is
 * approved or paid while this holds; a kit tells the model so instead of a state that reads as "approved, settling".
 */
export function awaitingProposalDecision(execution: Execution): boolean {
  return execution.state === "executing" && execution.reason === "awaiting_settlement" && forwardedToProposal(execution);
}

/**
 * The host's refusal of a process that no longer holds the run: another one took the lease (`lease_lost`), or the host fenced
 * this epoch (`fenced`). Thrown by `ProposalRail` (and by `StatePort.save`, or answered as its `reason`). A run that meets it
 * stops at once: no retry, no further event, no further effect. Only the new owner continues.
 */
export class FencedError extends Error {
  readonly code = "fenced";
  constructor(readonly reason: "lease_lost" | "fenced" = "fenced") {
    super(`fenced: ${reason}; this process no longer owns the run`);
    this.name = "FencedError";
  }
}

/** A fence from the host, whichever copy of this module raised it. */
export function isFenced(err: unknown): err is { reason?: string } {
  return err instanceof FencedError || (err instanceof Error && (err.name === "FencedError" || (err as { code?: unknown }).code === "fenced"));
}

export type ProposalState = "drafted" | "awaiting_approval" | "executing" | "succeeded" | "failed" | "denied";

/** What the host offers for `codespar-test`. Both calls are the host's; neither pays. */
export interface ProposalRail {
  /**
   * Drafts the proposal of one attempt. Its id is derived by the host from
   * (project, run, attemptId): asking again for the same attempt answers the
   * same proposal and drafts nothing more.
   */
  submit(request: {
    executionId: string;
    attemptId: string;
    items: Array<{ payee: string; beneficiary: string | null; amountMinor: number; description: string | null; dueDate: string | null }>;
    totalMinor: number;
    currency: string;
    /** The hashes the kit's approval artifact carries for this attempt, so the host can bind the proposal to what the kit approved. */
    itemsHash: string | null;
    batchHash: string | null;
  }): Promise<{ proposalId: string; state: ProposalState }>;
  read(proposalId: string): Promise<{ state: ProposalState; receiptId: string | null; failureCode: string | null }>;
}

/** The proposal's state, carried where a receivable's instrument goes: the core records each observed state once. */
function waiting(state: ProposalState): ChargeInstrument {
  return { payable: false, pix_copy_paste: null, boleto_bank_line: null, boleto_bar_code: null, due_date: null, status: state };
}

export class ProposalPaymentRail implements PaymentRail {
  readonly name = "codespar-proposal" as const;

  constructor(
    private readonly proposals: ProposalRail,
    private readonly store: StateStore,
  ) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
    try {
      const { proposalId, state } = await this.proposals.submit(this.request(payment));
      return this.answer(proposalId, { state, receiptId: null, failureCode: null });
    } catch (err) {
      // A fence is not an unknown answer: the process stops, and the new owner looks at the attempt.
      if (isFenced(err)) throw err;
      // Whether the host drafted it is unknown; a look submits again under the same attempt, which drafts nothing twice.
      return { status: "uncertain", code: "proposal_submit_unknown", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async lookup(_attemptId: string, payment: RailPayment, transactionId?: string): Promise<RailLookup> {
    // Without the id (a submit whose answer was lost), the same attempt is submitted again: the host answers the proposal it
    // already drafted for that attempt, never a new one.
    const proposalId = transactionId ?? (await this.proposals.submit(this.request(payment))).proposalId;
    return this.answer(proposalId, await this.proposals.read(proposalId));
  }

  /** The platform's receipt is read by the host, which holds the client. The kit records its id and nothing else. */
  async receipt(): Promise<RailReceipt | undefined> {
    return undefined;
  }

  private answer(proposalId: string, read: { state: ProposalState; receiptId: string | null; failureCode: string | null }): RailOutcome {
    switch (read.state) {
      case "succeeded":
        return { status: "settled", transaction_id: proposalId, receipt_id: read.receiptId, money_moved: false, sandbox: true, raw: { proposal: proposalId } };
      case "failed":
        return { status: "failed", code: read.failureCode ?? "proposal_failed", message: `the platform's payment of proposal ${proposalId} failed`, raw: { proposal: proposalId } };
      // The kit's execution has no edge from `executing` to `denied`: once out, it ends settled or failed. A refused proposal is a failure that moved nothing.
      case "denied":
        return { status: "failed", code: "proposal_denied", message: `proposal ${proposalId} was refused (Aprovações or the person); nothing was paid`, raw: { proposal: proposalId } };
      default:
        return { status: "accepted", transaction_id: proposalId, instrument: waiting(read.state), sandbox: true, raw: { proposal: proposalId } };
    }
  }

  private request(payment: RailPayment): Parameters<ProposalRail["submit"]>[0] {
    const row = this.store.listOutbox().find((r) => ((r.payload as { attempts?: string[] }).attempts ?? []).includes(payment.attempt_id));
    if (!row) throw new Error(`no outbox row holds attempt ${payment.attempt_id}`);
    return {
      executionId: row.execution_id,
      attemptId: payment.attempt_id,
      items: [{ payee: payment.payee, beneficiary: payment.beneficiary ?? null, amountMinor: payment.amount_minor, description: payment.description ?? null, dueDate: payment.due_date ?? null }],
      totalMinor: payment.amount_minor,
      currency: payment.currency,
      itemsHash: payment.approval?.items_hash ?? null,
      batchHash: payment.approval?.batch_hash ?? null,
    };
  }
}
