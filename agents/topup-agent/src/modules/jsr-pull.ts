/**
 * Module `jsr-pull`: the same top-up as `sweeping-pull`, through Iniciador's
 * JSR (Pix with a passkey) instead of a sweeping mandate at the bank. The
 * person is present for every pull: they sign each payment with their
 * phone's biometrics on Iniciador's hosted page. The core sees a receivable,
 * as with sweeping.
 *
 * One attempt, up to two pages for the person, both from this rail:
 *   1. `enroll`, only when the person has no COMPLETED enrollment at the bank
 *      yet: the hosted page where they register a passkey. Its link expires
 *      about a minute after it is made, so it is made by `pay()`, the moment
 *      the approved execution is dispatched, while the person is in the chat.
 *   2. `sign`: the payment, created once the enrollment is COMPLETED, and the
 *      hosted page where the person approves it with the passkey. About ten
 *      minutes, then the bank ends it REJECTED (`TIMEOUT_CONSENTIMENTO`).
 * Each is a `consent_step` of the instrument, so the channel shows each once.
 *
 * The payment request goes out at most once: its marker is written to
 * state.db BEFORE the request, and a lost answer is uncertain, never retried
 * (AGENTS.md, rule 7). An enrollment moves no money; one nobody completed
 * ends REJECTED on its own.
 *
 * Nothing in this file decides money. The amount, the payee and the caps
 * were checked by `ExecutionEngine` before `pay()`; the rail refuses a payee
 * that is not the configured creditor and an amount above the limit per pull
 * all the same.
 */
import { sha256Hex, type Actor, type ChargeInstrument, type PaymentRail, type RailLookup, type RailOutcome, type RailPayment, type RailReceipt, type StateStore } from "@codespar/agent-core";
import { IniciadorError } from "../iniciador.js";
import type { Creditor, DeviceContext, EnrollmentRequest, EnrollmentView, JsrApi, JsrPaymentRequest, JsrPaymentView } from "../iniciador-mcp.js";
import type { SweepingLimits } from "./sweeping-pull.js";

export interface JsrRailConfig {
  /** The mandate's payee id for the creditor: `creditorPayeeId(creditor)`. */
  payee: string;
  creditor: Creditor;
  participantId: string;
  /** The person's CPF. Never logged, never in a message. */
  taxId: string;
  userName: string;
  limits: SweepingLimits;
  deviceContext: DeviceContext;
  /**
   * Register a new passkey even when a COMPLETED enrollment exists. The MCP binds a payment to the most
   * recent COMPLETED enrollment, so the new one is the one the person signs with.
   */
  alwaysEnroll?: boolean;
  clock?: () => Date;
}

/**
 * The mandate's id for the creditor account: a digest, so the account
 * number never sits in a mandate snapshot, an event or a record.
 */
export function creditorPayeeId(creditor: Creditor): string {
  return `creditor-jsr-${sha256Hex([creditor.ispb, creditor.issuer, creditor.number, creditor.accountType, creditor.taxId].join("|")).slice(0, 12)}`;
}

/** Fixed device fields for `create_authorization`, the same values as the sweeping rail's riskSignals. */
export const DEVICE_CONTEXT: DeviceContext = { osVersion: "6.8.0", userTimeZoneOffset: "-03", language: "pt", screenDimensions: { width: 1920, height: 1080 }, accountTenure: "2026-10-21" };

const AGENT_REASON = "Recarga da sua conta CodeSpar";

/** Ids and statuses only. The hosted links are kept to show the person again on a restart, never logged. */
interface JsrRecord {
  amount_minor: number;
  payee: string;
  mandate_id: string;
  created_at: string;
  enrollment?: { id: string; url: string | null; reused: boolean };
  /** Written BEFORE the payment request goes out; `id` once it answered; `lost_at` when it got no clear answer. */
  payment?: { requested_at: string; id?: string; url?: string | null; end_to_end_id?: string | null; lost_at?: string };
  final?: RailOutcome;
}

const RECORD = (attemptId: string) => `jsr:${attemptId}`;
const RECEIPT = (paymentId: string) => `jsr-receipt:${paymentId}`;
/** How long a payment marker with no id is read as another reader's request still on its way. */
const IN_FLIGHT_MS = 60_000;

export class JsrPullRail implements PaymentRail {
  readonly name = "iniciador-jsr" as const;
  private readonly clock: () => Date;

  constructor(
    private readonly store: StateStore,
    private readonly api: JsrApi,
    private readonly config: JsrRailConfig,
    private readonly sandbox: boolean,
  ) {
    this.clock = config.clock ?? (() => new Date());
  }

