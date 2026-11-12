/**
 * Module `sweeping-pull`: the rail that pulls money from the person's own bank
 * account into their own account, through Open Finance sweeping. In this kit
 * it runs against an offline simulation of the bank (`FixtureSweepingApi`);
 * a pull to a real bank goes through the CodeSpar API, not through a client
 * in this repository. The core sees it as a receivable: `pay()` creates the
 * bank authorization and answers `accepted` with the consent link as the
 * instrument; every later `lookup()` reads the authorization and, once the
 * person approved it at the bank, makes the ONE payment the approved execution
 * covers and reads it until it completes.
 *
 * One attempt, two calls, and only the first is made by `pay()`.
 * The second (the payment) is made by the look that first sees it approved, and
 * it is made at most once: a marker is written to state.db BEFORE the request
 * goes out, so a crash or a lost answer leaves a marker without a payment id,
 * which every later look reports as uncertain instead of paying again. A human
 * reconciles it at the bank; nothing here retries a payment blind.
 *
 * Nothing in this file decides money. The amount, the payee (the creditor id)
 * and the caps were checked by `ExecutionEngine` before `pay()` was called; the
 * rail refuses a payee that is not the configured creditor all the same.
 */
import { sha256Hex, type Actor, type ChargeInstrument, type PaymentRail, type RailLookup, type RailOutcome, type RailPayment, type RailReceipt, type StateStore } from "@codespar/agent-core";

/**
 * The simulation's own words for where an authorization stands. `waiting` until the person acts at the bank;
 * `approved` is the only terminal one that leads to a payment.
 */
export type AuthorizationStatus = "waiting" | "approved" | "rejected" | "expired" | "revoked" | "cancelled" | "error";
export const AUTHORIZATION_TERMINAL: ReadonlySet<string> = new Set<AuthorizationStatus>(["approved", "rejected", "expired", "revoked", "cancelled", "error"]);

/** Where a payment stands. `completed` is the only terminal one that settles. */
export type PaymentStatus = "pending" | "completed" | "rejected" | "expired" | "cancelled" | "error";
export const PAYMENT_TERMINAL: ReadonlySet<string> = new Set<PaymentStatus>(["completed", "rejected", "expired", "cancelled", "error"]);

/** What one authorization asks the bank for. The two limits are the mandate's caps (see `sweepingLimits`), so the bank and the core cannot disagree. */
export interface AuthorizationRequest {
  /** The attempt this authorization is for: a repeat under the same reference is the same authorization. */
  reference: string;
  /** The person's own account, the one place the money may go. */
  payee: string;
  totalLimitMinor: number;
  perPullLimitMinor: number;
}

export interface PaymentRequest {
  reference: string;
  payee: string;
  amountMinor: number;
  description: string;
}

export interface AuthorizationView {
  consentId: string;
  status: string;
  /** The page the person opens to approve; only while the bank waits. */
  consentUrl: string | null;
  /** Why the bank or the clock ended it, when it did. */
  reason: string | null;
}

export interface PaymentView {
  id: string;
  status: string;
  endToEndId: string | null;
}

/** The four calls the rail makes. The offline fixture implements them in memory; tests implement them too. */
export interface SweepingApi {
  createAuthorization(request: AuthorizationRequest): Promise<AuthorizationView>;
  getAuthorization(consentId: string): Promise<AuthorizationView>;
  createPayment(consentId: string, request: PaymentRequest): Promise<PaymentView>;
  getPaymentStatus(consentId: string, paymentId: string): Promise<PaymentView>;
}

/**
 * A call that did not succeed. `status` is the HTTP-like status, or 0 when no
 * answer came back: the request may or may not have landed.
 */
export class SweepingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SweepingApiError";
  }

  /**
   * No answer (0) or a 5xx: whether the call took effect is unknown. Every
   * 4xx is a certain refusal, 408 and 429 included: the server says it did
   * not process the request (a timeout waiting for it, a rate limit), so
   * nothing took effect.
   */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500;
  }

  /**
   * For a READ only: an answer the next look may not repeat. Besides the
   * uncertain ones, a 401, a 408 and a 429 say nothing about the
   * authorization or the payment, so a read that got one is looked at again.
   * `uncertain` stays the rule for a request that could have taken effect.
   */
  get transientRead(): boolean {
    return this.uncertain || this.status === 401 || this.status === 408 || this.status === 429;
  }
}

export interface SweepingLimits {
  /** The authorization's total limit and the mandate's `cap_minor`. */
  total_minor: number;
  /** The authorization's limit per pull and the mandate's `per_tx_cap_minor`. */
  per_tx_minor: number;
}

