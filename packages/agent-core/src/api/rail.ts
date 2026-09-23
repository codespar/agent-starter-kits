/**
 * The CodeSpar sandbox rail. Spends by mandate id through
 * `POST /v1/consumers/mandates/{id}/spend`, idempotent on `attempt_id`, and
 * reads the sealed receipt back from `GET /v1/consumers/receipts/{id}`.
 *
 * The API has no `actor` field on the wire today (OPEN_QUESTIONS). The
 * spend carries `agent_id`, which the mandate binds; the full actor is
 * stamped on the local receipt copy and on every event of the bundle.
 */
import type { ApiClient } from "@codespar/sdk";
import type { PaymentRail, RailOutcome, RailPayment, RailReceipt } from "../rail.js";
import type { Actor } from "../types.js";
import { describeApiError, isUncertain } from "./client.js";

export class CodeSparRail implements PaymentRail {
  readonly name = "codespar" as const;

  constructor(private readonly api: ApiClient) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
    try {
      const outcome = await this.api.post("/v1/consumers/mandates/{id}/spend", {
        path: { id: payment.mandate_id },
        body: {
          amount_minor: payment.amount_minor,
          payee: payment.payee,
          agent_id: payment.agent_id,
          attempt_id: payment.attempt_id,
        },
      });
      return {
        status: "settled",
        transaction_id: outcome.payment.transactionId,
        receipt_id: outcome.receipt?.id ?? null,
        money_moved: outcome.payment.moneyMoved,
        sandbox: !outcome.payment.moneyMoved,
        raw: outcome,
      };
    } catch (err) {
      const failure = describeApiError(err);
      if (isUncertain(failure)) return { status: "uncertain", code: failure.code, message: failure.message };
      return { status: "failed", code: failure.code, message: failure.message };
    }
  }

  /**
   * There is no read route for an attempt. The documented way is to present
   * the same `attempt_id` again: the lifecycle is idempotent on it and
   * answers the state it reached. `psp_attempt_in_flight` means the first
   * presentation is still running.
   */
  async lookup(_attemptId: string, payment: RailPayment): Promise<RailOutcome | undefined> {
    const outcome = await this.pay(payment);
    if (outcome.status === "failed" && outcome.code === "psp_attempt_in_flight") return undefined;
    return outcome;
  }

  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    try {
      const r = await this.api.get("/v1/consumers/receipts/{id}", { path: { id: receiptId } });
      return {
        receipt_id: r.receipt_id,
        state: r.state,
        mandate: { id: r.mandate.id },
        payment: {
          amount_minor: r.payment.amount_minor,
          payee: r.quote?.payee ?? null,
          attempt_id: r.payment.attempt_id,
          money_moved: r.payment.money_moved,
          sandbox: r.payment.sandbox === true,
          at: r.payment.at,
        },
        chain: r.chain,
        receipt_sig: r.receipt_sig,
        actor,
        raw: r,
      };
    } catch (err) {
      const failure = describeApiError(err);
      if (failure.status === 404) return undefined;
      throw err;
    }
  }
}