  async pay(payment: RailPayment): Promise<RailOutcome> {
    const existing = this.load(payment.attempt_id);
    if (existing?.final) return existing.final;
    if (existing) {
      const seen = await this.lookup(payment.attempt_id, payment);
      return seen && seen.status !== "in_flight" ? seen : { status: "uncertain", code: "pull_in_flight", message: "a request for this attempt is still on its way" };
    }
    if (payment.payee !== this.config.payee) return { status: "failed", code: "creditor_mismatch", message: "the payee is not the creditor this agent is configured for; nothing was sent" };
    if (payment.amount_minor > this.config.limits.per_tx_minor) {
      return { status: "failed", code: "above_transaction_limit", message: `amount above the limit per pull (${this.config.limits.per_tx_minor}); nothing was sent` };
    }
    const record: JsrRecord = { amount_minor: payment.amount_minor, payee: payment.payee, mandate_id: payment.mandate_id, created_at: this.clock().toISOString() };
    let enrollment: EnrollmentView | null;
    try {
      enrollment = this.config.alwaysEnroll ? null : await this.api.completedEnrollment(this.config.taxId, this.config.participantId);
      if (!enrollment) {
        const request: EnrollmentRequest = { externalId: payment.attempt_id, participantId: this.config.participantId, taxId: this.config.taxId, userName: this.config.userName, agentReason: AGENT_REASON, deviceContext: this.config.deviceContext };
        const created = await this.api.createEnrollment(request);
        record.enrollment = { id: created.authorizationId, url: created.url, reused: false };
        this.save(payment.attempt_id, record);
        return this.awaitingEnrollment(record, created.status);
      }
    } catch (e) {
      // Nothing that moves money was asked for: a refusal ends the attempt, no answer leaves it for the next try.
      if (e instanceof IniciadorError && !e.uncertain) return { status: "failed", code: "charge_issuer_error", message: `the enrollment was refused: ${e.message}` };
      return { status: "uncertain", code: "enrollment_unconfirmed", message: `the enrollment got no clear answer: ${messageOf(e)}` };
    }
    record.enrollment = { id: enrollment.authorizationId, url: null, reused: true };
    this.save(payment.attempt_id, record);
    return this.requestPayment(payment.attempt_id, payment);
  }

  async lookup(attemptId: string, payment: RailPayment): Promise<RailLookup> {
    const record = this.load(attemptId);
    if (!record) return undefined;
    if (record.final) return record.final;
    if (!record.enrollment) return { status: "uncertain", code: "enrollment_unconfirmed", message: "the attempt has no enrollment on record" };

    if (!record.payment) {
      let seen: EnrollmentView;
      try {
        seen = await this.api.getEnrollment(record.enrollment.id);
      } catch (e) {
        if (e instanceof IniciadorError && !e.transientRead) return this.finish(attemptId, record, { status: "failed", code: "charge_issuer_error", message: `the enrollment is unreadable: ${messageOf(e)}` });
        return { status: "uncertain", code: "enrollment_unreadable", message: messageOf(e) };
      }
      if (!seen.terminal) return this.awaitingEnrollment(record, seen.status);
      if (seen.status !== "COMPLETED") {
        // A link nobody opened in time, a passkey not registered within the window: nothing was asked of the bank's money.
        return this.finish(attemptId, record, { status: "failed", code: "charge_expired", message: `the enrollment ended ${seen.status}${seen.upstreamStatus ? ` (${seen.upstreamStatus})` : ""} before the passkey was registered` });
      }
      return this.requestPayment(attemptId, payment);
    }

    const paymentId = record.payment.id;
    if (!paymentId) {
      if (!record.payment.lost_at && this.clock().getTime() - new Date(record.payment.requested_at).getTime() < IN_FLIGHT_MS) return { status: "in_flight" };
      return { status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true, message: "a payment request went out and its answer was lost; it is NOT retried: check the payments at the bank" };
    }
    let seen: JsrPaymentView;
    try {
      seen = await this.api.getPayment(paymentId);
    } catch (e) {
      if (e instanceof IniciadorError && !e.transientRead) return { status: "uncertain", code: "payment_unreadable", needs_human: true, message: `${messageOf(e)}; the payment was requested and may have completed: check it at the bank` };
      return { status: "uncertain", code: "payment_unreadable", message: messageOf(e) };
    }
    if (!seen.terminal) return this.awaitingSignature(record, seen.upstreamStatus ?? seen.status);
    if (seen.status !== "COMPLETED") return this.finish(attemptId, record, paymentFailure(seen));
    const endToEndId = seen.endToEndId ?? record.payment.end_to_end_id ?? null;
    const settled: RailOutcome = {
      status: "settled",
      transaction_id: endToEndId ?? paymentId,
      receipt_id: paymentId,
      money_moved: !this.sandbox,
      sandbox: this.sandbox,
      raw: { enrollment_id: record.enrollment.id, payment_id: paymentId, end_to_end_id: endToEndId, status: seen.upstreamStatus ?? seen.status, completed_seen_at: this.clock().toISOString() },
    };
    this.store.setCursor(RECEIPT(paymentId), attemptId);
    return this.finish(attemptId, { ...record, payment: { ...record.payment, end_to_end_id: endToEndId } }, settled);
  }