export const DEFAULT_LIMITS: SweepingLimits = { total_minor: 1000, per_tx_minor: 500 };

/**
 * The two limits, read once from the environment, for BOTH the bank
 * authorization and the mandate. One function so they cannot drift apart.
 */
export function sweepingLimits(env: NodeJS.ProcessEnv): SweepingLimits {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer in centavos, got ${raw}`);
    return n;
  };
  const limits = { total_minor: read("TOPUP_TOTAL_CENTS", DEFAULT_LIMITS.total_minor), per_tx_minor: read("TOPUP_TX_LIMIT_CENTS", DEFAULT_LIMITS.per_tx_minor) };
  if (limits.per_tx_minor > limits.total_minor) throw new Error("TOPUP_TX_LIMIT_CENTS cannot exceed TOPUP_TOTAL_CENTS");
  return limits;
}

export interface SweepingRailConfig {
  /** The person's own account: the one payee the rail sends a pull to. */
  payee: string;
  limits: SweepingLimits;
  clock?: () => Date;
}

/** What the rail remembers per attempt, in state.db. Ids and statuses only: the bank's link carries a credential and is not kept. */
interface PullRecord {
  /** Null while the authorization request has gone out and no answer came back with an id. */
  authorization_id: string | null;
  /**
   * Every authorization request made for this attempt, written BEFORE it goes out. An unanswered one is
   * made again under the same reference by a later look: an authorization moves no money, and the link
   * of one nobody saw expires on its own.
   */
  authorization_requests?: Array<{ at: string; answered: "id" | "refused" | "no_answer" | null }>;
  amount_minor: number;
  payee: string;
  mandate_id: string;
  created_at: string;
  /** Written BEFORE the payment request goes out; `id` once it answered; `lost_at` when it got no clear answer. */
  payment?: { requested_at: string; id?: string; end_to_end_id?: string | null; lost_at?: string };
  final?: RailOutcome;
}

const RECORD = (attemptId: string) => `sweeping:${attemptId}`;
/**
 * How long a marker with no payment id is read as another reader's request
 * still waiting for its answer (the client times out at 15 s) before it is
 * read as an answer that will not come.
 */
const IN_FLIGHT_MS = 60_000;
const RECEIPT = (paymentId: string) => `sweeping-receipt:${paymentId}`;

export class SweepingPullRail implements PaymentRail {
  readonly name = "simulated-pull" as const;
  private readonly clock: () => Date;
  /**
   * The bank's consent links this process was handed, by attempt. Memory only: each carries its credential
   * After a restart the link comes back from `getAuthorization` while the bank waits.
   */
  private readonly authLinks = new Map<string, string>();

  constructor(
    private readonly store: StateStore,
    private readonly api: SweepingApi,
    private readonly config: SweepingRailConfig,
    private readonly sandbox: boolean,
  ) {
    this.clock = config.clock ?? (() => new Date());
  }

  async pay(payment: RailPayment): Promise<RailOutcome> {
    const existing = this.load(payment.attempt_id);
    if (existing?.final) return existing.final;
    if (existing && !existing.authorization_id) {
      const seen = await this.lookup(payment.attempt_id, payment);
      return seen && seen.status !== "in_flight" ? seen : { status: "uncertain", code: "authorization_unconfirmed", message: "an authorization request for this attempt is still on its way" };
    }
    if (existing) return this.awaiting(payment.attempt_id, existing, existing.payment ? "pending" : "waiting");
    if (payment.payee !== this.config.payee) {
      return { status: "failed", code: "creditor_mismatch", message: "the payee is not the creditor this agent is configured for; nothing was sent" };
    }
    if (payment.amount_minor > this.config.limits.per_tx_minor) {
      return { status: "failed", code: "above_transaction_limit", message: `amount above the authorization's transaction limit (${this.config.limits.per_tx_minor}); nothing was sent` };
    }
    const pending: PullRecord = {
      authorization_id: null,
      amount_minor: payment.amount_minor,
      payee: payment.payee,
      mandate_id: payment.mandate_id,
      created_at: this.clock().toISOString(),
      authorization_requests: [{ at: this.clock().toISOString(), answered: null }],
    };
    this.save(payment.attempt_id, pending);
    return this.requestAuthorization(payment.attempt_id, pending);
  }

  /**
   * The authorization request whose entry is the last of `record.authorization_requests`, already on
   * disk with `answered: null` before this is called; what came back is written after.
   */
  private async requestAuthorization(attemptId: string, record: PullRecord): Promise<RailOutcome> {
    const requests = record.authorization_requests ?? [];
    const answered = (answer: "id" | "refused" | "no_answer") => requests.map((r, i) => (i === requests.length - 1 ? { ...r, answered: answer } : r));
    const request: AuthorizationRequest = {
      reference: attemptId,
      payee: this.config.payee,
      totalLimitMinor: this.config.limits.total_minor,
      perPullLimitMinor: this.config.limits.per_tx_minor,
    };
    let auth: AuthorizationView;
    try {
      auth = await this.api.createAuthorization(request);
    } catch (e) {
      const outcome = failure(e, "authorization");
      const kept = { ...record, authorization_requests: answered(outcome.status === "failed" ? "refused" : "no_answer") };
      if (outcome.status === "failed") return this.finish(attemptId, kept, outcome);
      this.save(attemptId, kept);
      return outcome;
    }
    const issued: PullRecord = { ...record, authorization_id: auth.consentId, authorization_requests: answered("id") };
    if (auth.consentUrl) this.authLinks.set(attemptId, auth.consentUrl);
    this.save(attemptId, issued);
    return this.awaiting(attemptId, issued, auth.status);
  }

  async lookup(attemptId: string, payment: RailPayment): Promise<RailLookup> {
    const record = this.load(attemptId);
    if (!record) return undefined;
    if (record.final) return record.final;

    if (!record.authorization_id) {
      // The authorization request got no answer with an id. A request still on its way (another reader's) is waited for;
      // otherwise it is made again under the same reference, claimed in one write transaction so two readers make one.
      const claimed = this.store.transaction(() => {
        const fresh = this.load(attemptId);
        if (!fresh || fresh.authorization_id || fresh.final) return undefined;
        const last = fresh.authorization_requests?.at(-1);
        if (last && last.answered === null && this.clock().getTime() - new Date(last.at).getTime() < IN_FLIGHT_MS) return undefined;
        const next: PullRecord = { ...fresh, authorization_requests: [...(fresh.authorization_requests ?? []), { at: this.clock().toISOString(), answered: null }] };
        this.save(attemptId, next);
        return next;
      });
      if (!claimed) {
        const now = this.load(attemptId);
        return now?.authorization_id || now?.final ? this.lookup(attemptId, payment) : { status: "in_flight" };
      }
      return this.requestAuthorization(attemptId, claimed);
    }

    if (!record.payment) {
      let auth: AuthorizationView;
      try {
        auth = await this.api.getAuthorization(record.authorization_id);
      } catch (e) {
        // A clear refusal (404, 403) will not change on the next look, and no payment was asked for yet: the attempt failed.
        // A 401, 408 or 429 says nothing about the authorization: looked at again, never final.
        if (e instanceof SweepingApiError && !e.transientRead) return this.finish(attemptId, record, { status: "failed", code: "authorization_unreadable", message: messageOf(e) });
        return { status: "uncertain", code: "authorization_unreadable", message: messageOf(e) };
      }
      // While it waits, the bank answers the link again with the status: that copy wins over this process's.
      if (auth.consentUrl) this.authLinks.set(attemptId, auth.consentUrl);
      if (!AUTHORIZATION_TERMINAL.has(auth.status)) return this.awaiting(attemptId, record, auth.status);
      if (auth.status !== "approved") return this.finish(attemptId, record, authorizationFailure(auth));
      // The person approved at the bank. The marker goes to disk before the request does, claimed inside
      // one write transaction on the record as it is NOW: another reader (the run's poll, `npm run poll`,
      // a webhook) may have claimed it while this one waited for the bank, and then this one sends nothing.
      const claimed = this.store.transaction(() => {
        const fresh = this.load(attemptId);
        if (!fresh || fresh.payment || fresh.final) return undefined;
        const marked: PullRecord = { ...fresh, payment: { requested_at: this.clock().toISOString() } };
        this.save(attemptId, marked);
        return marked;
      });
      if (!claimed) return this.lookup(attemptId, payment);
      record.payment = claimed.payment!;
      const request: PaymentRequest = {
        reference: `${attemptId}-pull`,
        payee: this.config.payee,
        amountMinor: record.amount_minor,
        description: payment.description ?? "CodeSpar topup-agent",
      };
      let created: PaymentView;
      try {
        created = await this.api.createPayment(record.authorization_id, request);
      } catch (e) {
        if (e instanceof SweepingApiError && !e.uncertain) return this.finish(attemptId, record, { status: "failed", code: "charge_issuer_error", message: messageOf(e) });
        this.save(attemptId, { ...record, payment: { ...record.payment, lost_at: this.clock().toISOString() } });
        return { status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true, message: `the payment request got no clear answer (${messageOf(e)}); it is NOT retried: check the authorization at the bank` };
      }
      record.payment = { ...record.payment, id: created.id, end_to_end_id: created.endToEndId };
      this.save(attemptId, record);
    }

    const paymentId = record.payment.id;
    if (!paymentId) {
      // Another reader's request, recent and unanswered: still on its way, looked at again.
      if (!record.payment.lost_at && this.clock().getTime() - new Date(record.payment.requested_at).getTime() < IN_FLIGHT_MS) return { status: "in_flight" };
      return { status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true, message: "a payment request went out and its answer was lost; it is NOT retried: check the authorization at the bank" };
    }
    let seen: PaymentView;
    try {
      seen = await this.api.getPaymentStatus(record.authorization_id, paymentId);
    } catch (e) {
      // A clear refusal (403, 404) will not change on the next look, but the payment was asked for and may have moved money: a human checks, it is not called failed.
      // A 401, 408 or 429 is looked at again.
      if (e instanceof SweepingApiError && !e.transientRead) return { status: "uncertain", code: "payment_unreadable", needs_human: true, message: `${messageOf(e)}; the payment was requested and may have completed: check the authorization at the bank` };
      return { status: "uncertain", code: "payment_unreadable", message: messageOf(e) };
    }
    const endToEndId = seen.endToEndId ?? record.payment.end_to_end_id ?? null;
    if (!PAYMENT_TERMINAL.has(seen.status)) return this.awaiting(attemptId, record, seen.status);
    if (seen.status !== "completed") return this.finish(attemptId, record, { status: "failed", code: "charge_issuer_error", message: `the bank ended the pull ${seen.status}` });
    const settled: RailOutcome = {
      status: "settled",
      // The Pix end-to-end id is what the person and their bank can look up; the payment id is the bank side's.
      transaction_id: endToEndId ?? paymentId,
      receipt_id: paymentId,
      money_moved: !this.sandbox,
      sandbox: this.sandbox,
      raw: { authorization_id: record.authorization_id, payment_id: paymentId, end_to_end_id: endToEndId, status: seen.status, completed_seen_at: this.clock().toISOString() },
    };
    this.store.setCursor(RECEIPT(paymentId), attemptId);
    return this.finish(attemptId, { ...record, payment: { ...record.payment, end_to_end_id: endToEndId } }, settled);
  }

  /**
   * The local record of a completed pull. Not a CodeSpar receipt: no chain, no
   * HMAC, no Ed25519 signature. What a third party can check about this pull
   * is the Pix end-to-end id, at the banks, and nothing here.
   */
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
      raw: { rail: this.name, authorization_id: record.authorization_id, payment_id: receiptId, end_to_end_id: raw.end_to_end_id ?? null },
    };
  }

  private awaiting(attemptId: string, record: PullRecord, status: string): Extract<RailOutcome, { status: "accepted" }> {
    if (!record.authorization_id) throw new Error("awaiting() is only reached once the bank answered with an authorization id");
    const instrument: ChargeInstrument = {
      payable: true,
      status,
      pix_copy_paste: null,
      boleto_bank_line: null,
      boleto_bar_code: null,
      due_date: null,
      // Only while the bank is waiting for the person; once a payment exists there is nothing left to open.
      consent_url: record.payment ? null : (this.authLinks.get(attemptId) ?? null),
    };
    return { status: "accepted", transaction_id: record.authorization_id, instrument, sandbox: this.sandbox, raw: { authorization_id: record.authorization_id, status } };
  }

  private finish(attemptId: string, record: PullRecord, outcome: RailOutcome): RailOutcome {
    this.save(attemptId, { ...record, final: outcome });
    return outcome;
  }

  private load(attemptId: string): PullRecord | undefined {
    const raw = this.store.getCursor(RECORD(attemptId));
    return raw ? (JSON.parse(raw) as PullRecord) : undefined;
  }

  private save(attemptId: string, record: PullRecord): void {
    // A record written before the link left state.db carries `auth_url`: dropped at its next write.
    const { auth_url: _legacy, ...kept } = record as PullRecord & { auth_url?: unknown };
    this.store.setCursor(RECORD(attemptId), JSON.stringify(kept));
  }
}

