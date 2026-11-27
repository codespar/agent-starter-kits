/**
 * The `codespar-test` executor of a kit that tops up the person's own account (CONTRATO v1.8, decision D2 of 27/11):
 * the kit's attempt becomes an offer of the PLATFORM's top-up, the same public action any client reaches
 * (`codespar_wallet` action `top_up`), and the platform's own record of the pull the person then makes is the evidence.
 *
 * What the platform's top-up is, and why the kit never pulls. `codespar_wallet top_up` moves no money and starts nothing:
 * it answers the dashboard page where the person opens the top-up (the Wallet's card: Open Finance sweeping under the
 * person's consent, or a Pix with their biometrics) and confirms it at their bank. The pull itself is the person's act,
 * through the routes no agent reaches (decision D4 of the platform, routes/ofb-sweeping-pulls.ts). So, to the engine, this
 * is a receivable like any other (`settlement: await-payer`): `pay` asks the host for the offer and answers `accepted`
 * with the page as the instrument's `consent_url`; `lookup` asks the host what the platform recorded since:
 *
 *   awaiting_person   accepted: nothing was started; the person has not made the top-up yet;
 *   in_progress       accepted: the person made it and the bank has not finished it;
 *   completed         settled, with the platform record's id as the receipt id (evidence `rail_record`);
 *   refused           failed, with the platform's code: the platform RECORDED that nothing could be pulled (the bank
 *                     refused it, it expired, or no send went out). Only this lets the kit offer another top-up;
 *   uncertain         uncertain: the platform holds a record whose outcome is unknown, or cannot tell which record is
 *                     this attempt's. Never failed: nothing is offered again while it holds (D4), and the same attempt
 *                     keeps the same top-up id, so asking again is the same offer.
 *
 * The kit holds no client, no key and no way to pull. The host derives the top-up id from (project, run, attempt).
 */
import type { PaymentRail, RailLookup, RailOutcome, RailPayment, RailReceipt, StateStore } from "@codespar/agent-core";
import { isFenced } from "./proposals.js";

export type TopUpState = "awaiting_person" | "in_progress" | "completed" | "refused" | "uncertain";

/** What the platform holds for one top-up offer, as the host reads it. */
export interface TopUpRead {
  state: TopUpState;
  /** The platform's own record of the pull (its id), once the host found the one this attempt's offer became; null before. */
  recordId: string | null;
  /** The Pix end-to-end id of a completed pull, when the platform holds one. */
  endToEndId: string | null;
  /** The platform's code for a refused or uncertain record (verbatim), or null. */
  code: string | null;
  detail: string | null;
  /** Where the person opens the top-up: the dashboard page (absolute when the host knows its origin). Not a credential. */
  topUpUrl: string | null;
}

/** What the host offers a kit whose codespar-test executor requires `platform.top_ups`. Neither call pulls. */
export interface TopUpRail {
  /**
   * The platform's top-up offer for one attempt (`codespar_wallet` action `top_up`, the public action). Its id is derived
   * by the host from (project, run, attemptId): asking again for the same attempt answers the same offer and its current
   * read, and offers nothing more. `refused` with a code when the platform refuses to offer it (nothing was started).
   */
  submit(request: { executionId: string; attemptId: string; amountMinor: number; currency: string; description: string | null }): Promise<{ topUpId: string } & TopUpRead>;
  read(topUpId: string): Promise<TopUpRead>;
}

/** The kit's own codes on this rail. A platform code, when there is one, travels verbatim instead. */
export const TOP_UP_RAIL_CODES = {
  /** The host's answer to the offer never came back: whether it was offered is unknown; a look asks again under the same attempt. */
  top_up_submit_unknown: "top_up_submit_unknown",
  /** The platform recorded that nothing could be pulled, and gave no code of its own. */
  top_up_refused: "top_up_refused",
  /** The platform holds a record whose outcome is unknown, or cannot tell which record is this attempt's, and gave no code. */
  top_up_unresolved: "top_up_unresolved",
} as const;

/** The instrument of an offer: no Pix, no boleto; the page where the person opens and confirms the top-up. */
function offered(read: TopUpRead) {
  return { payable: false, pix_copy_paste: null, boleto_bank_line: null, boleto_bar_code: null, due_date: null, status: read.state, consent_url: read.topUpUrl };
}

export class PlatformTopUpRail implements PaymentRail {
  readonly name = "codespar-topup" as const;

  constructor(
    private readonly topups: TopUpRail,
    private readonly store: StateStore,
  ) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
    try {
      const { topUpId, ...read } = await this.topups.submit(this.request(payment));
      return this.answer(topUpId, read);
    } catch (err) {
      if (isFenced(err)) throw err;
      return { status: "uncertain", code: TOP_UP_RAIL_CODES.top_up_submit_unknown, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async lookup(_attemptId: string, payment: RailPayment, transactionId?: string): Promise<RailLookup> {
    // Without the id (an offer whose answer was lost), the same attempt is offered again: the same id, nothing new.
    if (!transactionId) {
      const { topUpId, ...read } = await this.topups.submit(this.request(payment));
      return this.answer(topUpId, read);
    }
    return this.answer(transactionId, await this.topups.read(transactionId));
  }

  /** The platform's record is read by the host. The kit records its id and seals nothing: no CodeSpar receipt exists for a pull. */
  async receipt(): Promise<RailReceipt | undefined> {
    return undefined;
  }

  private answer(topUpId: string, read: TopUpRead): RailOutcome {
    switch (read.state) {
      case "completed":
        // The person's pull moved the money, not this kit: `money_moved` is the kit's own claim, and it claims none.
        return { status: "settled", transaction_id: read.endToEndId ?? read.recordId ?? topUpId, receipt_id: read.recordId, money_moved: false, sandbox: true, raw: { top_up: topUpId, record: read.recordId } };
      case "refused":
        return {
          status: "failed",
          code: read.code ?? TOP_UP_RAIL_CODES.top_up_refused,
          message: `${read.detail ?? "the platform recorded that nothing could be pulled"} (top-up ${topUpId}${read.recordId ? `, record ${read.recordId}` : ""}); nothing was pulled`,
          raw: { top_up: topUpId, record: read.recordId },
        };
      case "uncertain":
        return {
          status: "uncertain",
          code: read.code ?? TOP_UP_RAIL_CODES.top_up_unresolved,
          message: `${read.detail ?? "the platform's record of this top-up has no definite outcome"} (top-up ${topUpId}${read.recordId ? `, record ${read.recordId}` : ""}); no other top-up is offered while it holds`,
          raw: { top_up: topUpId, record: read.recordId },
        };
      default:
        return { status: "accepted", transaction_id: topUpId, instrument: offered(read), sandbox: true, raw: { top_up: topUpId, record: read.recordId } };
    }
  }

  private request(payment: RailPayment): Parameters<TopUpRail["submit"]>[0] {
    return {
      executionId: executionOfAttempt(this.store, payment.attempt_id),
      attemptId: payment.attempt_id,
      amountMinor: payment.amount_minor,
      currency: payment.currency,
      description: payment.description ?? null,
    };
  }
}

/** The execution an attempt belongs to, from the outbox row the engine wrote before dispatching it. */
function executionOfAttempt(store: StateStore, attemptId: string): string {
  const row = store.listOutbox().find((r) => ((r.payload as { attempts?: string[] }).attempts ?? []).includes(attemptId));
  if (!row) throw new Error(`no outbox row holds attempt ${attemptId}`);
  return row.execution_id;
}
