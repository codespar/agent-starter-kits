/**
 * The `codespar-test` executor of a pull kit (CONTRATO.md v1.7): the kit's
 * attempt becomes a pull the platform asks the person's own bank for, under
 * the consent the person gave at that bank (Pix com biometria, Iniciador's
 * sandbox in Test). The person signs each pull on the bank's page; the kit
 * never sees that page, a credential or the provider.
 *
 * To the engine this is a rail like any other, as `ProposalPaymentRail` is:
 * the last gate, the outbox row and the `beforeDispatch` checkpoint all run
 * before `pay`. `pay` asks the host to send ONE pull for the attempt and
 * answers `accepted`: the pull waits for the person's signature. `lookup`
 * reads it back. The host derives the pull's idempotency from (project, run,
 * attemptId), so asking again for the same attempt answers the same pull and
 * never sends a second one.
 *
 * What the kit keeps of a pull is its id and status. The signing page carries
 * a credential of its own, so it is never in an outcome, an event or the run
 * image: the host hands it to the run's actor when they open it.
 */
import type { ChargeInstrument, PaymentRail, RailLookup, RailOutcome, RailPayment, RailReceipt, StateStore } from "@codespar/agent-core";
import { isFenced } from "./proposals.js";

/** The platform's pull states (the sweeping vocabulary the platform reads JSR payments into). Only `completed` is money moved. */
export type PullState = "pending" | "settling" | "completed" | "rejected" | "canceled" | "unknown";

export interface PullRead {
  state: PullState;
  /** The Pix end-to-end id, once the bank assigned one. Assigned at create: only `completed` makes it evidence. */
  endToEndId: string | null;
  /** The platform's or the bank's code on a pull that did not complete. */
  code: string | null;
  /** A pull whose outcome a person has to check at the bank (an answer that was lost, a pull bound elsewhere). */
  needsHuman: boolean;
  /** The person did not sign in time: nothing moved, and the pull is never sent again. */
  signatureTimedOut: boolean;
}

/** What the host offers a pull kit on `codespar-test`. Both calls are the host's; neither holds a provider client in the kit. */
export interface PullRail {
  /**
   * Sends the pull of one attempt, under the run's consent, to the mandate's one payee. Asking again for the same attempt
   * answers the same pull. `ok: false` is a refusal before anything was sent (no consent, a limit, another payee).
   */
  submit(request: { executionId: string; attemptId: string; payee: string; amountMinor: number; currency: string; description: string | null }): Promise<
    { ok: true; pullId: string; state: PullState } | { ok: false; code: string; message: string }
  >;
  read(pullId: string): Promise<PullRead>;
}

export class PlatformPullRail implements PaymentRail {
  readonly name = "codespar-pull" as const;

  constructor(
    private readonly pulls: PullRail,
    private readonly store: StateStore,
  ) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
    let answer: Awaited<ReturnType<PullRail["submit"]>>;
    try {
      answer = await this.pulls.submit(this.request(payment));
    } catch (err) {
      // A fence is not an unknown answer: the process stops, and the new owner looks at the attempt.
      if (isFenced(err)) throw err;
      // Whether the host sent it is unknown; a look submits again under the same attempt, which never sends twice.
      return { status: "uncertain", code: "pull_submit_unknown", message: err instanceof Error ? err.message : String(err) };
    }
    if (!answer.ok) return { status: "failed", code: answer.code, message: `${answer.message}; nothing was sent to the bank` };
    return this.answer(answer.pullId, { state: answer.state, endToEndId: null, code: null, needsHuman: false, signatureTimedOut: false });
  }

  async lookup(_attemptId: string, payment: RailPayment, transactionId?: string): Promise<RailLookup> {
    let pullId = transactionId;
    if (!pullId) {
      // A submit whose answer was lost: the same attempt again. The host answers the pull it already sent, never a new one.
      const again = await this.pulls.submit(this.request(payment));
      if (!again.ok) return { status: "failed", code: again.code, message: `${again.message}; nothing was sent to the bank` };
      pullId = again.pullId;
    }
    return this.answer(pullId, await this.pulls.read(pullId));
  }

  /** The record of a pull is the platform's (its id and the end-to-end id at the banks). Nothing is sealed for it here. */
  async receipt(): Promise<RailReceipt | undefined> {
    return undefined;
  }

  private answer(pullId: string, read: PullRead): RailOutcome {
    const raw = { pull: pullId, end_to_end_id: read.endToEndId, code: read.code };
    switch (read.state) {
      case "completed":
        // The end-to-end id is what the person and the banks can look up; the pull id is the platform's.
        return { status: "settled", transaction_id: read.endToEndId ?? pullId, receipt_id: pullId, money_moved: false, sandbox: true, raw };
      case "rejected":
        if (read.signatureTimedOut) return { status: "failed", code: "charge_expired", message: `pull ${pullId} was not signed in time at the bank; nothing moved`, raw };
        return { status: "failed", code: "charge_cancelled", message: `the bank refused pull ${pullId}${read.code ? ` (${read.code})` : ""}; nothing moved`, raw };
      case "canceled":
        return { status: "failed", code: "charge_issuer_error", message: `pull ${pullId} was refused before it reached the bank${read.code ? ` (${read.code})` : ""}`, raw };
      case "unknown":
        return {
          status: "uncertain",
          code: read.code ?? "pull_unknown",
          message: `the outcome of pull ${pullId} is not known; it is never sent again${read.needsHuman ? ": a person checks it at the bank" : ""}`,
          ...(read.needsHuman ? { needs_human: true as const } : {}),
          raw,
        };
      default:
        return { status: "accepted", transaction_id: pullId, instrument: waiting(read.state), sandbox: true, raw };
    }
  }

  private request(payment: RailPayment): Parameters<PullRail["submit"]>[0] {
    const row = this.store.listOutbox().find((r) => ((r.payload as { attempts?: string[] }).attempts ?? []).includes(payment.attempt_id));
    if (!row) throw new Error(`no outbox row holds attempt ${payment.attempt_id}`);
    return { executionId: row.execution_id, attemptId: payment.attempt_id, payee: payment.payee, amountMinor: payment.amount_minor, currency: payment.currency, description: payment.description ?? null };
  }
}

/** A pull that waits for the person: payable at their bank, with no link here (the host serves the signing page on demand). */
function waiting(state: PullState): ChargeInstrument {
  return { payable: true, pix_copy_paste: null, boleto_bank_line: null, boleto_bar_code: null, due_date: null, consent_url: null, status: state };
}