function fixtureConsentUrl(consentId: string): string {
  return `https://banco-de-testes.invalid/consent/${encodeURIComponent(consentId)}`;
}

function messageOf(e: unknown): string {
  return e instanceof SweepingApiError ? e.message : "unexpected error reading the bank";
}

function failure(e: unknown, what: string): RailOutcome {
  if (e instanceof SweepingApiError && !e.uncertain) return { status: "failed", code: "charge_issuer_error", message: `the ${what} was refused: ${e.message}` };
  return { status: "uncertain", code: "authorization_unconfirmed", message: `the ${what} got no clear answer: ${messageOf(e)}` };
}

/** A terminal authorization that is not approved, as the core's reasons read it. */
function authorizationFailure(auth: AuthorizationView): RailOutcome {
  if (auth.status === "expired") return { status: "failed", code: "charge_expired", message: `the consent link was not approved in time (${auth.reason ?? auth.status})` };
  if (auth.status === "error") return { status: "failed", code: "charge_issuer_error", message: "the bank ended the authorization in error" };
  return { status: "failed", code: "charge_cancelled", message: `the authorization ended ${auth.status}${auth.reason ? ` (${auth.reason})` : ""}` };
}

export type FixtureFate = "approves" | "expires" | "rejects" | "never";

interface FixtureAuth {
  status: AuthorizationStatus;
  looks: number;
  fate: FixtureFate;
  reason: string | null;
}

