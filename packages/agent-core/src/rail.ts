/**
 * The payment rail the core dispatches to once an execution is `executing`.
 * Two implementations: the CodeSpar sandbox through the API (needs a
 * `csk_test_` key) and a local stub persisted in state.db for CI and
 * scenarios. Both are idempotent on `attempt_id`: presenting the same
 * attempt again answers the earlier outcome instead of paying twice.
 */
import type { Actor } from "./types.js";

export interface RailPayment {
  attempt_id: string;
  mandate_id: string;
  amount_minor: number;
  currency: string;
  payee: string;
  purpose: string;
  agent_id: string;
  description?: string;
  /** Section 4.5: carried on every call. The API has no wire field for it yet; see OPEN_QUESTIONS. */
  actor: Actor;
}

export type RailOutcome =
  | {
      status: "settled";
      transaction_id: string;
      receipt_id: string | null;
      money_moved: boolean;
      sandbox: boolean;
      raw: unknown;
    }
  | {
      /** The rail answered and refused. Nothing moved. */
      status: "failed";
      code: string;
      message: string;
      raw?: unknown;
    }
  | {
      /** The outcome is unknown (timeout, 5xx, `psp_dispatch_uncertain`). Never retried blind: reconciled. */
      status: "uncertain";
      code: string;
      message: string;
      raw?: unknown;
    };

export interface RailReceipt {
  receipt_id: string;
  state: string;
  mandate: { id: string };
  payment: { amount_minor: number; payee: string | null; attempt_id: string; money_moved: boolean; sandbox: boolean; at: string };
  chain: string;
  receipt_sig: string;
  /** Section 4.5: the kit stamps the actor onto the local copy of every receipt. */
  actor: Actor;
  raw: unknown;
}

/** What a reconcile learns: a recorded outcome, "still running", or nothing. Never a new payment. */
export type RailLookup = RailOutcome | { status: "in_flight" } | undefined;

export interface PaymentRail {
  readonly name: "stub" | "codespar";
  pay(payment: RailPayment): Promise<RailOutcome>;
  /** Answers the outcome of an attempt already presented, `in_flight` while the rail is still on it, or `undefined` when the rail never saw it. */
  lookup(attemptId: string, payment: RailPayment): Promise<RailLookup>;
  receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined>;
}