  /** The local record of a completed pull. Not a CodeSpar receipt: no chain, no HMAC, no Ed25519 signature. */
  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    const attemptId = this.store.getCursor(RECEIPT(receiptId));
    const record = attemptId ? this.load(attemptId) : undefined;
    if (!attemptId || !record || record.final?.status !== "settled") return undefined;
    const raw = record.final.raw as { end_to_end_id?: string | null; completed_seen_at?: string };
    return {
      receipt_id: receiptId,
      kind: "charge",
      state: "paid",
      mandate: { id: record.mandate_id },
      payment: { amount_minor: record.amount_minor, payee: record.payee, attempt_id: attemptId, money_moved: !this.sandbox, sandbox: this.sandbox, at: raw.completed_seen_at ?? record.created_at },
      chain: null,
      receipt_sig: null,
      receipt_sig_ed25519: null,
      receipt_sig_kid: null,
      actor,
      raw: { rail: this.name, enrollment_id: record.enrollment?.id ?? null, payment_id: receiptId, end_to_end_id: raw.end_to_end_id ?? null },
    };
  }

  /** The one payment of this attempt. The marker is claimed in a write transaction before the request goes out. */
  private async requestPayment(attemptId: string, payment: RailPayment): Promise<RailOutcome> {
    const claimed = this.store.transaction(() => {
      const fresh = this.load(attemptId);
      if (!fresh || fresh.payment || fresh.final) return undefined;
      const marked: JsrRecord = { ...fresh, payment: { requested_at: this.clock().toISOString() } };
      this.save(attemptId, marked);
      return marked;
    });
    if (!claimed) {
      // Another reader claimed the payment while this one read the enrollment: it is theirs to make.
      const seen = await this.lookup(attemptId, payment);
      return seen && seen.status !== "in_flight" ? seen : { status: "uncertain", code: "pull_in_flight", message: "another reader's payment request is still on its way" };
    }
    const request: JsrPaymentRequest = {
      externalId: `${attemptId}-pull`,
      participantId: this.config.participantId,
      taxId: this.config.taxId,
      userName: this.config.userName,
      amount: claimed.amount_minor,
      creditor: this.config.creditor,
      description: payment.description ?? "CodeSpar topup-agent",
      agentReason: AGENT_REASON,
    };
    let created: JsrPaymentView;
    try {
      created = await this.api.createPayment(request);
    } catch (e) {
      if (e instanceof IniciadorError && !e.uncertain) return this.finish(attemptId, claimed, { status: "failed", code: "charge_issuer_error", message: `the payment was refused: ${messageOf(e)}` });
      this.save(attemptId, { ...claimed, payment: { ...claimed.payment!, lost_at: this.clock().toISOString() } });
      return { status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true, message: `the payment request got no clear answer (${messageOf(e)}); it is NOT retried: check the payments at the bank` };
    }
    const next: JsrRecord = { ...claimed, payment: { ...claimed.payment!, id: created.paymentId, url: created.url } };
    this.save(attemptId, next);
    return this.awaitingSignature(next, created.upstreamStatus ?? created.status);
  }

  private awaitingEnrollment(record: JsrRecord, status: string): Extract<RailOutcome, { status: "accepted" }> {
    return this.accepted(record.enrollment!.id, status, record.enrollment!.url, "enroll");
  }

  private awaitingSignature(record: JsrRecord, status: string): Extract<RailOutcome, { status: "accepted" }> {
    return this.accepted(record.payment!.id!, status, record.payment!.url ?? null, "sign");
  }

  private accepted(transactionId: string, status: string, url: string | null, step: "enroll" | "sign"): Extract<RailOutcome, { status: "accepted" }> {
    const instrument: ChargeInstrument = { payable: true, status, pix_copy_paste: null, boleto_bank_line: null, boleto_bar_code: null, due_date: null, consent_url: url, consent_step: step };
    return { status: "accepted", transaction_id: transactionId, instrument, sandbox: this.sandbox, raw: { step, status } };
  }

  private finish(attemptId: string, record: JsrRecord, outcome: RailOutcome): RailOutcome {
    this.save(attemptId, { ...record, final: outcome });
    return outcome;
  }

  private load(attemptId: string): JsrRecord | undefined {
    const raw = this.store.getCursor(RECORD(attemptId));
    return raw ? (JSON.parse(raw) as JsrRecord) : undefined;
  }

  private save(attemptId: string, record: JsrRecord): void {
    this.store.setCursor(RECORD(attemptId), JSON.stringify(record));
  }
}