/**
 * The offline bank: the same four calls, state in state.db, no network.
 * The person's decision at the bank is the fate: approve at the first look
 * (default), let the link expire, reject it, or never act. A payment completes
 * at its first read.
 */
export class FixtureSweepingApi implements SweepingApi {
  constructor(
    private readonly store: StateStore,
    private fate: FixtureFate = "approves",
  ) {}

  setFate(fate: FixtureFate): void {
    this.fate = fate;
  }

  /** The person acts on ONE authorization (the scenario payer, a test). */
  decide(consentId: string, fate: FixtureFate): void {
    const auth = this.auth(consentId);
    if (auth) this.saveAuth(consentId, { ...auth, fate });
  }

  async createAuthorization(r: AuthorizationRequest): Promise<AuthorizationView> {
    const id = `consent_fixture_${sha256Hex(r.reference).slice(0, 16)}`;
    if (!this.auth(id)) this.saveAuth(id, { status: "waiting", looks: 0, fate: this.fate, reason: null });
    return { consentId: id, status: "waiting", consentUrl: fixtureConsentUrl(id), reason: null };
  }

  async getAuthorization(consentId: string): Promise<AuthorizationView> {
    const auth = this.auth(consentId);
    if (!auth) throw new SweepingApiError(404, "not_found", "fixture: no such authorization");
    let next: FixtureAuth = { ...auth, looks: auth.looks + 1 };
    if (auth.status === "waiting") {
      if (auth.fate === "approves") next = { ...next, status: "approved" };
      else if (auth.fate === "expires") next = { ...next, status: "expired", reason: "not_approved_in_time" };
      else if (auth.fate === "rejects") next = { ...next, status: "rejected", reason: "declined_by_person" };
    }
    this.saveAuth(consentId, next);
    // The link comes back with the status while the bank waits for the person.
    return { consentId, status: next.status, consentUrl: next.status === "waiting" ? fixtureConsentUrl(consentId) : null, reason: next.reason };
  }

