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
 * Where a charge that became a platform receive proposal (`rail` is the hosted proposal rail) stands, for what a kit tells
 * the model (v1.5):
 * `person_sends_charge_on_proposal` while a person has not sent it on its card (nothing was charged yet),
 * `payer_pays_charge` once it is out and its payer has not paid. Null for anything else.
 */
export function chargeProposalAwaiting(execution: Execution, rail: Pick<PaymentRail, "name">): "person_sends_charge_on_proposal" | "payer_pays_charge" | null {
  // The engine may approve without a person (mandate mode): the rail, not the approver, says the charge is a platform proposal.
  if (rail.name !== "codespar-proposal" || execution.state !== "executing" || execution.reason !== "awaiting_settlement") return null;
  const open = execution.outcomes.filter((o) => o.status === "accepted");
  if (open.length === 0) return null;
  return open.every((o) => o.instrument?.status === "executing") ? "payer_pays_charge" : "person_sends_charge_on_proposal";
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
    return {
      executionId: executionOfAttempt(this.store, payment.attempt_id),
      attemptId: payment.attempt_id,
      items: [{ payee: payment.payee, beneficiary: payment.beneficiary ?? null, amountMinor: payment.amount_minor, description: payment.description ?? null, dueDate: payment.due_date ?? null }],
      totalMinor: payment.amount_minor,
      currency: payment.currency,
      itemsHash: payment.approval?.items_hash ?? null,
      batchHash: payment.approval?.batch_hash ?? null,
    };
  }
}

/** The execution an attempt belongs to, from the outbox row the engine wrote before dispatching it. */
function executionOfAttempt(store: StateStore, attemptId: string): string {
  const row = store.listOutbox().find((r) => ((r.payload as { attempts?: string[] }).attempts ?? []).includes(attemptId));
  if (!row) throw new Error(`no outbox row holds attempt ${attemptId}`);
  return row.execution_id;
}

/** The charge as the payer meets it, read by the host once the person sent it: absent before. */
export interface ChargeView {
  /** True once the payer can pay it (the Pix copy-and-paste is registered). */
  payable: boolean;
  pixCopyPaste: string | null;
  dueDate: string | null;
}

/**
 * What the host offers a kit whose tool CHARGES (`effect: charge`) on `codespar-test` (CONTRATO v1.5). Each attempt becomes
 * ONE platform receive proposal: drafted here, sent by a verified person on its card ("Enviar cobrança"), issued by the
 * platform as its own charge (a Collect link and its attempt at the provider's sandbox), paid by the payer, and read back.
 * The kit never issues, never holds a client or a key, and never marks anything paid.
 */
export interface ChargeProposalRail {
  /**
   * Drafts the receive proposal of one attempt. Its id is derived by the host from (project, run, attemptId): asking again
   * for the same attempt answers the same proposal and drafts nothing more. `debtor` is the name the payer is charged
   * under; no document travels (the platform asks the payer for what the person did not state).
   */
  submit(request: {
    executionId: string;
    attemptId: string;
    debtor: string;
    amountMinor: number;
    currency: string;
    /** `YYYY-MM-DD`: the charge's due date, part of what the person sends. */
    dueDate: string | null;
    description: string | null;
    itemsHash: string | null;
  }): Promise<{ proposalId: string; state: ProposalState }>;
  read(proposalId: string): Promise<{ state: ProposalState; receiptId: string | null; failureCode: string | null; charge: ChargeView | null }>;
  /**
   * Test only: the platform's Test payer pays the sent charge at the provider's sandbox (a real sandbox payment, not a
   * simulation). Absent: the host has no Test payer, and the run's payer is not simulatable. It never settles anything by
   * itself: the payment arrives the way any payment does, and a later `read` sees it.
   */
  payInTest?(proposalId: string): Promise<{ ok: true; detail: string } | { ok: false; code: string; detail: string }>;
}

/**
 * The `codespar-test` rail of a kit that charges: like `ProposalPaymentRail`, an ordinary `PaymentRail` to the engine, so
 * the last gate, the outbox row and the `beforeDispatch` checkpoint run before `pay`. `pay` drafts ONE receive proposal per
 * attempt and answers `accepted`; `lookup` reads it back:
 *   drafted | awaiting_approval   accepted, not payable: the person has not sent it;
 *   executing                     accepted: sent, the charge is out; payable once the platform has its copy-and-paste;
 *   succeeded                     settled, with the platform's receipt id;
 *   failed | denied               failed (`proposal_failed` / the platform's code, `proposal_denied`): nothing was paid.
 */
export class ProposalChargeRail implements PaymentRail {
  readonly name = "codespar-proposal" as const;

  constructor(
    private readonly charges: ChargeProposalRail,
    private readonly store: StateStore,
  ) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
    try {
      const { proposalId, state } = await this.charges.submit(this.request(payment));
      return this.answer(proposalId, payment, { state, receiptId: null, failureCode: null, charge: null });
    } catch (err) {
      if (isFenced(err)) throw err;
      return { status: "uncertain", code: "proposal_submit_unknown", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async lookup(_attemptId: string, payment: RailPayment, transactionId?: string): Promise<RailLookup> {
    const proposalId = transactionId ?? (await this.charges.submit(this.request(payment))).proposalId;
    return this.answer(proposalId, payment, await this.charges.read(proposalId));
  }

  async receipt(): Promise<RailReceipt | undefined> {
    return undefined;
  }

  private answer(proposalId: string, payment: RailPayment, read: Awaited<ReturnType<ChargeProposalRail["read"]>>): RailOutcome {
    switch (read.state) {
      case "succeeded":
        return { status: "settled", transaction_id: proposalId, receipt_id: read.receiptId, money_moved: false, sandbox: true, raw: { proposal: proposalId } };
      case "failed":
        return { status: "failed", code: read.failureCode ?? "proposal_failed", message: `the platform's charge of proposal ${proposalId} failed; nothing was paid`, raw: { proposal: proposalId } };
      case "denied":
        return { status: "failed", code: "proposal_denied", message: `charge proposal ${proposalId} was declined or withdrawn; nothing was paid`, raw: { proposal: proposalId } };
      default: {
        const sent = read.state === "executing";
        const charge = sent ? read.charge : null;
        return {
          status: "accepted",
          transaction_id: proposalId,
          instrument: { payable: charge?.payable === true, pix_copy_paste: charge?.pixCopyPaste ?? null, boleto_bank_line: null, boleto_bar_code: null, due_date: charge?.dueDate ?? payment.due_date ?? null, status: read.state },
          sandbox: true,
          raw: { proposal: proposalId },
        };
      }
    }
  }

  private request(payment: RailPayment): Parameters<ChargeProposalRail["submit"]>[0] {
    return {
      executionId: executionOfAttempt(this.store, payment.attempt_id),
      attemptId: payment.attempt_id,
      // The name the engine resolved for the payee; never the payee itself, which for a charge is the debtor's document.
      debtor: payment.beneficiary ?? "",
      amountMinor: payment.amount_minor,
      currency: payment.currency,
      dueDate: payment.due_date ?? null,
      description: payment.description ?? null,
      itemsHash: payment.approval?.items_hash ?? null,
    };
  }
}