function messageOf(e: unknown): string {
  return e instanceof IniciadorError ? e.message : "unexpected error reading the bank";
}

/** A terminal payment that did not complete, as the core's reasons read it. */
function paymentFailure(seen: JsrPaymentView): RailOutcome {
  const why = `${seen.status}${seen.upstreamStatus ? `/${seen.upstreamStatus}` : ""}${seen.errorCode ? ` (${seen.errorCode})` : ""}`;
  if (seen.status === "EXPIRED" || seen.errorCode === "TIMEOUT_CONSENTIMENTO") return { status: "failed", code: "charge_expired", message: `the payment was not signed in time: ${why}` };
  if (seen.status === "ERROR") return { status: "failed", code: "charge_issuer_error", message: `the bank ended the payment ${why}` };
  return { status: "failed", code: "charge_cancelled", message: `the payment ended ${why}` };
}

export type JsrFixtureFate = "signs" | "lets-expire";

/**
 * The offline Iniciador JSR: the same five calls, state in state.db, no
 * network. An enrollment completes at its first look (the person registered
 * the passkey); a payment completes at its first look, or ends REJECTED with
 * TIMEOUT_CONSENTIMENTO when the fate says the person never signed.
 */
export class FixtureJsrApi implements JsrApi {
  constructor(
    private readonly store: StateStore,
    private fate: JsrFixtureFate = "signs",
    private enrolled = false,
  ) {}

  setFate(fate: JsrFixtureFate): void {
    this.fate = fate;
  }

  async completedEnrollment(): Promise<EnrollmentView | null> {
    const id = this.store.getCursor("jsr-fixture:completed");
    if (id) return { authorizationId: id, status: "COMPLETED", upstreamStatus: "AUTHORISED", terminal: true, url: null };
    if (!this.enrolled) return null;
    this.store.setCursor("jsr-fixture:completed", "enr_fixture_prior");
    return this.completedEnrollment();
  }

  async createEnrollment(r: EnrollmentRequest): Promise<EnrollmentView> {
    const id = `enr_fixture_${sha256Hex(r.externalId).slice(0, 12)}`;
    this.store.setCursor(`jsr-fixture:enr:${id}`, "PENDING");
    return { authorizationId: id, status: "PENDING", upstreamStatus: "AWAITING_ACCOUNT_HOLDER_VALIDATION", terminal: false, url: `https://idp.invalid/authorize?request_uri=${encodeURIComponent(id)}` };
  }

  async getEnrollment(authorizationId: string): Promise<EnrollmentView> {
    if (!this.store.getCursor(`jsr-fixture:enr:${authorizationId}`)) throw new IniciadorError(404, "NOT_FOUND", "fixture: no such enrollment");
    this.store.setCursor(`jsr-fixture:enr:${authorizationId}`, "COMPLETED");
    this.store.setCursor("jsr-fixture:completed", authorizationId);
    return { authorizationId, status: "COMPLETED", upstreamStatus: "AUTHORISED", terminal: true, url: null };
  }

  async createPayment(r: JsrPaymentRequest): Promise<JsrPaymentView> {
    const enrollment = await this.completedEnrollment();
    if (!enrollment) throw new IniciadorError(422, "tool_error", "fixture: no COMPLETED enrollment");
    const id = `pay_fixture_${sha256Hex(r.externalId).slice(0, 12)}`;
    this.store.setCursor(`jsr-fixture:pay:${id}`, this.fate);
    return { paymentId: id, status: "PENDING", upstreamStatus: "CONSENT_AWAITING_AUTHORIZATION", terminal: false, url: `https://app.invalid/agentic/pay/${id}?token=fixture`, authorizationId: enrollment.authorizationId, endToEndId: null, errorCode: null };
  }

  async getPayment(paymentId: string): Promise<JsrPaymentView> {
    const fate = this.store.getCursor(`jsr-fixture:pay:${paymentId}`);
    if (!fate) throw new IniciadorError(404, "NOT_FOUND", "fixture: no such payment");
    const e2e = `E00000000${sha256Hex(paymentId).slice(0, 23).toUpperCase()}`;
    if (fate === "lets-expire") return { paymentId, status: "REJECTED", upstreamStatus: "CONSENT_REJECTED", terminal: true, url: null, authorizationId: null, endToEndId: e2e, errorCode: "TIMEOUT_CONSENTIMENTO" };
    return { paymentId, status: "COMPLETED", upstreamStatus: "PAYMENT_COMPLETED", terminal: true, url: null, authorizationId: null, endToEndId: e2e, errorCode: null };
  }
}