  async createPayment(consentId: string, r: PaymentRequest): Promise<PaymentView> {
    const auth = this.auth(consentId);
    if (auth?.status !== "approved") throw new SweepingApiError(422, "not_approved", "fixture: the authorization is not approved");
    const id = `pay_fixture_${sha256Hex(r.reference).slice(0, 12)}`;
    const e2e = `E00000000${sha256Hex(id).slice(0, 23).toUpperCase()}`;
    this.store.setCursor(`sweeping-fixture:pay:${id}`, JSON.stringify({ status: "pending", endToEndId: e2e }));
    return { id, status: "pending", endToEndId: e2e };
  }

  async getPaymentStatus(_consentId: string, paymentId: string): Promise<PaymentView> {
    const raw = this.store.getCursor(`sweeping-fixture:pay:${paymentId}`);
    if (!raw) throw new SweepingApiError(404, "not_found", "fixture: no such payment");
    const p = JSON.parse(raw) as { endToEndId: string };
    const completed = { status: "completed", endToEndId: p.endToEndId };
    this.store.setCursor(`sweeping-fixture:pay:${paymentId}`, JSON.stringify(completed));
    return { id: paymentId, ...completed };
  }

  private auth(id: string): FixtureAuth | undefined {
    const raw = this.store.getCursor(`sweeping-fixture:auth:${id}`);
    return raw ? (JSON.parse(raw) as FixtureAuth) : undefined;
  }

  private saveAuth(id: string, auth: FixtureAuth): void {
    this.store.setCursor(`sweeping-fixture:auth:${id}`, JSON.stringify(auth));
  }
}
